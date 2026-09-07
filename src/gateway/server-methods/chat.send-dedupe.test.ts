import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import type { DedupeEntry } from "../server-shared.js";
import { createActiveRun } from "./chat.abort.test-helpers.js";

const sessionEntryState = vi.hoisted(() => ({
  transcriptPath: "/tmp/openclaw-chat-send-dedupe/sess-main.jsonl",
  sessionId: "sess-main",
}));

const dispatchMocks = vi.hoisted(() => ({
  dispatchInboundMessage: vi.fn(async () => undefined),
}));

vi.mock("../session-utils.js", async () => {
  const original =
    await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...original,
    loadSessionEntry: () => ({
      cfg: {},
      storePath: path.join(path.dirname(sessionEntryState.transcriptPath), "sessions.json"),
      entry: {
        sessionId: sessionEntryState.sessionId,
        sessionFile: sessionEntryState.transcriptPath,
      },
      canonicalKey: "main",
    }),
  };
});

vi.mock("../../auto-reply/dispatch.js", async () => {
  const original = await vi.importActual<typeof import("../../auto-reply/dispatch.js")>(
    "../../auto-reply/dispatch.js",
  );
  return {
    ...original,
    dispatchInboundMessage: dispatchMocks.dispatchInboundMessage,
  };
});

const { chatHandlers, buildActiveChatSendDedupeKey } = await import("./chat.js");

type SendResponse = {
  ok: boolean;
  payload?: unknown;
};

function createChatSendContext(overrides: Record<string, unknown> = {}) {
  return {
    dedupe: new Map<string, DedupeEntry>(),
    chatAbortControllers: new Map<string, ReturnType<typeof createActiveRun>>(),
    chatAbortedRuns: new Map<string, number>(),
    chatRunBuffers: new Map<string, string>(),
    chatDeltaSentAt: new Map<string, number>(),
    chatDeltaLastBroadcastLen: new Map<string, number>(),
    agentRunSeq: new Map<string, number>(),
    addChatRun: vi.fn(),
    removeChatRun: vi.fn(),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    registerToolEventRecipient: vi.fn(),
    loadGatewayModelCatalog: vi.fn(),
    logGateway: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ...overrides,
  };
}

async function callChatSend(params: {
  context: ReturnType<typeof createChatSendContext>;
  message: string;
  idempotencyKey: string;
  extraParams?: Record<string, unknown>;
}): Promise<SendResponse> {
  const responses: SendResponse[] = [];
  const rpcParams = {
    sessionKey: "main",
    message: params.message,
    idempotencyKey: params.idempotencyKey,
    ...params.extraParams,
  };
  await chatHandlers["chat.send"]({
    req: {
      type: "req",
      id: params.idempotencyKey,
      method: "chat.send",
      params: rpcParams,
    } as never,
    params: rpcParams,
    client: {
      connect: {
        client: {
          id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
          mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        },
        scopes: ["operator.write"],
      },
    } as never,
    isWebchatConnect: () => true,
    respond: ((ok: boolean, payload?: unknown) => {
      responses.push({ ok, payload });
    }) as never,
    context: params.context as never,
  });
  expect(responses.length).toBeGreaterThan(0);
  return responses[0];
}

beforeEach(() => {
  dispatchMocks.dispatchInboundMessage.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildActiveChatSendDedupeKey", () => {
  const base = {
    attachmentCount: 0,
    explicitDeliverRoute: false,
    originatingChannel: "webchat",
    sessionKey: "main",
  };

  it("produces a stable key for the same internal text send", () => {
    const first = buildActiveChatSendDedupeKey({ ...base, message: "hello there" });
    const second = buildActiveChatSendDedupeKey({ ...base, message: "  hello there  " });
    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it("does not collapse similar-but-distinct messages", () => {
    // Reverse test: near-miss bodies must stay distinct so both get dispatched.
    const keys = ["hello there", "hello there.", "hello  there", "Hello there", "hello there!"].map(
      (message) => buildActiveChatSendDedupeKey({ ...base, message }),
    );
    expect(keys.every((key) => typeof key === "string")).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("scopes the key by session", () => {
    expect(buildActiveChatSendDedupeKey({ ...base, message: "hi" })).not.toBe(
      buildActiveChatSendDedupeKey({ ...base, message: "hi", sessionKey: "other" }),
    );
  });

  it("namespaces the key by system provenance context", () => {
    const plain = buildActiveChatSendDedupeKey({ ...base, message: "status?" });
    const scopedA = buildActiveChatSendDedupeKey({
      ...base,
      message: "status?",
      systemScope: JSON.stringify(["receipt-a", null]),
    });
    const scopedB = buildActiveChatSendDedupeKey({
      ...base,
      message: "status?",
      systemScope: JSON.stringify(["receipt-b", null]),
    });
    expect(plain).toBeTruthy();
    expect(scopedA).not.toBe(plain);
    expect(scopedB).not.toBe(plain);
    expect(scopedA).not.toBe(scopedB);
    // A blank scope must behave exactly like "no scope" rather than minting a
    // third namespace.
    expect(buildActiveChatSendDedupeKey({ ...base, message: "status?", systemScope: "   " })).toBe(
      plain,
    );
  });

  it("namespaces the key by the thinking level", () => {
    // `thinking` rewrites the dispatched body into `/think <level> ...`, so the
    // same text at two levels is two distinct requests and must not collapse.
    const plain = buildActiveChatSendDedupeKey({ ...base, message: "go" });
    const low = buildActiveChatSendDedupeKey({ ...base, message: "go", thinking: "low" });
    const high = buildActiveChatSendDedupeKey({ ...base, message: "go", thinking: "high" });
    expect(new Set([plain, low, high]).size).toBe(3);
    expect(buildActiveChatSendDedupeKey({ ...base, message: "go", thinking: "  " })).toBe(plain);
  });

  it("opts out of dedupe where a repeat send is legitimately a new request", () => {
    expect(buildActiveChatSendDedupeKey({ ...base, message: "" })).toBeNull();
    expect(buildActiveChatSendDedupeKey({ ...base, message: "/compact" })).toBeNull();
    expect(buildActiveChatSendDedupeKey({ ...base, message: "hi", attachmentCount: 1 })).toBeNull();
    expect(
      buildActiveChatSendDedupeKey({ ...base, message: "hi", explicitDeliverRoute: true }),
    ).toBeNull();
    expect(
      buildActiveChatSendDedupeKey({ ...base, message: "hi", originatingChannel: "telegram" }),
    ).toBeNull();
  });
});

describe("chat.send active-run dedupe", () => {
  it("reuses the in-flight run for a duplicate WebChat text send", async () => {
    const context = createChatSendContext();
    const activeRunId = "run-in-flight";
    const key = buildActiveChatSendDedupeKey({
      attachmentCount: 0,
      explicitDeliverRoute: false,
      message: "what is the status?",
      originatingChannel: "webchat",
      sessionKey: "main",
    });
    expect(key).toBeTruthy();
    context.dedupe.set(key!, { ts: Date.now(), ok: true, payload: { runId: activeRunId } });
    context.chatAbortControllers.set(activeRunId, createActiveRun("main"));

    const res = await callChatSend({
      context,
      message: "what is the status?",
      idempotencyKey: "idem-duplicate",
    });

    expect(res).toEqual({
      ok: true,
      payload: { runId: activeRunId, status: "in_flight" },
    });
    expect(dispatchMocks.dispatchInboundMessage).not.toHaveBeenCalled();
  });

  it("still dispatches a similar-but-distinct message while a run is in flight", async () => {
    // Reverse test for the dedupe itself: dropping a real message is worse than
    // dispatching a duplicate, so a near-miss body must start its own run.
    const context = createChatSendContext();
    const activeRunId = "run-in-flight";
    const key = buildActiveChatSendDedupeKey({
      attachmentCount: 0,
      explicitDeliverRoute: false,
      message: "what is the status?",
      originatingChannel: "webchat",
      sessionKey: "main",
    });
    context.dedupe.set(key!, { ts: Date.now(), ok: true, payload: { runId: activeRunId } });
    context.chatAbortControllers.set(activeRunId, createActiveRun("main"));

    const res = await callChatSend({
      context,
      message: "what is the status??",
      idempotencyKey: "idem-distinct",
    });

    expect(res.ok).toBe(true);
    expect(res.payload).toEqual({ runId: "idem-distinct", status: "started" });
    expect(context.chatAbortControllers.has("idem-distinct")).toBe(true);
  });

  it("ignores a stale mapping once the referenced run has finished", async () => {
    // No sticky flag: the dedupe entry outlives the run, but the run is gone
    // from chatAbortControllers, so the resend must dispatch normally.
    const context = createChatSendContext();
    const key = buildActiveChatSendDedupeKey({
      attachmentCount: 0,
      explicitDeliverRoute: false,
      message: "run it again",
      originatingChannel: "webchat",
      sessionKey: "main",
    });
    context.dedupe.set(key!, { ts: Date.now(), ok: true, payload: { runId: "run-finished" } });

    const res = await callChatSend({
      context,
      message: "run it again",
      idempotencyKey: "idem-after-finish",
    });

    expect(res.payload).toEqual({ runId: "idem-after-finish", status: "started" });
  });

  it("records the active-run mapping when a fresh send starts", async () => {
    const context = createChatSendContext();
    const key = buildActiveChatSendDedupeKey({
      attachmentCount: 0,
      explicitDeliverRoute: false,
      message: "first send",
      originatingChannel: "webchat",
      sessionKey: "main",
    });

    const res = await callChatSend({
      context,
      message: "first send",
      idempotencyKey: "idem-first",
    });

    expect(res.payload).toEqual({ runId: "idem-first", status: "started" });
    expect(context.dedupe.get(key!)?.payload).toEqual({ runId: "idem-first" });
  });

  it("still dispatches the same text at a different thinking level", async () => {
    // Reverse test: a legitimately different request must not be swallowed.
    const context = createChatSendContext();
    const activeRunId = "run-in-flight";
    const key = buildActiveChatSendDedupeKey({
      attachmentCount: 0,
      explicitDeliverRoute: false,
      message: "summarize this",
      originatingChannel: "webchat",
      sessionKey: "main",
    });
    context.dedupe.set(key!, { ts: Date.now(), ok: true, payload: { runId: activeRunId } });
    context.chatAbortControllers.set(activeRunId, createActiveRun("main"));

    const res = await callChatSend({
      context,
      message: "summarize this",
      idempotencyKey: "idem-thinking",
      extraParams: { thinking: "high" },
    });

    expect(res.payload).toEqual({ runId: "idem-thinking", status: "started" });
  });

  it("returns the cached outcome when the same key settled during attachment parsing", async () => {
    // The winning request may already have finished and removed its abort
    // controller, so the live-run check alone would let this one dispatch again.
    const context = createChatSendContext();
    const cachedPayload = { runId: "idem-settled", status: "ok" };
    context.dedupe.set("chat:idem-settled", { ts: Date.now(), ok: true, payload: cachedPayload });

    const res = await callChatSend({
      context,
      message: "settled already",
      idempotencyKey: "idem-settled",
    });

    expect(res).toEqual({ ok: true, payload: cachedPayload });
    expect(context.chatAbortControllers.has("idem-settled")).toBe(false);
  });

  it("reports in_flight instead of replacing an existing run for the same key", async () => {
    // Guards the attachment-parse race: the second registration must not
    // detach the first run's abort controller.
    const context = createChatSendContext();
    const existing = createActiveRun("main");
    context.chatAbortControllers.set("idem-race", existing);

    const res = await callChatSend({
      context,
      message: "racing send",
      idempotencyKey: "idem-race",
    });

    expect(res).toEqual({ ok: true, payload: { runId: "idem-race", status: "in_flight" } });
    expect(context.chatAbortControllers.get("idem-race")).toBe(existing);
  });
});
