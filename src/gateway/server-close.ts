import type { Server as HttpServer } from "node:http";
import type { WebSocketServer } from "ws";
import type { CanvasHostHandler, CanvasHostServer } from "../canvas-host/server.js";
import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
import { stopGmailWatcher } from "../hooks/gmail-watcher.js";
import type { HeartbeatRunner } from "../infra/heartbeat-runner.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

const shutdownLog = createSubsystemLogger("gateway/shutdown");
const WEBSOCKET_CLOSE_GRACE_MS = 1_000;
const WEBSOCKET_CLOSE_FORCE_CONTINUE_MS = 250;
const HTTP_CLOSE_GRACE_MS = 1_000;
const HTTP_CLOSE_FORCE_WAIT_MS = 5_000;

export type ShutdownResult = {
  durationMs: number;
  warnings: string[];
};

/**
 * A timeout that participates in a Promise.race and can be cancelled by the
 * winner. Both halves matter: the timer is unref'd so a pending timeout never
 * holds the event loop open, and `clear()` releases the handle as soon as the
 * race is decided so a fired or losing timer is not left dangling.
 */
function createTimeoutRace<T>(timeoutMs: number, onTimeout: () => T) {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  timer = setTimeout(() => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    resolve(onTimeout());
  }, timeoutMs);
  timer.unref?.();

  return {
    promise,
    clear() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

function recordShutdownWarning(warnings: string[], name: string): void {
  if (!warnings.includes(name)) {
    warnings.push(name);
  }
}

/**
 * Run one shutdown step. Failures never abort shutdown, but unlike a bare
 * `catch {}` they are logged and surfaced in the returned ShutdownResult.
 */
async function shutdownStep(
  name: string,
  fn: () => Promise<void> | void,
  warnings: string[],
): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    shutdownLog.warn(`${name}: ${detail}`);
    recordShutdownWarning(warnings, name);
    return false;
  }
}

export function createGatewayCloseHandler(params: {
  bonjourStop: (() => Promise<void>) | null;
  tailscaleCleanup: (() => Promise<void>) | null;
  canvasHost: CanvasHostHandler | null;
  canvasHostServer: CanvasHostServer | null;
  releasePluginRouteRegistry?: (() => void) | null;
  stopChannel: (name: ChannelId, accountId?: string) => Promise<void>;
  pluginServices: PluginServicesHandle | null;
  cron: { stop: () => void };
  heartbeatRunner: HeartbeatRunner;
  updateCheckStop?: (() => void) | null;
  stopTaskRegistryMaintenance?: (() => void) | null;
  nodePresenceTimers: Map<string, ReturnType<typeof setInterval>>;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  tickInterval: ReturnType<typeof setInterval>;
  healthInterval: ReturnType<typeof setInterval>;
  dedupeCleanup: ReturnType<typeof setInterval>;
  mediaCleanup: ReturnType<typeof setInterval> | null;
  agentUnsub: (() => void) | null;
  heartbeatUnsub: (() => void) | null;
  transcriptUnsub: (() => void) | null;
  lifecycleUnsub: (() => void) | null;
  chatRunState: { clear: () => void };
  clients: Set<{ socket: { close: (code: number, reason: string) => void } }>;
  configReloader: { stop: () => Promise<void> };
  wss: WebSocketServer;
  httpServer: HttpServer;
  httpServers?: HttpServer[];
}) {
  return async (opts?: {
    reason?: string;
    restartExpectedMs?: number | null;
  }): Promise<ShutdownResult> => {
    const start = Date.now();
    const warnings: string[] = [];
    try {
      const reasonRaw = normalizeOptionalString(opts?.reason) ?? "";
      const reason = reasonRaw || "gateway stopping";
      const restartExpectedMs =
        typeof opts?.restartExpectedMs === "number" && Number.isFinite(opts.restartExpectedMs)
          ? Math.max(0, Math.floor(opts.restartExpectedMs))
          : null;
      shutdownLog.info(`shutdown started: ${reason}`);
      if (params.bonjourStop) {
        await shutdownStep("bonjour", () => params.bonjourStop!(), warnings);
      }
      if (params.tailscaleCleanup) {
        await shutdownStep("tailscale", () => params.tailscaleCleanup!(), warnings);
      }
      if (params.canvasHost) {
        await shutdownStep("canvas-host", () => params.canvasHost!.close(), warnings);
      }
      if (params.canvasHostServer) {
        await shutdownStep("canvas-host-server", () => params.canvasHostServer!.close(), warnings);
      }
      for (const plugin of listChannelPlugins()) {
        await shutdownStep(`channel/${plugin.id}`, () => params.stopChannel(plugin.id), warnings);
      }
      if (params.pluginServices) {
        await shutdownStep("plugin-services", () => params.pluginServices!.stop(), warnings);
      }
      await shutdownStep("gmail-watcher", () => stopGmailWatcher(), warnings);
      params.cron.stop();
      params.heartbeatRunner.stop();
      await shutdownStep(
        "task-registry-maintenance",
        () => params.stopTaskRegistryMaintenance?.(),
        warnings,
      );
      await shutdownStep("update-check", () => params.updateCheckStop?.(), warnings);
      for (const timer of params.nodePresenceTimers.values()) {
        clearInterval(timer);
      }
      params.nodePresenceTimers.clear();
      params.broadcast("shutdown", {
        reason,
        restartExpectedMs,
      });
      clearInterval(params.tickInterval);
      clearInterval(params.healthInterval);
      clearInterval(params.dedupeCleanup);
      if (params.mediaCleanup) {
        clearInterval(params.mediaCleanup);
      }
      if (params.agentUnsub) {
        await shutdownStep("agent-unsub", () => params.agentUnsub!(), warnings);
      }
      if (params.heartbeatUnsub) {
        await shutdownStep("heartbeat-unsub", () => params.heartbeatUnsub!(), warnings);
      }
      if (params.transcriptUnsub) {
        await shutdownStep("transcript-unsub", () => params.transcriptUnsub!(), warnings);
      }
      if (params.lifecycleUnsub) {
        await shutdownStep("lifecycle-unsub", () => params.lifecycleUnsub!(), warnings);
      }
      params.chatRunState.clear();
      let clientCloseFailures = 0;
      for (const c of params.clients) {
        try {
          c.socket.close(1012, "service restart");
        } catch {
          clientCloseFailures++;
        }
      }
      if (clientCloseFailures > 0) {
        shutdownLog.warn(`failed to close ${clientCloseFailures} WebSocket client(s)`);
        recordShutdownWarning(warnings, "ws-clients");
      }
      params.clients.clear();
      await shutdownStep("config-reloader", () => params.configReloader.stop(), warnings);
      const wsClients = params.wss.clients ?? new Set();
      const closePromise = new Promise<void>((resolve) => params.wss.close(() => resolve()));
      const websocketGraceTimeout = createTimeoutRace(
        WEBSOCKET_CLOSE_GRACE_MS,
        () => false as const,
      );
      let closedWithinGrace: boolean;
      try {
        closedWithinGrace = await Promise.race([
          closePromise.then(() => true),
          websocketGraceTimeout.promise,
        ]);
      } finally {
        // finally, not a trailing call: a throwing wss.close() would otherwise
        // leave the timer live until it fires on its own.
        websocketGraceTimeout.clear();
      }
      if (!closedWithinGrace) {
        shutdownLog.warn(
          `websocket server close exceeded ${WEBSOCKET_CLOSE_GRACE_MS}ms; forcing shutdown continuation with ${wsClients.size} tracked client(s)`,
        );
        recordShutdownWarning(warnings, "websocket-server");
        for (const client of wsClients) {
          try {
            client.terminate();
          } catch {
            /* ignore */
          }
        }
        const websocketForceTimeout = createTimeoutRace(WEBSOCKET_CLOSE_FORCE_CONTINUE_MS, () => {
          shutdownLog.warn(
            `websocket server close still pending after ${WEBSOCKET_CLOSE_FORCE_CONTINUE_MS}ms force window; continuing shutdown`,
          );
        });
        try {
          await Promise.race([closePromise, websocketForceTimeout.promise]);
        } finally {
          websocketForceTimeout.clear();
        }
      }
      const servers =
        params.httpServers && params.httpServers.length > 0
          ? params.httpServers
          : [params.httpServer];
      // A server that refuses to close must not stop the others from closing:
      // a still-bound listener survives an in-process restart and then fights
      // the new instance for the port. Record the first failure, close the
      // rest, and rethrow at the end.
      let httpCloseFailure: unknown;
      for (let i = 0; i < servers.length; i++) {
        const httpServer = servers[i] as HttpServer & {
          closeAllConnections?: () => void;
          closeIdleConnections?: () => void;
        };
        const label = servers.length > 1 ? `http-server[${i}]` : "http-server";
        // Idle sockets first: server.close() stops accepting but waits for every
        // live connection to end, so an idle keep-alive socket alone can hang
        // shutdown forever.
        if (typeof httpServer.closeIdleConnections === "function") {
          httpServer.closeIdleConnections();
        }
        const httpClosePromise = new Promise<void>((resolve, reject) =>
          httpServer.close((err) => (err ? reject(err) : resolve())),
        );
        // The promise is raced twice below; attach a sink so a rejection that
        // loses a race is not an unhandled rejection.
        void httpClosePromise.catch(() => undefined);
        const httpGraceTimeout = createTimeoutRace(HTTP_CLOSE_GRACE_MS, () => false as const);
        const closedWithinHttpGrace = await Promise.race([
          httpClosePromise.then(() => true),
          httpGraceTimeout.promise,
        ]).catch((err: unknown) => {
          const detail = err instanceof Error ? err.message : String(err);
          shutdownLog.warn(`${label}: ${detail}`);
          recordShutdownWarning(warnings, label);
          // Reported, but not swallowed: this used to reject out of close(),
          // and it still does after every server has had its turn.
          httpCloseFailure ??= err;
          return true;
        });
        httpGraceTimeout.clear();
        if (!closedWithinHttpGrace) {
          // In-flight requests got the full grace window; past it, destroy the
          // remaining sockets so an unattended gateway cannot wedge on shutdown.
          shutdownLog.warn(
            `${label} close exceeded ${HTTP_CLOSE_GRACE_MS}ms; forcing connection shutdown and waiting for close`,
          );
          recordShutdownWarning(warnings, label);
          httpServer.closeAllConnections?.();
          const httpForceTimeout = createTimeoutRace(
            HTTP_CLOSE_FORCE_WAIT_MS,
            () => false as const,
          );
          const closedAfterForce = await Promise.race([
            httpClosePromise.then(() => true),
            httpForceTimeout.promise,
          ]).catch((err: unknown) => {
            const detail = err instanceof Error ? err.message : String(err);
            shutdownLog.warn(`${label}: ${detail}`);
            recordShutdownWarning(warnings, label);
            httpCloseFailure ??= err;
            return true;
          });
          httpForceTimeout.clear();
          if (!closedAfterForce) {
            httpCloseFailure ??= new Error(
              `${label} close still pending after forced connection shutdown (${HTTP_CLOSE_FORCE_WAIT_MS}ms)`,
            );
          }
        }
      }
      if (httpCloseFailure !== undefined) {
        throw httpCloseFailure;
      }
    } finally {
      try {
        params.releasePluginRouteRegistry?.();
      } catch {
        /* ignore */
      }
    }

    const durationMs = Date.now() - start;
    if (warnings.length > 0) {
      shutdownLog.warn(
        `shutdown completed in ${durationMs}ms with warnings: ${warnings.join(", ")}`,
      );
    } else {
      shutdownLog.info(`shutdown completed cleanly in ${durationMs}ms`);
    }

    return { durationMs, warnings };
  };
}
