import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import { mergeMockedModule } from "../test-utils/vitest-module-mocks.js";

const {
  enqueueSystemEventMock,
  requestHeartbeatNowMock,
  loadConfigMock,
  fetchWithSsrFGuardMock,
  runCronIsolatedAgentTurnMock,
  cleanupBrowserSessionsForLifecycleEndMock,
  resolveDeliveryTargetMock,
  deliverOutboundPayloadsMock,
} = vi.hoisted(() => ({
  enqueueSystemEventMock: vi.fn(),
  requestHeartbeatNowMock: vi.fn(),
  loadConfigMock: vi.fn(),
  fetchWithSsrFGuardMock: vi.fn(),
  runCronIsolatedAgentTurnMock: vi.fn(
    async (): Promise<{ status: "ok" | "error"; summary?: string; error?: string }> => ({
      status: "ok",
      summary: "ok",
    }),
  ),
  cleanupBrowserSessionsForLifecycleEndMock: vi.fn(async () => {}),
  resolveDeliveryTargetMock: vi.fn(),
  deliverOutboundPayloadsMock: vi.fn(),
}));

function enqueueSystemEvent(...args: unknown[]) {
  return enqueueSystemEventMock(...args);
}

function requestHeartbeatNow(...args: unknown[]) {
  return requestHeartbeatNowMock(...args);
}

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent,
}));

vi.mock("../infra/heartbeat-wake.js", async () => {
  return await mergeMockedModule(
    await vi.importActual<typeof import("../infra/heartbeat-wake.js")>(
      "../infra/heartbeat-wake.js",
    ),
    () => ({
      requestHeartbeatNow,
    }),
  );
});

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: () => loadConfigMock(),
  };
});

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: runCronIsolatedAgentTurnMock,
}));

vi.mock("../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: cleanupBrowserSessionsForLifecycleEndMock,
}));

vi.mock("../cron/isolated-agent/delivery-target.js", () => ({
  resolveDeliveryTarget: resolveDeliveryTargetMock,
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: deliverOutboundPayloadsMock,
}));

import { buildGatewayCronService } from "./server-cron.js";

function createCronConfig(name: string): OpenClawConfig {
  const tmpDir = path.join(os.tmpdir(), `${name}-${Date.now()}`);
  return {
    session: {
      mainKey: "main",
    },
    cron: {
      store: path.join(tmpDir, "cron.json"),
    },
  } as OpenClawConfig;
}

describe("buildGatewayCronService", () => {
  beforeEach(() => {
    enqueueSystemEventMock.mockClear();
    requestHeartbeatNowMock.mockClear();
    loadConfigMock.mockClear();
    fetchWithSsrFGuardMock.mockClear();
    runCronIsolatedAgentTurnMock.mockClear();
    cleanupBrowserSessionsForLifecycleEndMock.mockClear();
    resolveDeliveryTargetMock.mockReset();
    deliverOutboundPayloadsMock.mockReset();
  });

  it("routes main-target jobs to the scoped session for enqueue + wake", async () => {
    const cfg = createCronConfig("server-cron");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "canonicalize-session-key",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        sessionKey: "discord:channel:ops",
        payload: { kind: "systemEvent", text: "hello" },
      });

      await state.cron.run(job.id, "force");

      expect(enqueueSystemEventMock).toHaveBeenCalledWith(
        "hello",
        expect.objectContaining({
          sessionKey: "agent:main:discord:channel:ops",
        }),
      );
      expect(requestHeartbeatNowMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:discord:channel:ops",
        }),
      );
    } finally {
      state.cron.stop();
    }
  });

  it("blocks private webhook URLs via SSRF-guarded fetch", async () => {
    const cfg = createCronConfig("server-cron-ssrf");
    loadConfigMock.mockReturnValue(cfg);
    fetchWithSsrFGuardMock.mockRejectedValue(
      new SsrFBlockedError("Blocked: resolves to private/internal/special-use IP address"),
    );

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "ssrf-webhook-blocked",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
        delivery: {
          mode: "webhook",
          to: "http://127.0.0.1:8080/cron-finished",
        },
      });

      await state.cron.run(job.id, "force");

      expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
        url: "http://127.0.0.1:8080/cron-finished",
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: expect.stringContaining('"action":"finished"'),
          signal: expect.any(AbortSignal),
        },
      });
    } finally {
      state.cron.stop();
    }
  });

  it("passes custom session targets through to isolated cron runs", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-custom-session-${Date.now()}`);
    const cfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "custom-session",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "session:project-alpha-monitor",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "hello" },
      });

      await state.cron.run(job.id, "force");

      expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          job: expect.objectContaining({ id: job.id }),
          sessionKey: "project-alpha-monitor",
        }),
      );
      expect(cleanupBrowserSessionsForLifecycleEndMock).toHaveBeenCalledWith({
        sessionKeys: ["project-alpha-monitor"],
        onWarn: expect.any(Function),
      });
    } finally {
      state.cron.stop();
    }
  });

  it("uses a dedicated cron session key for isolated jobs with model overrides", async () => {
    const cfg = createCronConfig("server-cron-isolated-key");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "isolated-model-override",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: {
          kind: "agentTurn",
          message: "run report",
          model: "ollama/kimi-k2.5:cloud",
        },
      });

      await state.cron.run(job.id, "force");

      expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          job: expect.objectContaining({ id: job.id }),
          sessionKey: `cron:${job.id}`,
        }),
      );
      expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "main",
        }),
      );
      expect(cleanupBrowserSessionsForLifecycleEndMock).toHaveBeenCalledWith({
        sessionKeys: [`cron:${job.id}`],
        onWarn: expect.any(Function),
      });
    } finally {
      state.cron.stop();
    }
  });

  // Regression coverage for the announce-mode failure-alert delivery path in
  // sendCronFailureAlert: a channel/account failure must fall back to an
  // in-agent system event instead of being dropped silently (#129908-style
  // fix ported for this fork's single-path failure-alert architecture).
  describe("failure alert announce delivery fallback", () => {
    function createFailureAlertCronConfig(name: string): OpenClawConfig {
      const cfg = createCronConfig(name);
      return {
        ...cfg,
        cron: {
          ...cfg.cron,
          failureAlert: { enabled: true, after: 1, cooldownMs: 0 },
        },
      } as OpenClawConfig;
    }

    it("falls back to a system event when announce delivery fails, instead of dropping the alert", async () => {
      const cfg = createFailureAlertCronConfig("server-cron-failure-alert-drop");
      loadConfigMock.mockReturnValue(cfg);
      resolveDeliveryTargetMock.mockResolvedValue({
        ok: true,
        channel: "telegram",
        to: "ops-chat",
        mode: "explicit",
      });
      deliverOutboundPayloadsMock.mockRejectedValue(new Error("channel unavailable"));
      runCronIsolatedAgentTurnMock.mockResolvedValueOnce({
        status: "error",
        error: "boom",
      });

      const state = buildGatewayCronService({
        cfg,
        deps: {} as CliDeps,
        broadcast: () => {},
      });
      try {
        const job = await state.cron.add({
          name: "flaky-report",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "run report" },
          delivery: {
            mode: "announce",
            channel: "telegram",
            to: "ops-chat",
            // Route the separate per-run primary-channel notice (onEvent
            // handler) to a webhook so it does not also hit
            // deliverOutboundPayloadsMock, keeping this test isolated to the
            // sendCronFailureAlert (threshold-based) announce path under test.
            failureDestination: { mode: "webhook", to: "http://example.invalid/hook" },
          },
        });

        await state.cron.run(job.id, "force");

        expect(deliverOutboundPayloadsMock).toHaveBeenCalledOnce();
        // The failed announce must not be dropped silently: it lands as a
        // system event so the operator/agent still sees it.
        expect(enqueueSystemEventMock).toHaveBeenCalledWith(
          expect.stringContaining('Cron job "flaky-report" failed 1 times'),
          expect.any(Object),
        );
      } finally {
        state.cron.stop();
      }
    });

    it("does not duplicate the alert via a system event when announce delivery succeeds", async () => {
      const cfg = createFailureAlertCronConfig("server-cron-failure-alert-no-dup");
      loadConfigMock.mockReturnValue(cfg);
      resolveDeliveryTargetMock.mockResolvedValue({
        ok: true,
        channel: "telegram",
        to: "ops-chat",
        mode: "explicit",
      });
      deliverOutboundPayloadsMock.mockResolvedValue(undefined);
      runCronIsolatedAgentTurnMock.mockResolvedValueOnce({
        status: "error",
        error: "boom",
      });

      const state = buildGatewayCronService({
        cfg,
        deps: {} as CliDeps,
        broadcast: () => {},
      });
      try {
        const job = await state.cron.add({
          name: "flaky-report-ok",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "run report" },
          delivery: {
            mode: "announce",
            channel: "telegram",
            to: "ops-chat",
            // Route the separate per-run primary-channel notice (onEvent
            // handler) to a webhook so it does not also hit
            // deliverOutboundPayloadsMock, keeping this test isolated to the
            // sendCronFailureAlert (threshold-based) announce path under test.
            failureDestination: { mode: "webhook", to: "http://example.invalid/hook" },
          },
        });

        await state.cron.run(job.id, "force");

        expect(deliverOutboundPayloadsMock).toHaveBeenCalledOnce();
        // A successful announce must not also enqueue a duplicate system-event alert.
        expect(enqueueSystemEventMock).not.toHaveBeenCalled();
      } finally {
        state.cron.stop();
      }
    });
  });

  // Regression coverage for the separate per-run "primary delivery channel"
  // failure notice (onEvent handler, #60608) which routes through
  // sendFailureNotificationAnnounce (src/cron/delivery.ts) via the shared
  // announceCronFailureWithFallback helper. Distinct from the
  // sendCronFailureAlert (threshold-based) path covered above.
  describe("primary-channel failure notice fallback (onEvent handler)", () => {
    it("falls back to a system event when the primary-channel announce fails", async () => {
      const cfg = createCronConfig("server-cron-primary-announce-drop");
      loadConfigMock.mockReturnValue(cfg);
      resolveDeliveryTargetMock.mockResolvedValue({
        ok: true,
        channel: "telegram",
        to: "ops-chat",
        mode: "explicit",
      });
      deliverOutboundPayloadsMock.mockRejectedValue(new Error("channel unavailable"));
      runCronIsolatedAgentTurnMock.mockResolvedValueOnce({
        status: "error",
        error: "boom",
      });

      const state = buildGatewayCronService({
        cfg,
        deps: {} as CliDeps,
        broadcast: () => {},
      });
      try {
        const job = await state.cron.add({
          name: "primary-channel-flaky",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "run report" },
          delivery: { mode: "announce", channel: "telegram", to: "ops-chat" },
        });

        await state.cron.run(job.id, "force");

        expect(deliverOutboundPayloadsMock).toHaveBeenCalledOnce();
        expect(enqueueSystemEventMock).toHaveBeenCalledWith(
          expect.stringContaining('Cron job "primary-channel-flaky" failed'),
          expect.any(Object),
        );
      } finally {
        state.cron.stop();
      }
    });

    it("does not duplicate the alert via a system event when the primary-channel announce succeeds", async () => {
      const cfg = createCronConfig("server-cron-primary-announce-ok");
      loadConfigMock.mockReturnValue(cfg);
      resolveDeliveryTargetMock.mockResolvedValue({
        ok: true,
        channel: "telegram",
        to: "ops-chat",
        mode: "explicit",
      });
      deliverOutboundPayloadsMock.mockResolvedValue(undefined);
      runCronIsolatedAgentTurnMock.mockResolvedValueOnce({
        status: "error",
        error: "boom",
      });

      const state = buildGatewayCronService({
        cfg,
        deps: {} as CliDeps,
        broadcast: () => {},
      });
      try {
        const job = await state.cron.add({
          name: "primary-channel-ok",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "run report" },
          delivery: { mode: "announce", channel: "telegram", to: "ops-chat" },
        });

        await state.cron.run(job.id, "force");

        expect(deliverOutboundPayloadsMock).toHaveBeenCalledOnce();
        expect(enqueueSystemEventMock).not.toHaveBeenCalled();
      } finally {
        state.cron.stop();
      }
    });

    it("falls back to a system event (and does not throw) when target resolution itself rejects", async () => {
      // Regression guard: sendFailureNotificationAnnounce must never let an
      // unexpected rejection (as opposed to a `{ ok: false }` result) escape
      // and skip the fallback, and announceCronFailureWithFallback must never
      // produce an unhandled rejection from this.
      const cfg = createCronConfig("server-cron-primary-announce-resolver-throws");
      loadConfigMock.mockReturnValue(cfg);
      resolveDeliveryTargetMock.mockRejectedValue(new Error("resolver blew up"));
      runCronIsolatedAgentTurnMock.mockResolvedValueOnce({
        status: "error",
        error: "boom",
      });

      const state = buildGatewayCronService({
        cfg,
        deps: {} as CliDeps,
        broadcast: () => {},
      });
      try {
        const job = await state.cron.add({
          name: "primary-channel-resolver-throws",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "run report" },
          delivery: { mode: "announce", channel: "telegram", to: "ops-chat" },
        });

        await expect(state.cron.run(job.id, "force")).resolves.toBeDefined();

        expect(deliverOutboundPayloadsMock).not.toHaveBeenCalled();
        expect(enqueueSystemEventMock).toHaveBeenCalledWith(
          expect.stringContaining('Cron job "primary-channel-resolver-throws" failed'),
          expect.any(Object),
        );
      } finally {
        state.cron.stop();
      }
    });
  });
});
