import { describe, expect, it } from "vitest";
import type { ReplyPayload } from "../types.js";
import {
  createBlockReplyContentKey,
  createBlockReplyPayloadKey,
  createBlockReplyPipeline,
} from "./block-reply-pipeline.js";

describe("createBlockReplyPayloadKey", () => {
  it("produces different keys for payloads differing only by replyToId", () => {
    const a = createBlockReplyPayloadKey({ text: "hello world", replyToId: "post-1" });
    const b = createBlockReplyPayloadKey({ text: "hello world", replyToId: "post-2" });
    const c = createBlockReplyPayloadKey({ text: "hello world" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("produces different keys for payloads with different text", () => {
    const a = createBlockReplyPayloadKey({ text: "hello" });
    const b = createBlockReplyPayloadKey({ text: "world" });
    expect(a).not.toBe(b);
  });

  it("produces different keys for payloads with different media", () => {
    const a = createBlockReplyPayloadKey({ text: "hello", mediaUrl: "file:///a.png" });
    const b = createBlockReplyPayloadKey({ text: "hello", mediaUrl: "file:///b.png" });
    expect(a).not.toBe(b);
  });

  it("trims whitespace from text for key comparison", () => {
    const a = createBlockReplyPayloadKey({ text: "  hello  " });
    const b = createBlockReplyPayloadKey({ text: "hello" });
    expect(a).toBe(b);
  });
});

describe("createBlockReplyContentKey", () => {
  it("produces the same key for payloads differing only by replyToId", () => {
    const a = createBlockReplyContentKey({ text: "hello world", replyToId: "post-1" });
    const b = createBlockReplyContentKey({ text: "hello world", replyToId: "post-2" });
    const c = createBlockReplyContentKey({ text: "hello world" });
    expect(a).toBe(b);
    expect(a).toBe(c);
  });
});

describe("createBlockReplyPipeline dedup with threading", () => {
  it("keeps separate deliveries for same text with different replyToId", async () => {
    const sent: Array<{ text?: string; replyToId?: string }> = [];
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        sent.push({ text: payload.text, replyToId: payload.replyToId });
      },
      timeoutMs: 5000,
    });

    pipeline.enqueue({ text: "response text", replyToId: "thread-root-1" });
    pipeline.enqueue({ text: "response text", replyToId: undefined });
    await pipeline.flush();

    expect(sent).toEqual([
      { text: "response text", replyToId: "thread-root-1" },
      { text: "response text", replyToId: undefined },
    ]);
  });

  it("hasSentPayload matches regardless of replyToId", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
    });

    pipeline.enqueue({ text: "response text", replyToId: "thread-root-1" });
    await pipeline.flush();

    // Final payload with no replyToId should be recognized as already sent
    expect(pipeline.hasSentPayload({ text: "response text" })).toBe(true);
    expect(pipeline.hasSentPayload({ text: "response text", replyToId: "other-id" })).toBe(true);
  });
});

describe("createBlockReplyPipeline coalescing routing", () => {
  it.each([
    { name: "reply-to-current", routing: { replyToCurrent: true } },
    { name: "explicit-tag", routing: { replyToTag: true } },
  ] as const)("preserves explicit $name routing through coalescing", async ({ routing }) => {
    const sent: ReplyPayload[] = [];
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        sent.push(payload);
      },
      timeoutMs: 5000,
      coalescing: { minChars: 1, maxChars: 200, idleMs: 0, joiner: " " },
    });

    // Regression: the coalescer used to rebuild its flushed payload from a small
    // field allowlist, so explicit routing flags never survived a coalesced block.
    pipeline.enqueue({ text: "Explicit answer", replyToId: "100", ...routing });
    await pipeline.flush({ force: true });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ text: "Explicit answer", replyToId: "100", ...routing });
  });

  it("preserves channel-specific payload data through coalescing", async () => {
    const sent: ReplyPayload[] = [];
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        sent.push(payload);
      },
      timeoutMs: 5000,
      coalescing: { minChars: 1, maxChars: 200, idleMs: 0, joiner: " " },
    });

    pipeline.enqueue({ text: "part one", channelData: { threadTs: "1.0" } });
    pipeline.enqueue({ text: "part two", channelData: { threadTs: "1.0" } });
    await pipeline.flush({ force: true });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      text: "part one part two",
      channelData: { threadTs: "1.0" },
    });
  });
});
