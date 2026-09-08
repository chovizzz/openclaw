import { callGateway } from "../gateway/call.js";
import { formatErrorMessage } from "../infra/errors.js";
import { extractAssistantText, stripToolMessages } from "./tools/chat-history-text.js";

type GatewayCaller = typeof callGateway;

// Node's setTimeout/setInterval delay is a signed 32-bit int; larger values wrap/overflow
// in the timer internals. Keep this in sync with the same literal used by ../gateway/call.ts.
const MAX_TIMER_TIMEOUT_MS = 2_147_483_647;

/**
 * Adds a grace period on top of an agent-run wait timeout before it is used as the
 * envelope timeout for the underlying gateway call. Callers can pass arbitrarily large
 * (even non-finite) `timeoutMs` values; naive `timeoutMs + graceMs` addition can overflow
 * to `Infinity`, which downstream call.ts's timeout resolution treats as "invalid" and
 * silently falls back to a small default (10s) -- prematurely cutting a legitimate long
 * wait short instead of honoring it. Cap the sum at MAX_TIMER_TIMEOUT_MS instead so an
 * overflowed value still resolves to the longest safe timer delay.
 */
function addWaitTimeoutGraceMs(timeoutMs: number, graceMs: number): number {
  if (!Number.isFinite(timeoutMs)) {
    return MAX_TIMER_TIMEOUT_MS;
  }
  const withGrace = timeoutMs + graceMs;
  return Math.min(
    MAX_TIMER_TIMEOUT_MS,
    Number.isFinite(withGrace) ? withGrace : MAX_TIMER_TIMEOUT_MS,
  );
}

const defaultRunWaitDeps = {
  callGateway,
};

let runWaitDeps: {
  callGateway: GatewayCaller;
} = defaultRunWaitDeps;

export type AssistantReplySnapshot = {
  text?: string;
  fingerprint?: string;
};

export type AgentWaitResult = {
  status: "ok" | "timeout" | "error";
  error?: string;
  startedAt?: number;
  endedAt?: number;
};

export type AgentRunsDrainResult = {
  timedOut: boolean;
  pendingRunIds: string[];
  deadlineAtMs: number;
};

type RawAgentWaitResponse = {
  status?: string;
  error?: string;
  startedAt?: unknown;
  endedAt?: unknown;
};

function normalizeAgentWaitResult(
  status: AgentWaitResult["status"],
  wait?: RawAgentWaitResponse,
): AgentWaitResult {
  return {
    status,
    error: typeof wait?.error === "string" ? wait.error : undefined,
    startedAt: typeof wait?.startedAt === "number" ? wait.startedAt : undefined,
    endedAt: typeof wait?.endedAt === "number" ? wait.endedAt : undefined,
  };
}

function normalizePendingRunIds(runIds: Iterable<string>): string[] {
  const seen = new Set<string>();
  for (const runId of runIds) {
    const normalized = runId.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
  }
  return [...seen];
}

function resolveLatestAssistantReplySnapshot(messages: unknown[]): AssistantReplySnapshot {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    if ((candidate as { role?: unknown }).role !== "assistant") {
      continue;
    }
    const text = extractAssistantText(candidate);
    if (!text?.trim()) {
      continue;
    }
    let fingerprint: string | undefined;
    try {
      fingerprint = JSON.stringify(candidate);
    } catch {
      fingerprint = text;
    }
    return { text, fingerprint };
  }
  return {};
}

export async function readLatestAssistantReplySnapshot(params: {
  sessionKey: string;
  limit?: number;
  callGateway?: GatewayCaller;
}): Promise<AssistantReplySnapshot> {
  const history = await (params.callGateway ?? runWaitDeps.callGateway)<{
    messages: Array<unknown>;
  }>({
    method: "chat.history",
    params: { sessionKey: params.sessionKey, limit: params.limit ?? 50 },
  });
  return resolveLatestAssistantReplySnapshot(
    stripToolMessages(Array.isArray(history?.messages) ? history.messages : []),
  );
}

export async function readLatestAssistantReply(params: {
  sessionKey: string;
  limit?: number;
  callGateway?: GatewayCaller;
}): Promise<string | undefined> {
  return (
    await readLatestAssistantReplySnapshot({
      sessionKey: params.sessionKey,
      limit: params.limit,
      callGateway: params.callGateway,
    })
  ).text;
}

export async function waitForAgentRun(params: {
  runId: string;
  timeoutMs: number;
  callGateway?: GatewayCaller;
}): Promise<AgentWaitResult> {
  const timeoutMs = Math.max(1, Math.floor(params.timeoutMs));
  try {
    const wait = await (params.callGateway ?? runWaitDeps.callGateway)<RawAgentWaitResponse>({
      method: "agent.wait",
      params: {
        runId: params.runId,
        timeoutMs,
      },
      timeoutMs: addWaitTimeoutGraceMs(timeoutMs, 2000),
    });
    if (wait?.status === "timeout") {
      return normalizeAgentWaitResult("timeout", wait);
    }
    if (wait?.status === "error") {
      return normalizeAgentWaitResult("error", wait);
    }
    return normalizeAgentWaitResult("ok", wait);
  } catch (err) {
    const error = formatErrorMessage(err);
    return {
      status: error.includes("gateway timeout") ? "timeout" : "error",
      error,
    };
  }
}

export async function waitForAgentRunAndReadUpdatedAssistantReply(params: {
  runId: string;
  sessionKey: string;
  timeoutMs: number;
  limit?: number;
  baseline?: AssistantReplySnapshot;
  callGateway?: GatewayCaller;
}): Promise<AgentWaitResult & { replyText?: string }> {
  const wait = await waitForAgentRun({
    runId: params.runId,
    timeoutMs: params.timeoutMs,
    callGateway: params.callGateway,
  });
  if (wait.status !== "ok") {
    return wait;
  }

  const latestReply = await readLatestAssistantReplySnapshot({
    sessionKey: params.sessionKey,
    limit: params.limit,
    callGateway: params.callGateway,
  });
  const baselineFingerprint = params.baseline?.fingerprint;
  const replyText =
    latestReply.text && (!baselineFingerprint || latestReply.fingerprint !== baselineFingerprint)
      ? latestReply.text
      : undefined;
  return {
    status: "ok",
    replyText,
  };
}

export async function waitForAgentRunsToDrain(params: {
  getPendingRunIds: () => Iterable<string>;
  initialPendingRunIds?: Iterable<string>;
  timeoutMs?: number;
  deadlineAtMs?: number;
  callGateway?: GatewayCaller;
}): Promise<AgentRunsDrainResult> {
  const deadlineAtMs =
    params.deadlineAtMs ?? Date.now() + Math.max(1, Math.floor(params.timeoutMs ?? 0));

  // Runs may finish and spawn more runs, so refresh until no pending IDs remain.
  let pendingRunIds = new Set<string>(
    normalizePendingRunIds(params.initialPendingRunIds ?? params.getPendingRunIds()),
  );

  while (pendingRunIds.size > 0 && Date.now() < deadlineAtMs) {
    const remainingMs = Math.max(1, deadlineAtMs - Date.now());
    await Promise.allSettled(
      [...pendingRunIds].map((runId) =>
        waitForAgentRun({
          runId,
          timeoutMs: remainingMs,
          callGateway: params.callGateway,
        }),
      ),
    );
    pendingRunIds = new Set<string>(normalizePendingRunIds(params.getPendingRunIds()));
  }

  return {
    timedOut: pendingRunIds.size > 0,
    pendingRunIds: [...pendingRunIds],
    deadlineAtMs,
  };
}

export const __testing = {
  setDepsForTest(overrides?: Partial<{ callGateway: GatewayCaller }>) {
    runWaitDeps = overrides
      ? {
          ...defaultRunWaitDeps,
          ...overrides,
        }
      : defaultRunWaitDeps;
  },
  addWaitTimeoutGraceMs,
  MAX_TIMER_TIMEOUT_MS,
};
