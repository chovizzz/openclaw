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

  it("tracks media URLs delivered via block replies", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
    });

    expect(pipeline.getSentMediaUrls()).toEqual([]);

    pipeline.enqueue({ text: "caption", mediaUrl: "file:///a.ogg" });
    pipeline.enqueue({ mediaUrls: ["file:///b.ogg", "file:///c.ogg"] });
    await pipeline.flush({ force: true });

    expect(pipeline.getSentMediaUrls()).toEqual([
      "file:///a.ogg",
      "file:///b.ogg",
      "file:///c.ogg",
    ]);
  });

  it("does not track media when text-only blocks are delivered", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
    });

    pipeline.enqueue({ text: "hello" });
    pipeline.enqueue({ text: "world" });
    await pipeline.flush({ force: true });

    expect(pipeline.getSentMediaUrls()).toEqual([]);
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

describe("createBlockReplyPipeline content coverage dedup", () => {
  it("matches final assembled text to successfully streamed text chunks after abort", async () => {
    let callCount = 0;
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {
        callCount += 1;
        if (callCount === 3) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      },
      timeoutMs: 1,
    });

    pipeline.enqueue({ text: "First paragraph." });
    pipeline.enqueue({ text: "Second paragraph." });
    pipeline.enqueue({ text: "Third paragraph." });
    await pipeline.flush({ force: true });

    expect(pipeline.didStream()).toBe(true);
    expect(pipeline.isAborted()).toBe(true);
    expect(pipeline.hasSentPayload({ text: "First paragraph.\n\nSecond paragraph." })).toBe(true);
  });

  it("does not match final assembled text with content that was not streamed", async () => {
    let callCount = 0;
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {
        callCount += 1;
        if (callCount === 2) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      },
      timeoutMs: 1,
    });

    pipeline.enqueue({ text: "First paragraph." });
    pipeline.enqueue({ text: "Second paragraph." });
    await pipeline.flush({ force: true });

    expect(pipeline.didStream()).toBe(true);
    expect(pipeline.isAborted()).toBe(true);
    expect(pipeline.hasSentPayload({ text: "First paragraph.\n\nSecond paragraph." })).toBe(false);
  });

  it("does not suppress media payloads through streamed text coverage", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
    });

    pipeline.enqueue({ text: "Description" });
    await pipeline.flush({ force: true });

    expect(pipeline.hasSentPayload({ text: "Description", mediaUrl: "file:///photo.jpg" })).toBe(
      false,
    );
  });

  it("does not suppress unrelated shorter text that appears inside streamed content", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
    });

    pipeline.enqueue({ text: "Here is a summary." });
    await pipeline.flush({ force: true });

    expect(pipeline.hasSentPayload({ text: "summary" })).toBe(false);
  });

  it("does not suppress a text-covered final that also carries interactive content", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
    });

    // Two fragments so the assembled final only matches through the text-coverage
    // branch, not the exact content key.
    pipeline.enqueue({ text: "pick" });
    pipeline.enqueue({ text: "one" });
    await pipeline.flush({ force: true });

    expect(pipeline.hasSentPayload({ text: "pick one" })).toBe(true);
    expect(
      pipeline.hasSentPayload({
        text: "pick one",
        interactive: { blocks: [{ type: "buttons", buttons: [{ label: "A", value: "a" }] }] },
      } as Parameters<typeof pipeline.hasSentPayload>[0]),
    ).toBe(false);
  });

  it("does not suppress a text-covered final that is an error payload", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
    });

    pipeline.enqueue({ text: "something" });
    pipeline.enqueue({ text: "went wrong" });
    await pipeline.flush({ force: true });

    expect(pipeline.hasSentPayload({ text: "something went wrong" })).toBe(true);
    expect(pipeline.hasSentPayload({ text: "something went wrong", isError: true })).toBe(false);
  });

  it("does not suppress a longer final that extends the streamed text", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
    });

    pipeline.enqueue({ text: "Updated [wiki/roadmap.md]" });
    await pipeline.flush({ force: true });

    expect(
      pipeline.hasSentPayload({ text: "Updated [wiki/roadmap.md] with the launch notes." }),
    ).toBe(false);
  });
});
