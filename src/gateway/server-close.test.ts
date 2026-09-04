import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = {
  logWarn: vi.fn(),
  logInfo: vi.fn(),
};
const WEBSOCKET_CLOSE_GRACE_MS = 1_000;
const WEBSOCKET_CLOSE_FORCE_CONTINUE_MS = 250;
const HTTP_CLOSE_GRACE_MS = 1_000;
const HTTP_CLOSE_FORCE_WAIT_MS = 5_000;

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: () => [],
}));

vi.mock("../hooks/gmail-watcher.js", () => ({
  stopGmailWatcher: vi.fn(async () => undefined),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    warn: mocks.logWarn,
    info: mocks.logInfo,
  })),
}));

const { createGatewayCloseHandler } = await import("./server-close.js");

function makeParams(overrides: Record<string, unknown>) {
  return {
    bonjourStop: null,
    tailscaleCleanup: null,
    canvasHost: null,
    canvasHostServer: null,
    stopChannel: vi.fn(async () => undefined),
    pluginServices: null,
    cron: { stop: vi.fn() },
    heartbeatRunner: { stop: vi.fn() } as never,
    updateCheckStop: null,
    stopTaskRegistryMaintenance: null,
    nodePresenceTimers: new Map(),
    broadcast: vi.fn(),
    tickInterval: setInterval(() => undefined, 60_000),
    healthInterval: setInterval(() => undefined, 60_000),
    dedupeCleanup: setInterval(() => undefined, 60_000),
    mediaCleanup: null,
    agentUnsub: null,
    heartbeatUnsub: null,
    transcriptUnsub: null,
    lifecycleUnsub: null,
    chatRunState: { clear: vi.fn() },
    clients: new Set(),
    configReloader: { stop: vi.fn(async () => undefined) },
    wss: { close: (cb: () => void) => cb() } as never,
    httpServer: {
      close: (cb: (err?: Error | null) => void) => cb(null),
      closeIdleConnections: vi.fn(),
    } as never,
    ...overrides,
  } as Parameters<typeof createGatewayCloseHandler>[0];
}

describe("createGatewayCloseHandler", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.logWarn.mockClear();
    mocks.logInfo.mockClear();
  });

  it("unsubscribes lifecycle listeners during shutdown", async () => {
    const lifecycleUnsub = vi.fn();
    const stopTaskRegistryMaintenance = vi.fn();
    const close = createGatewayCloseHandler({
      bonjourStop: null,
      tailscaleCleanup: null,
      canvasHost: null,
      canvasHostServer: null,
      stopChannel: vi.fn(async () => undefined),
      pluginServices: null,
      cron: { stop: vi.fn() },
      heartbeatRunner: { stop: vi.fn() } as never,
      updateCheckStop: null,
      stopTaskRegistryMaintenance,
      nodePresenceTimers: new Map(),
      broadcast: vi.fn(),
      tickInterval: setInterval(() => undefined, 60_000),
      healthInterval: setInterval(() => undefined, 60_000),
      dedupeCleanup: setInterval(() => undefined, 60_000),
      mediaCleanup: null,
      agentUnsub: null,
      heartbeatUnsub: null,
      transcriptUnsub: null,
      lifecycleUnsub,
      chatRunState: { clear: vi.fn() },
      clients: new Set(),
      configReloader: { stop: vi.fn(async () => undefined) },
      wss: { close: (cb: () => void) => cb() } as never,
      httpServer: {
        close: (cb: (err?: Error | null) => void) => cb(null),
        closeIdleConnections: vi.fn(),
      } as never,
    });

    await close({ reason: "test shutdown" });

    expect(lifecycleUnsub).toHaveBeenCalledTimes(1);
    expect(stopTaskRegistryMaintenance).toHaveBeenCalledTimes(1);
  });

  it("terminates lingering websocket clients when websocket close exceeds the grace window", async () => {
    vi.useFakeTimers();

    let closeCallback: (() => void) | null = null;
    const terminate = vi.fn(() => {
      closeCallback?.();
    });
    const close = createGatewayCloseHandler({
      bonjourStop: null,
      tailscaleCleanup: null,
      canvasHost: null,
      canvasHostServer: null,
      stopChannel: vi.fn(async () => undefined),
      pluginServices: null,
      cron: { stop: vi.fn() },
      heartbeatRunner: { stop: vi.fn() } as never,
      updateCheckStop: null,
      stopTaskRegistryMaintenance: null,
      nodePresenceTimers: new Map(),
      broadcast: vi.fn(),
      tickInterval: setInterval(() => undefined, 60_000),
      healthInterval: setInterval(() => undefined, 60_000),
      dedupeCleanup: setInterval(() => undefined, 60_000),
      mediaCleanup: null,
      agentUnsub: null,
      heartbeatUnsub: null,
      transcriptUnsub: null,
      lifecycleUnsub: null,
      chatRunState: { clear: vi.fn() },
      clients: new Set(),
      configReloader: { stop: vi.fn(async () => undefined) },
      wss: {
        clients: new Set([{ terminate }]),
        close: (cb: () => void) => {
          closeCallback = cb;
        },
      } as never,
      httpServer: {
        close: (cb: (err?: Error | null) => void) => cb(null),
        closeIdleConnections: vi.fn(),
      } as never,
    });

    const closePromise = close({ reason: "test shutdown" });
    await vi.advanceTimersByTimeAsync(WEBSOCKET_CLOSE_GRACE_MS);
    await closePromise;

    expect(terminate).toHaveBeenCalledTimes(1);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("websocket server close exceeded 1000ms"),
      ),
    ).toBe(true);
  });

  it("continues shutdown when websocket close hangs without tracked clients", async () => {
    vi.useFakeTimers();

    const close = createGatewayCloseHandler({
      bonjourStop: null,
      tailscaleCleanup: null,
      canvasHost: null,
      canvasHostServer: null,
      stopChannel: vi.fn(async () => undefined),
      pluginServices: null,
      cron: { stop: vi.fn() },
      heartbeatRunner: { stop: vi.fn() } as never,
      updateCheckStop: null,
      stopTaskRegistryMaintenance: null,
      nodePresenceTimers: new Map(),
      broadcast: vi.fn(),
      tickInterval: setInterval(() => undefined, 60_000),
      healthInterval: setInterval(() => undefined, 60_000),
      dedupeCleanup: setInterval(() => undefined, 60_000),
      mediaCleanup: null,
      agentUnsub: null,
      heartbeatUnsub: null,
      transcriptUnsub: null,
      lifecycleUnsub: null,
      chatRunState: { clear: vi.fn() },
      clients: new Set(),
      configReloader: { stop: vi.fn(async () => undefined) },
      wss: {
        clients: new Set(),
        close: () => undefined,
      } as never,
      httpServer: {
        close: (cb: (err?: Error | null) => void) => cb(null),
        closeIdleConnections: vi.fn(),
      } as never,
    });

    const closePromise = close({ reason: "test shutdown" });
    await vi.advanceTimersByTimeAsync(WEBSOCKET_CLOSE_GRACE_MS + WEBSOCKET_CLOSE_FORCE_CONTINUE_MS);
    await closePromise;

    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("websocket server close still pending after 250ms force window"),
      ),
    ).toBe(true);
  });

  it("reports a clean shutdown with no warnings", async () => {
    const close = createGatewayCloseHandler(makeParams({}));

    const result = await close({ reason: "test shutdown" });

    expect(result.warnings).toEqual([]);
    expect(typeof result.durationMs).toBe("number");
  });

  it("records a warning when a shutdown step throws but still completes shutdown", async () => {
    const close = createGatewayCloseHandler(
      makeParams({
        bonjourStop: vi.fn(async () => {
          throw new Error("bonjour boom");
        }),
        configReloader: {
          stop: vi.fn(async () => {
            throw new Error("reloader boom");
          }),
        },
      }),
    );

    const result = await close({ reason: "test shutdown" });

    expect(result.warnings).toContain("bonjour");
    expect(result.warnings).toContain("config-reloader");
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("bonjour: bonjour boom"),
      ),
    ).toBe(true);
  });

  it("forces http connections closed when http close exceeds the grace window", async () => {
    vi.useFakeTimers();

    let httpCloseCallback: ((err?: Error | null) => void) | null = null;
    const closeAllConnections = vi.fn(() => {
      httpCloseCallback?.(null);
    });
    const close = createGatewayCloseHandler(
      makeParams({
        httpServer: {
          close: (cb: (err?: Error | null) => void) => {
            httpCloseCallback = cb;
          },
          closeIdleConnections: vi.fn(),
          closeAllConnections,
        } as never,
      }),
    );

    const closePromise = close({ reason: "test shutdown" });
    await vi.advanceTimersByTimeAsync(HTTP_CLOSE_GRACE_MS);
    const result = await closePromise;

    expect(closeAllConnections).toHaveBeenCalledTimes(1);
    expect(result.warnings).toContain("http-server");
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("http-server close exceeded 1000ms"),
      ),
    ).toBe(true);
  });

  it("throws when http close is still pending after the forced shutdown window", async () => {
    vi.useFakeTimers();

    const close = createGatewayCloseHandler(
      makeParams({
        httpServer: {
          close: () => undefined,
          closeIdleConnections: vi.fn(),
          closeAllConnections: vi.fn(),
        } as never,
      }),
    );

    const closePromise = close({ reason: "test shutdown" });
    const assertion = expect(closePromise).rejects.toThrow(
      /http-server close still pending after forced connection shutdown/,
    );
    await vi.advanceTimersByTimeAsync(HTTP_CLOSE_GRACE_MS + HTTP_CLOSE_FORCE_WAIT_MS);
    await assertion;
  });

  it("still closes the remaining http servers when one refuses to close", async () => {
    vi.useFakeTimers();

    const stuckClose = vi.fn(() => undefined);
    const secondClose = vi.fn((cb: (err?: Error | null) => void) => cb(null));
    const secondCloseIdle = vi.fn();
    const close = createGatewayCloseHandler(
      makeParams({
        httpServer: { close: stuckClose, closeIdleConnections: vi.fn() } as never,
        httpServers: [
          {
            close: stuckClose,
            closeIdleConnections: vi.fn(),
            closeAllConnections: vi.fn(),
          },
          {
            close: secondClose,
            closeIdleConnections: secondCloseIdle,
            closeAllConnections: vi.fn(),
          },
        ] as never,
      }),
    );

    const closePromise = close({ reason: "test shutdown" });
    const assertion = expect(closePromise).rejects.toThrow(
      /http-server\[0\] close still pending after forced connection shutdown/,
    );
    await vi.advanceTimersByTimeAsync(HTTP_CLOSE_GRACE_MS + HTTP_CLOSE_FORCE_WAIT_MS);
    await assertion;

    // The second listener must not stay bound just because the first wedged.
    expect(secondCloseIdle).toHaveBeenCalledTimes(1);
    expect(secondClose).toHaveBeenCalledTimes(1);
  });

  it("leaves no pending timers behind after a clean shutdown", async () => {
    vi.useFakeTimers();
    const close = createGatewayCloseHandler(makeParams({}));

    await close({ reason: "test shutdown" });

    expect(vi.getTimerCount()).toBe(0);
  });

  it("warns and still surfaces an http close callback error", async () => {
    const close = createGatewayCloseHandler(
      makeParams({
        httpServer: {
          close: (cb: (err?: Error | null) => void) => cb(new Error("not running")),
          closeIdleConnections: vi.fn(),
        } as never,
      }),
    );

    // Reported as a warning, but not swallowed: callers still see the failure.
    await expect(close({ reason: "test shutdown" })).rejects.toThrow(/not running/);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("http-server: not running"),
      ),
    ).toBe(true);
  });
});
