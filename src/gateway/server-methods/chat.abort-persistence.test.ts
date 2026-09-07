import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";

type TranscriptLine = {
  message?: Record<string, unknown>;
};

const sessionEntryState = vi.hoisted(() => ({
  transcriptPath: "",
  sessionId: "",
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

const { chatHandlers } = await import("./chat.js");

async function writeTranscriptHeader(transcriptPath: string, sessionId: string) {
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp: new Date(0).toISOString(),
    cwd: "/tmp",
  };
  await fs.writeFile(transcriptPath, `${JSON.stringify(header)}\n`, "utf-8");
}

async function readTranscriptLines(transcriptPath: string): Promise<TranscriptLine[]> {
  const raw = await fs.readFile(transcriptPath, "utf-8");
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as TranscriptLine;
      } catch {
        return {};
      }
    });
}

/**
 * Seed a user transcript record carrying `idempotencyKey`.
 *
 * Written as raw JSONL on purpose: SessionManager drops unknown fields from
 * user messages, and this fixture exists precisely to reproduce a foreign
 * (non-assistant) record that already holds the key the assistant append is
 * about to use.
 */
async function seedUserRecordWithIdempotencyKey(
  transcriptPath: string,
  idempotencyKey: string,
): Promise<void> {
  const record = {
    type: "message",
    id: "seed-user-record",
    parentId: null,
    timestamp: new Date(0).toISOString(),
    message: {
      role: "user",
      content: [{ type: "text", text: "echo please" }],
      idempotencyKey,
      timestamp: 0,
    },
  };
  await fs.appendFile(transcriptPath, `${JSON.stringify(record)}\n`, "utf-8");
}

function setMockSessionEntry(transcriptPath: string, sessionId: string) {
  sessionEntryState.transcriptPath = transcriptPath;
  sessionEntryState.sessionId = sessionId;
}

async function createTranscriptFixture(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const sessionId = "sess-main";
  const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
  await writeTranscriptHeader(transcriptPath, sessionId);
  setMockSessionEntry(transcriptPath, sessionId);
  return { transcriptPath, sessionId };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chat abort transcript persistence", () => {
  it("persists run-scoped abort partial with rpc metadata and idempotency", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture("openclaw-chat-abort-run-");
    const runId = "idem-abort-run-1";
    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([[runId, createActiveRun("main", { sessionId })]]),
      chatRunBuffers: new Map([[runId, "Partial from run abort"]]),
      chatDeltaSentAt: new Map([[runId, Date.now()]]),
      removeChatRun: vi
        .fn()
        .mockReturnValue({ sessionKey: "main", clientRunId: "client-idem-abort-run-1" }),
      agentRunSeq: new Map<string, number>([
        [runId, 2],
        ["client-idem-abort-run-1", 3],
      ]),
      broadcast: vi.fn(),
      nodeSendToSession: vi.fn(),
      logGateway: { warn: vi.fn() },
    });

    await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context,
      request: { sessionKey: "main", runId },
      respond,
    });

    const [ok1, payload1] = respond.mock.calls.at(-1) ?? [];
    expect(ok1).toBe(true);
    expect(payload1).toMatchObject({ aborted: true, runIds: [runId] });

    context.chatAbortControllers.set(runId, createActiveRun("main", { sessionId }));
    context.chatRunBuffers.set(runId, "Partial from run abort");
    context.chatDeltaSentAt.set(runId, Date.now());

    await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context,
      request: { sessionKey: "main", runId },
      respond,
    });

    const lines = await readTranscriptLines(transcriptPath);
    const persisted = lines
      .map((line) => line.message)
      .filter(
        (message): message is Record<string, unknown> =>
          Boolean(message) && message?.idempotencyKey === `${runId}:assistant`,
      );

    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      stopReason: "stop",
      idempotencyKey: `${runId}:assistant`,
      openclawAbort: {
        aborted: true,
        origin: "rpc",
        runId,
      },
    });
  });

  it("persists session-scoped abort partials with rpc metadata", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture(
      "openclaw-chat-abort-session-",
    );
    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([
        ["run-a", createActiveRun("main", { sessionId })],
        ["run-b", createActiveRun("main", { sessionId })],
      ]),
      chatRunBuffers: new Map([
        ["run-a", "Session abort partial"],
        ["run-b", "   "],
      ]),
      chatDeltaSentAt: new Map([
        ["run-a", Date.now()],
        ["run-b", Date.now()],
      ]),
    });

    await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context,
      request: { sessionKey: "main" },
      respond,
    });

    const [ok, payload] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ aborted: true });
    expect(payload.runIds).toEqual(expect.arrayContaining(["run-a", "run-b"]));

    const lines = await readTranscriptLines(transcriptPath);
    const runAPersisted = lines
      .map((line) => line.message)
      .find((message) => message?.idempotencyKey === "run-a:assistant");
    const runBPersisted = lines
      .map((line) => line.message)
      .find((message) => message?.idempotencyKey === "run-b:assistant");

    expect(runAPersisted).toMatchObject({
      idempotencyKey: "run-a:assistant",
      openclawAbort: {
        aborted: true,
        origin: "rpc",
        runId: "run-a",
      },
    });
    expect(runBPersisted).toBeUndefined();
  });

  it("persists /stop partials with stop-command metadata", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture("openclaw-chat-stop-");
    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([["run-stop-1", createActiveRun("main", { sessionId })]]),
      chatRunBuffers: new Map([["run-stop-1", "Partial from /stop"]]),
      chatDeltaSentAt: new Map([["run-stop-1", Date.now()]]),
      removeChatRun: vi.fn().mockReturnValue({ sessionKey: "main", clientRunId: "client-stop-1" }),
      agentRunSeq: new Map<string, number>([["run-stop-1", 1]]),
      dedupe: {
        get: vi.fn(),
      },
    });

    await chatHandlers["chat.send"]({
      params: {
        sessionKey: "main",
        message: "/stop",
        idempotencyKey: "idem-stop-req",
      },
      respond,
      context: context as never,
      req: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });

    const [ok, payload] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ aborted: true, runIds: ["run-stop-1"] });

    const lines = await readTranscriptLines(transcriptPath);
    const persisted = lines
      .map((line) => line.message)
      .find((message) => message?.idempotencyKey === "run-stop-1:assistant");

    expect(persisted).toMatchObject({
      idempotencyKey: "run-stop-1:assistant",
      openclawAbort: {
        aborted: true,
        origin: "stop-command",
        runId: "run-stop-1",
      },
    });
  });

  it("skips run-scoped transcript persistence when partial text is blank", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture(
      "openclaw-chat-abort-run-blank-",
    );
    const runId = "idem-abort-run-blank";
    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([[runId, createActiveRun("main", { sessionId })]]),
      chatRunBuffers: new Map([[runId, "  \n\t  "]]),
      chatDeltaSentAt: new Map([[runId, Date.now()]]),
    });

    await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context,
      request: { sessionKey: "main", runId },
      respond,
    });

    const [ok, payload] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ aborted: true, runIds: [runId] });

    const lines = await readTranscriptLines(transcriptPath);
    const persisted = lines
      .map((line) => line.message)
      .find((message) => message?.idempotencyKey === `${runId}:assistant`);
    expect(persisted).toBeUndefined();
  });
  it("still persists the assistant partial when a non-assistant entry reuses the key", async () => {
    // Reverse test for narrowing the idempotency scope to assistant messages:
    // a user entry carrying the same key used to make the guard report
    // "already written", and the assistant partial was dropped entirely.
    const { transcriptPath, sessionId } = await createTranscriptFixture(
      "openclaw-chat-abort-run-scope-",
    );
    const runId = "idem-abort-run-scope";
    await seedUserRecordWithIdempotencyKey(transcriptPath, `${runId}:assistant`);

    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([[runId, createActiveRun("main", { sessionId })]]),
      chatRunBuffers: new Map([[runId, "Partial that must survive"]]),
      chatDeltaSentAt: new Map([[runId, Date.now()]]),
    });

    await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context,
      request: { sessionKey: "main", runId },
      respond,
    });

    const lines = await readTranscriptLines(transcriptPath);
    const matching = lines
      .map((line) => line.message)
      .filter(
        (message): message is Record<string, unknown> =>
          Boolean(message) && message?.idempotencyKey === `${runId}:assistant`,
      );
    const assistantEntries = matching.filter((message) => message.role === "assistant");
    expect(matching).toHaveLength(2);
    expect(assistantEntries).toHaveLength(1);
    expect(assistantEntries[0]).toMatchObject({ role: "assistant" });
  });

  it("does not append the assistant partial twice for the same key", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture(
      "openclaw-chat-abort-run-repeat-",
    );
    const runId = "idem-abort-run-repeat";
    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([[runId, createActiveRun("main", { sessionId })]]),
      chatRunBuffers: new Map([[runId, "Partial once"]]),
      chatDeltaSentAt: new Map([[runId, Date.now()]]),
    });

    await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context,
      request: { sessionKey: "main", runId },
      respond,
    });

    context.chatAbortControllers.set(runId, createActiveRun("main", { sessionId }));
    context.chatRunBuffers.set(runId, "Partial once");
    context.chatDeltaSentAt.set(runId, Date.now());

    await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"],
      context,
      request: { sessionKey: "main", runId },
      respond,
    });

    const lines = await readTranscriptLines(transcriptPath);
    const assistantEntries = lines
      .map((line) => line.message)
      .filter(
        (message): message is Record<string, unknown> =>
          Boolean(message) &&
          message?.role === "assistant" &&
          message?.idempotencyKey === `${runId}:assistant`,
      );
    expect(assistantEntries).toHaveLength(1);
  });
});
