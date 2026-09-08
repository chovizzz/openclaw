import { afterEach, describe, expect, it, vi } from "vitest";
import type { HealthSummary } from "../commands/health.js";
import { registerAgentRunContext, resetAgentRunContextForTest } from "../infra/agent-events.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import { DEDUPE_MAX, DEDUPE_TTL_MS } from "./server-constants.js";

const cleanOldMediaMock = vi.fn(async () => {});

vi.mock("../media/store.js", async () => {
  const actual = await vi.importActual<typeof import("../media/store.js")>("../media/store.js");
  return {
    ...actual,
    cleanOldMedia: cleanOldMediaMock,
  };
});

const MEDIA_CLEANUP_TTL_MS = 24 * 60 * 60_000;
const ABORTED_RUN_TTL_MS = 60 * 60_000;

function createActiveRun(sessionKey: string): ChatAbortControllerEntry {
  const now = Date.now();
  return {
    controller: new AbortController(),
    sessionId: "sess-1",
    sessionKey,
    startedAtMs: now,
    expiresAtMs: now + ABORTED_RUN_TTL_MS,
  };
}

function createMaintenanceTimerDeps() {
  return {
    broadcast: () => {},
    nodeSendToAllSubscribed: () => {},
    getPresenceVersion: () => 1,
    getHealthVersion: () => 1,
    refreshGatewayHealthSnapshot: async () => ({ ok: true }) as HealthSummary,
    logHealth: { error: () => {} },
    dedupe: new Map(),
    chatAbortControllers: new Map(),
    chatRunState: { abortedRuns: new Map() },
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    chatDeltaLastBroadcastLen: new Map(),
    removeChatRun: () => undefined,
    agentRunSeq: new Map(),
    nodeSendToSession: () => {},
  };
}

function stopMaintenanceTimers(timers: {
  tickInterval: NodeJS.Timeout;
  healthInterval: NodeJS.Timeout;
  dedupeCleanup: NodeJS.Timeout;
  mediaCleanup: NodeJS.Timeout | null;
}) {
  clearInterval(timers.tickInterval);
  clearInterval(timers.healthInterval);
  clearInterval(timers.dedupeCleanup);
  if (timers.mediaCleanup) {
    clearInterval(timers.mediaCleanup);
  }
}

describe("startGatewayMaintenanceTimers", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    resetAgentRunContextForTest();
  });

  it("does not schedule recursive media cleanup unless ttl is configured", async () => {
    vi.useFakeTimers();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");

    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
    });

    expect(cleanOldMediaMock).not.toHaveBeenCalled();
    expect(timers.mediaCleanup).toBeNull();

    stopMaintenanceTimers(timers);
  });

  it("runs startup media cleanup and repeats it hourly", async () => {
    vi.useFakeTimers();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");

    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
      mediaCleanupTtlMs: MEDIA_CLEANUP_TTL_MS,
    });

    expect(cleanOldMediaMock).toHaveBeenCalledWith(MEDIA_CLEANUP_TTL_MS, {
      recursive: true,
      pruneEmptyDirs: true,
    });

    cleanOldMediaMock.mockClear();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(cleanOldMediaMock).toHaveBeenCalledWith(MEDIA_CLEANUP_TTL_MS, {
      recursive: true,
      pruneEmptyDirs: true,
    });

    stopMaintenanceTimers(timers);
  });

  it("skips overlapping media cleanup runs", async () => {
    vi.useFakeTimers();
    let resolveCleanup = () => {};
    let cleanupReady = false;
    cleanOldMediaMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCleanup = resolve;
          cleanupReady = true;
        }),
    );
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");

    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
      mediaCleanupTtlMs: MEDIA_CLEANUP_TTL_MS,
    });

    expect(cleanOldMediaMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(cleanOldMediaMock).toHaveBeenCalledTimes(1);

    if (cleanupReady) {
      resolveCleanup();
    }
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(cleanOldMediaMock).toHaveBeenCalledTimes(2);

    stopMaintenanceTimers(timers);
  });

  it("keeps stale buffers for active runs that still have abort controllers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const runId = "run-active";
    deps.chatAbortControllers.set(runId, createActiveRun("main"));
    deps.chatRunBuffers.set(runId, "buffer");
    deps.chatDeltaSentAt.set(runId, Date.now() - ABORTED_RUN_TTL_MS - 1);
    deps.chatDeltaLastBroadcastLen.set(runId, 6);

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.chatRunBuffers.get(runId)).toBe("buffer");
    expect(deps.chatDeltaSentAt.has(runId)).toBe(true);
    expect(deps.chatDeltaLastBroadcastLen.get(runId)).toBe(6);

    stopMaintenanceTimers(timers);
  });

  it("sweeps orphaned stale buffers once the abort controller is gone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const runId = "run-orphaned";
    deps.chatRunBuffers.set(runId, "buffer");
    deps.chatDeltaSentAt.set(runId, Date.now() - ABORTED_RUN_TTL_MS - 1);
    deps.chatDeltaLastBroadcastLen.set(runId, 6);

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.chatRunBuffers.has(runId)).toBe(false);
    expect(deps.chatDeltaSentAt.has(runId)).toBe(false);
    expect(deps.chatDeltaLastBroadcastLen.has(runId)).toBe(false);

    stopMaintenanceTimers(timers);
  });

  it("clears deltaLastBroadcastLen when aborted runs age out", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const runId = "run-aborted";
    deps.chatRunState.abortedRuns.set(runId, Date.now() - ABORTED_RUN_TTL_MS - 1);
    deps.chatRunBuffers.set(runId, "buffer");
    deps.chatDeltaSentAt.set(runId, Date.now() - ABORTED_RUN_TTL_MS - 1);
    deps.chatDeltaLastBroadcastLen.set(runId, 6);

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.chatRunState.abortedRuns.has(runId)).toBe(false);
    expect(deps.chatRunBuffers.has(runId)).toBe(false);
    expect(deps.chatDeltaSentAt.has(runId)).toBe(false);
    expect(deps.chatDeltaLastBroadcastLen.has(runId)).toBe(false);

    stopMaintenanceTimers(timers);
  });

  // Regression coverage: this fork's chatAbortControllers sweep has no
  // "terminal pending" skip branch at all (unlike the upstream mechanism
  // this fork lacks — see session-lifecycle-state.ts's persist retry for the
  // adjacent fix this fork's architecture actually supports). It only checks
  // expiresAtMs, and abortChatRunById always deletes the map entry once it
  // fires. These two tests lock in both halves of that invariant so a future
  // change cannot silently reintroduce a ghost/ghosted-active regression.
  it("never aborts a run whose expiry has not elapsed yet (reverse test: a real running session is not mistaken for a ghost)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const runId = "run-genuinely-active";
    const activeRun = createActiveRun("main");
    deps.chatAbortControllers.set(runId, activeRun);

    const timers = startGatewayMaintenanceTimers(deps);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(activeRun.controller.signal.aborted).toBe(false);
    expect(deps.chatAbortControllers.has(runId)).toBe(true);

    stopMaintenanceTimers(timers);
  });

  it("always removes an expired run from chatAbortControllers once swept (no ghost entry left behind)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const runId = "run-expired";
    const expiredRun = createActiveRun("main");
    expiredRun.expiresAtMs = Date.now() - 1;
    deps.chatAbortControllers.set(runId, expiredRun);

    const timers = startGatewayMaintenanceTimers(deps);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(expiredRun.controller.signal.aborted).toBe(true);
    expect(deps.chatAbortControllers.has(runId)).toBe(false);

    stopMaintenanceTimers(timers);
  });

  it("evicts dedupe overflow by oldest timestamp even after reinsertion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const now = Date.now();

    for (let index = 0; index < DEDUPE_MAX; index += 1) {
      deps.dedupe.set(`stable-${index}`, { ts: now - 1_000 + index, ok: true });
    }

    // Reinsert one entry with an older timestamp: Map insertion order now says
    // "newest", but the entry timestamp says "oldest". Eviction must follow ts.
    deps.dedupe.delete("stable-10");
    deps.dedupe.set("stable-10", { ts: now - 2_000, ok: true });
    deps.dedupe.set("overflow-newest", { ts: now - 100, ok: true });

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.dedupe.size).toBe(DEDUPE_MAX);
    expect(deps.dedupe.has("stable-10")).toBe(false);
    expect(deps.dedupe.has("stable-0")).toBe(true);
    expect(deps.dedupe.has("overflow-newest")).toBe(true);

    stopMaintenanceTimers(timers);
  });

  it("evicts the full overflow in a single sweep", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const now = Date.now();

    const overflow = 10;
    for (let index = 0; index < DEDUPE_MAX + overflow; index += 1) {
      deps.dedupe.set(`k-${index}`, { ts: now - 5_000 + index, ok: true });
    }

    const timers = startGatewayMaintenanceTimers(deps);
    await vi.advanceTimersByTimeAsync(60_000);

    // The old loop recomputed its bound against the shrinking Map and dropped
    // only ceil(overflow / 2) entries, leaving the cache permanently over cap.
    expect(deps.dedupe.size).toBe(DEDUPE_MAX);
    for (let index = 0; index < overflow; index += 1) {
      expect(deps.dedupe.has(`k-${index}`)).toBe(false);
    }
    expect(deps.dedupe.has(`k-${overflow}`)).toBe(true);

    stopMaintenanceTimers(timers);
  });

  it("keeps active agent dedupe entries past the normal ttl", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const now = Date.now();

    // Still registered as an active agent run (not yet cleared by lifecycle
    // end/error), so its dedupe entry is the only thing standing between a
    // retry and a duplicate dispatch.
    registerAgentRunContext("active-agent", { sessionKey: "agent:main:main" });
    deps.dedupe.set("agent:active-agent", {
      ts: now - DEDUPE_TTL_MS - 1,
      ok: true,
      payload: { runId: "active-agent", status: "accepted" },
    });
    deps.dedupe.set("agent:stale-agent", {
      ts: now - DEDUPE_TTL_MS - 1,
      ok: true,
      payload: { runId: "stale-agent", status: "accepted" },
    });

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.dedupe.has("agent:active-agent")).toBe(true);
    expect(deps.dedupe.has("agent:stale-agent")).toBe(false);

    stopMaintenanceTimers(timers);
  });

  it("does not evict active agent dedupe entries while trimming overflow", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const now = Date.now();

    for (let index = 0; index < DEDUPE_MAX; index += 1) {
      deps.dedupe.set(`stable-${index}`, { ts: now - 1_000 + index, ok: true });
    }
    registerAgentRunContext("active-oldest", { sessionKey: "agent:main:main" });
    deps.dedupe.set("agent:active-oldest", {
      ts: now - 10_000,
      ok: true,
      payload: { runId: "active-oldest", status: "accepted" },
    });
    deps.dedupe.set("overflow-newest", { ts: now, ok: true });

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.dedupe.size).toBe(DEDUPE_MAX);
    expect(deps.dedupe.has("agent:active-oldest")).toBe(true);
    expect(deps.dedupe.has("stable-0")).toBe(false);
    expect(deps.dedupe.has("stable-1")).toBe(false);
    expect(deps.dedupe.has("overflow-newest")).toBe(true);

    stopMaintenanceTimers(timers);
  });
});
