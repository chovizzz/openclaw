import { describe, expect, it } from "vitest";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { typedCases } from "../../test-utils/typed-cases.js";
import {
  formatOutboundPayloadLog,
  normalizeOutboundPayloads,
  normalizeOutboundPayloadsForJson,
  normalizeReplyPayloadsForDelivery,
} from "./payloads.js";

describe("normalizeReplyPayloadsForDelivery", () => {
  it("parses directives, merges media, and preserves reply metadata", () => {
    expect(
      normalizeReplyPayloadsForDelivery([
        {
          text: "[[reply_to: 123]] Hello [[audio_as_voice]]\nMEDIA:https://x.test/a.png",
          mediaUrl: " https://x.test/a.png ",
          mediaUrls: ["https://x.test/a.png", "https://x.test/b.png"],
          replyToTag: false,
        },
      ]),
    ).toEqual([
      {
        text: "Hello",
        mediaUrl: undefined,
        mediaUrls: ["https://x.test/a.png", "https://x.test/b.png"],
        replyToId: "123",
        replyToTag: true,
        replyToCurrent: false,
        audioAsVoice: true,
      },
    ]);
  });

  it("drops silent payloads without media and suppresses reasoning payloads", () => {
    expect(
      normalizeReplyPayloadsForDelivery([
        { text: "NO_REPLY" },
        { text: "Reasoning:\n_step_", isReasoning: true },
        { text: "final answer" },
      ]),
    ).toEqual([
      {
        text: "final answer",
        mediaUrls: undefined,
        mediaUrl: undefined,
        replyToId: undefined,
        replyToCurrent: false,
        replyToTag: false,
        audioAsVoice: false,
      },
    ]);
  });

  it("suppresses relay status placeholder payloads", () => {
    expect(
      normalizeReplyPayloadsForDelivery([
        { text: "No channel reply." },
        { text: "Replied in-thread." },
        { text: "Replied in #maintainers." },
        {
          text: "Updated [wiki/providers.md](/home/agent/.openclaw/workspace/wiki/providers.md:33). No channel reply.",
        },
        {
          text: "Updated [wiki/tools.md] with the rollback failure-mode nuance. No channel reply.",
        },
      ]),
    ).toEqual([]);
  });

  it("keeps normal payloads that mention wiki without matching relay placeholders", () => {
    const result = normalizeReplyPayloadsForDelivery([
      { text: "Please update wiki/tools.md after this ships." },
      { text: "I replied in #maintainers and then finished the migration." },
      // Near-misses of the relay shape that are real answers: the suppression
      // pattern requires the trailing "No channel reply." marker.
      { text: "Updated [wiki/roadmap.md] with the launch notes." },
      { text: "Updated [wiki/providers.md](/home/agent/workspace/wiki/providers.md:33)." },
    ]);
    // Negative half: prose that merely contains the same words is delivered.
    expect(result.map((entry) => entry.text)).toEqual([
      "Please update wiki/tools.md after this ships.",
      "I replied in #maintainers and then finished the migration.",
      "Updated [wiki/roadmap.md] with the launch notes.",
      "Updated [wiki/providers.md](/home/agent/workspace/wiki/providers.md:33).",
    ]);
  });

  it("stays linear on adversarial relay-shaped input", () => {
    const started = Date.now();
    const hostile = `Updated [${"wiki/".repeat(10_000)}`;
    expect(normalizeReplyPayloadsForDelivery([{ text: hostile }])[0]?.text).toBe(hostile);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("keeps relay status text when it carries media", () => {
    const result = normalizeReplyPayloadsForDelivery([
      { text: "No channel reply.", mediaUrl: "https://example.test/a.png" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.mediaUrl).toBe("https://example.test/a.png");
  });

  it("drops JSON NO_REPLY action payloads without media", () => {
    expect(
      normalizeReplyPayloadsForDelivery([
        { text: '{"action":"NO_REPLY"}' },
        { text: '{\n  "action": "NO_REPLY"\n}' },
      ]),
    ).toEqual([]);
  });

  it("keeps JSON NO_REPLY objects that include extra fields", () => {
    expect(
      normalizeReplyPayloadsForDelivery([{ text: '{"action":"NO_REPLY","note":"example"}' }]),
    ).toEqual([
      {
        text: '{"action":"NO_REPLY","note":"example"}',
        mediaUrls: undefined,
        mediaUrl: undefined,
        replyToId: undefined,
        replyToCurrent: false,
        replyToTag: false,
        audioAsVoice: false,
      },
    ]);
  });

  it("keeps renderable channel-data payloads and reply-to-current markers", () => {
    expect(
      normalizeReplyPayloadsForDelivery([
        {
          text: "[[reply_to_current]]",
          channelData: { line: { flexMessage: { altText: "Card", contents: {} } } },
        },
      ]),
    ).toEqual([
      {
        text: "",
        mediaUrls: undefined,
        mediaUrl: undefined,
        replyToCurrent: true,
        replyToTag: true,
        audioAsVoice: false,
        channelData: { line: { flexMessage: { altText: "Card", contents: {} } } },
      },
    ]);
  });
});

describe("normalizeOutboundPayloadsForJson", () => {
  function cloneReplyPayloads(
    input: Parameters<typeof normalizeOutboundPayloadsForJson>[0],
  ): ReplyPayload[] {
    return input.map((payload) =>
      "mediaUrls" in payload
        ? ({
            ...payload,
            mediaUrls: payload.mediaUrls ? [...payload.mediaUrls] : undefined,
          } as ReplyPayload)
        : ({ ...payload } as ReplyPayload),
    );
  }

  it.each(
    typedCases<{
      name: string;
      input: Parameters<typeof normalizeOutboundPayloadsForJson>[0];
      expected: ReturnType<typeof normalizeOutboundPayloadsForJson>;
    }>([
      {
        name: "text + media variants",
        input: [
          { text: "hi" },
          { text: "photo", mediaUrl: "https://x.test/a.jpg", audioAsVoice: true },
          { text: "multi", mediaUrls: ["https://x.test/1.png"] },
        ],
        expected: [
          {
            text: "hi",
            mediaUrl: null,
            mediaUrls: undefined,
            audioAsVoice: undefined,
            channelData: undefined,
          },
          {
            text: "photo",
            mediaUrl: "https://x.test/a.jpg",
            mediaUrls: ["https://x.test/a.jpg"],
            audioAsVoice: true,
            channelData: undefined,
          },
          {
            text: "multi",
            mediaUrl: null,
            mediaUrls: ["https://x.test/1.png"],
            audioAsVoice: undefined,
            channelData: undefined,
          },
        ],
      },
      {
        name: "MEDIA directive extraction",
        input: [
          {
            text: "MEDIA:https://x.test/a.png\nMEDIA:https://x.test/b.png",
          },
        ],
        expected: [
          {
            text: "",
            mediaUrl: null,
            mediaUrls: ["https://x.test/a.png", "https://x.test/b.png"],
            audioAsVoice: undefined,
            channelData: undefined,
          },
        ],
      },
    ]),
  )("$name", ({ input, expected }) => {
    expect(normalizeOutboundPayloadsForJson(cloneReplyPayloads(input))).toEqual(expected);
  });

  it("suppresses reasoning payloads", () => {
    expect(
      normalizeOutboundPayloadsForJson([
        { text: "Reasoning:\n_step_", isReasoning: true },
        { text: "final answer" },
      ]),
    ).toEqual([
      { text: "final answer", mediaUrl: null, mediaUrls: undefined, audioAsVoice: undefined },
    ]);
  });
});

describe("normalizeOutboundPayloads", () => {
  it("keeps channelData-only payloads", () => {
    const channelData = { line: { flexMessage: { altText: "Card", contents: {} } } };
    expect(normalizeOutboundPayloads([{ channelData }])).toEqual([
      { text: "", mediaUrls: [], channelData },
    ]);
  });

  it("suppresses reasoning payloads", () => {
    expect(
      normalizeOutboundPayloads([
        { text: "Reasoning:\n_step_", isReasoning: true },
        { text: "final answer" },
      ]),
    ).toEqual([{ text: "final answer", mediaUrls: [] }]);
  });

  it("formats BTW replies prominently for external delivery", () => {
    expect(
      normalizeOutboundPayloads([
        {
          text: "323",
          btw: { question: "what is 17 * 19?" },
        },
      ]),
    ).toEqual([{ text: "BTW\nQuestion: what is 17 * 19?\n\n323", mediaUrls: [] }]);
  });
});

describe("formatOutboundPayloadLog", () => {
  it.each(
    typedCases<{
      name: string;
      input: Parameters<typeof formatOutboundPayloadLog>[0];
      expected: string;
    }>([
      {
        name: "text with media lines",
        input: {
          text: "hello  ",
          mediaUrls: ["https://x.test/a.png", "https://x.test/b.png"],
        },
        expected: "hello\nMEDIA:https://x.test/a.png\nMEDIA:https://x.test/b.png",
      },
      {
        name: "media only",
        input: {
          text: "",
          mediaUrls: ["https://x.test/a.png"],
        },
        expected: "MEDIA:https://x.test/a.png",
      },
    ]),
  )("$name", ({ input, expected }) => {
    expect(
      formatOutboundPayloadLog({
        ...input,
        mediaUrls: [...input.mediaUrls],
      }),
    ).toBe(expected);
  });
});
