import { updateSessionStoreEntry, type SessionEntry } from "../config/sessions.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { retryAsync } from "../infra/retry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { loadSessionEntry } from "./session-utils.js";
import type { GatewaySessionRow, SessionRunStatus } from "./session-utils.types.js";

const log = createSubsystemLogger("gateway/session-lifecycle");

/**
 * The terminal entry write (status/endedAt/runtimeMs) is fire-and-forget from
 * its caller (server-chat.ts clears the in-memory run context synchronously,
 * then awaits this write without a caller-side retry — a rejection is
 * silently swallowed). Without a retry here, a single transient store-lock
 * contention or I/O hiccup permanently strands the session row on its
 * pre-terminal status/fields: sessions.list would show it "running" forever
 * even though the run context has already been cleared.
 *
 * Bounded: at most 3 attempts, exponential backoff starting at 200ms
 * (200ms, then 400ms between attempts) — worst case ~600ms of sleep plus
 * three store-lock/write attempts before giving up. `update` is a pure
 * function of the entry read inside the same locked attempt, so retrying is
 * safe (each attempt recomputes the patch from the then-current entry
 * instead of replaying a stale one).
 */
const LIFECYCLE_PERSIST_RETRY_ATTEMPTS = 3;
const LIFECYCLE_PERSIST_RETRY_MIN_DELAY_MS = 200;
const LIFECYCLE_PERSIST_RETRY_MAX_DELAY_MS = 400;

type LifecyclePhase = "start" | "end" | "error";

type LifecycleEventLike = Pick<AgentEventPayload, "ts"> & {
  data?: {
    phase?: unknown;
    startedAt?: unknown;
    endedAt?: unknown;
    aborted?: unknown;
    stopReason?: unknown;
  };
};

type LifecycleSessionShape = Pick<
  GatewaySessionRow,
  "updatedAt" | "status" | "startedAt" | "endedAt" | "runtimeMs" | "abortedLastRun"
>;

type PersistedLifecycleSessionShape = Pick<
  SessionEntry,
  "updatedAt" | "status" | "startedAt" | "endedAt" | "runtimeMs" | "abortedLastRun"
>;

export type GatewaySessionLifecycleSnapshot = Partial<LifecycleSessionShape>;

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function resolveLifecyclePhase(event: LifecycleEventLike): LifecyclePhase | null {
  const phase = typeof event.data?.phase === "string" ? event.data.phase : "";
  return phase === "start" || phase === "end" || phase === "error" ? phase : null;
}

function resolveTerminalStatus(event: LifecycleEventLike): SessionRunStatus {
  const phase = resolveLifecyclePhase(event);
  if (phase === "error") {
    return "failed";
  }

  const stopReason = typeof event.data?.stopReason === "string" ? event.data.stopReason : "";
  if (stopReason === "aborted") {
    return "killed";
  }

  return event.data?.aborted === true ? "timeout" : "done";
}

function resolveLifecycleStartedAt(
  existingStartedAt: number | undefined,
  event: LifecycleEventLike,
): number | undefined {
  if (isFiniteTimestamp(event.data?.startedAt)) {
    return event.data.startedAt;
  }
  if (isFiniteTimestamp(existingStartedAt)) {
    return existingStartedAt;
  }
  return isFiniteTimestamp(event.ts) ? event.ts : undefined;
}

function resolveLifecycleEndedAt(event: LifecycleEventLike): number | undefined {
  if (isFiniteTimestamp(event.data?.endedAt)) {
    return event.data.endedAt;
  }
  return isFiniteTimestamp(event.ts) ? event.ts : undefined;
}

function resolveRuntimeMs(params: {
  startedAt?: number;
  endedAt?: number;
  existingRuntimeMs?: number;
}): number | undefined {
  const { startedAt, endedAt, existingRuntimeMs } = params;
  if (isFiniteTimestamp(startedAt) && isFiniteTimestamp(endedAt)) {
    return Math.max(0, endedAt - startedAt);
  }
  if (
    typeof existingRuntimeMs === "number" &&
    Number.isFinite(existingRuntimeMs) &&
    existingRuntimeMs >= 0
  ) {
    return existingRuntimeMs;
  }
  return undefined;
}

export function deriveGatewaySessionLifecycleSnapshot(params: {
  session?: Partial<LifecycleSessionShape> | null;
  event: LifecycleEventLike;
}): GatewaySessionLifecycleSnapshot {
  const phase = resolveLifecyclePhase(params.event);
  if (!phase) {
    return {};
  }

  const existing = params.session ?? undefined;
  if (phase === "start") {
    const startedAt = resolveLifecycleStartedAt(existing?.startedAt, params.event);
    const updatedAt = startedAt ?? existing?.updatedAt;
    return {
      updatedAt,
      status: "running",
      startedAt,
      endedAt: undefined,
      runtimeMs: undefined,
      abortedLastRun: false,
    };
  }

  const startedAt = resolveLifecycleStartedAt(existing?.startedAt, params.event);
  const endedAt = resolveLifecycleEndedAt(params.event);
  const updatedAt = endedAt ?? existing?.updatedAt;
  return {
    updatedAt,
    status: resolveTerminalStatus(params.event),
    startedAt,
    endedAt,
    runtimeMs: resolveRuntimeMs({
      startedAt,
      endedAt,
      existingRuntimeMs: existing?.runtimeMs,
    }),
    abortedLastRun: resolveTerminalStatus(params.event) === "killed",
  };
}

export function derivePersistedSessionLifecyclePatch(params: {
  entry?: Partial<PersistedLifecycleSessionShape> | null;
  event: LifecycleEventLike;
}): Partial<PersistedLifecycleSessionShape> {
  const snapshot = deriveGatewaySessionLifecycleSnapshot({
    session: params.entry ?? undefined,
    event: params.event,
  });
  return {
    ...snapshot,
    updatedAt: typeof snapshot.updatedAt === "number" ? snapshot.updatedAt : undefined,
  };
}

export async function persistGatewaySessionLifecycleEvent(params: {
  sessionKey: string;
  event: LifecycleEventLike;
}): Promise<void> {
  const phase = resolveLifecyclePhase(params.event);
  if (!phase) {
    return;
  }

  const sessionEntry = loadSessionEntry(params.sessionKey);
  if (!sessionEntry.entry) {
    return;
  }

  try {
    await retryAsync(
      () =>
        updateSessionStoreEntry({
          storePath: sessionEntry.storePath,
          sessionKey: sessionEntry.canonicalKey,
          update: async (entry) =>
            derivePersistedSessionLifecyclePatch({
              entry,
              event: params.event,
            }),
        }),
      {
        attempts: LIFECYCLE_PERSIST_RETRY_ATTEMPTS,
        minDelayMs: LIFECYCLE_PERSIST_RETRY_MIN_DELAY_MS,
        maxDelayMs: LIFECYCLE_PERSIST_RETRY_MAX_DELAY_MS,
        label: "session-lifecycle-persist",
      },
    );
  } catch (err) {
    // Final behavior after exhausting retries: give up and leave the session
    // row on its last-persisted (pre-terminal) status rather than throwing —
    // matching this function's existing fire-and-forget contract — but log
    // so a permanently-stuck "running" row is at least diagnosable instead
    // of silently invisible.
    log.warn?.(
      `failed to persist terminal lifecycle event for session=${params.sessionKey} after ${LIFECYCLE_PERSIST_RETRY_ATTEMPTS} attempts: ${String(err)}`,
    );
  }
}
