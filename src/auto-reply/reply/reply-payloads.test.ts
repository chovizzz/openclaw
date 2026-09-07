import { describe, expect, it } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { hasSourceRoutedMessagingToolDelivery } from "./reply-payloads-dedupe.js";
import {
  filterMessagingToolMediaDuplicates,
  shouldSuppressMessagingToolReplies,
} from "./reply-payloads.js";

describe("filterMessagingToolMediaDuplicates", () => {
  it("strips mediaUrl when it matches sentMediaUrls", () => {
    const result = filterMessagingToolMediaDuplicates({
      payloads: [{ text: "hello", mediaUrl: "file:///tmp/photo.jpg" }],
      sentMediaUrls: ["file:///tmp/photo.jpg"],
    });
    expect(result).toEqual([{ text: "hello", mediaUrl: undefined, mediaUrls: undefined }]);
  });

  it("preserves mediaUrl when it is not in sentMediaUrls", () => {
    const result = filterMessagingToolMediaDuplicates({
      payloads: [{ text: "hello", mediaUrl: "file:///tmp/photo.jpg" }],
      sentMediaUrls: ["file:///tmp/other.jpg"],
    });
    expect(result).toEqual([{ text: "hello", mediaUrl: "file:///tmp/photo.jpg" }]);
  });

  it("filters matching entries from mediaUrls array", () => {
    const result = filterMessagingToolMediaDuplicates({
      payloads: [
        {
          text: "gallery",
          mediaUrls: ["file:///tmp/a.jpg", "file:///tmp/b.jpg", "file:///tmp/c.jpg"],
        },
      ],
      sentMediaUrls: ["file:///tmp/b.jpg"],
    });
    expect(result).toEqual([
      { text: "gallery", mediaUrls: ["file:///tmp/a.jpg", "file:///tmp/c.jpg"] },
    ]);
  });

  it("clears mediaUrls when all entries match", () => {
    const result = filterMessagingToolMediaDuplicates({
      payloads: [{ text: "gallery", mediaUrls: ["file:///tmp/a.jpg"] }],
      sentMediaUrls: ["file:///tmp/a.jpg"],
    });
    expect(result).toEqual([{ text: "gallery", mediaUrl: undefined, mediaUrls: undefined }]);
  });

  it("returns payloads unchanged when no media present", () => {
    const payloads = [{ text: "plain text" }];
    const result = filterMessagingToolMediaDuplicates({
      payloads,
      sentMediaUrls: ["file:///tmp/photo.jpg"],
    });
    expect(result).toStrictEqual(payloads);
  });

  it("returns payloads unchanged when sentMediaUrls is empty", () => {
    const payloads = [{ text: "hello", mediaUrl: "file:///tmp/photo.jpg" }];
    const result = filterMessagingToolMediaDuplicates({
      payloads,
      sentMediaUrls: [],
    });
    expect(result).toBe(payloads);
  });

  it("dedupes equivalent file and local path variants", () => {
    const result = filterMessagingToolMediaDuplicates({
      payloads: [{ text: "hello", mediaUrl: "/tmp/photo.jpg" }],
      sentMediaUrls: ["file:///tmp/photo.jpg"],
    });
    expect(result).toEqual([{ text: "hello", mediaUrl: undefined, mediaUrls: undefined }]);
  });

  it("dedupes encoded file:// paths against local paths", () => {
    const result = filterMessagingToolMediaDuplicates({
      payloads: [{ text: "hello", mediaUrl: "/tmp/photo one.jpg" }],
      sentMediaUrls: ["file:///tmp/photo%20one.jpg"],
    });
    expect(result).toEqual([{ text: "hello", mediaUrl: undefined, mediaUrls: undefined }]);
  });
});

describe("shouldSuppressMessagingToolReplies", () => {
  const installTelegramSuppressionRegistry = () => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram-plugin",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "telegram",
            outbound: {
              deliveryMode: "direct",
              targetsMatchForReplySuppression: ({ originTarget, targetKey, targetThreadId }) => {
                const baseTarget = (value: string) =>
                  value
                    .replace(/^telegram:(group|channel):/u, "")
                    .replace(/^telegram:/u, "")
                    .replace(/:topic:.*$/u, "");
                const originTopic = originTarget.match(/:topic:([^:]+)$/u)?.[1];
                return (
                  baseTarget(originTarget) === baseTarget(targetKey) &&
                  (originTopic === undefined || originTopic === targetThreadId)
                );
              },
            },
          }),
        },
      ]),
    );
  };

  it("suppresses when target provider is missing but target matches current provider route", () => {
    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: "telegram",
        originatingTo: "123",
        messagingToolSentTargets: [{ tool: "message", provider: "", to: "123" }],
      }),
    ).toBe(true);
  });

  it('suppresses when target provider uses "message" placeholder and target matches', () => {
    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: "telegram",
        originatingTo: "123",
        messagingToolSentTargets: [{ tool: "message", provider: "message", to: "123" }],
      }),
    ).toBe(true);
  });

  it("does not suppress when providerless target does not match origin route", () => {
    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: "telegram",
        originatingTo: "123",
        messagingToolSentTargets: [{ tool: "message", provider: "", to: "456" }],
      }),
    ).toBe(false);
  });

  it("suppresses telegram topic-origin replies when explicit threadId matches", () => {
    installTelegramSuppressionRegistry();
    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: "telegram",
        originatingTo: "telegram:group:-100123:topic:77",
        messagingToolSentTargets: [
          { tool: "message", provider: "telegram", to: "-100123", threadId: "77" },
        ],
      }),
    ).toBe(true);
  });

  it("does not suppress telegram topic-origin replies when explicit threadId differs", () => {
    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: "telegram",
        originatingTo: "telegram:group:-100123:topic:77",
        messagingToolSentTargets: [
          { tool: "message", provider: "telegram", to: "-100123", threadId: "88" },
        ],
      }),
    ).toBe(false);
  });

  it("does not suppress telegram topic-origin replies when target omits topic metadata", () => {
    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: "telegram",
        originatingTo: "telegram:group:-100123:topic:77",
        messagingToolSentTargets: [{ tool: "message", provider: "telegram", to: "-100123" }],
      }),
    ).toBe(false);
  });

  it("suppresses telegram replies when chatId matches but target forms differ", () => {
    installTelegramSuppressionRegistry();
    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: "telegram",
        originatingTo: "telegram:group:-100123",
        messagingToolSentTargets: [{ tool: "message", provider: "telegram", to: "-100123" }],
      }),
    ).toBe(true);
  });

  it("uses generic route matching when the active plugin registry omits telegram", () => {
    // Dedupe must not load the bundled channel module to obtain a matcher: an
    // unregistered plugin falls through to plain target comparison.
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createTestRegistry([]));

    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: "telegram",
        originatingTo: "telegram:group:-100123:topic:77",
        messagingToolSentTargets: [
          { tool: "message", provider: "telegram", to: "-100123", threadId: "77" },
        ],
      }),
    ).toBe(false);
  });

  it("preserves string thread ids before plugin reply-suppression matching", () => {
    // 9007199254740993 is not representable as a double: a parseInt round-trip
    // turns it into ...992 and would match the wrong topic.
    installTelegramSuppressionRegistry();
    const largeThreadId = "9007199254740993";

    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: "telegram",
        originatingTo: `telegram:group:-100123:topic:${largeThreadId}`,
        messagingToolSentTargets: [
          { tool: "message", provider: "telegram", to: "-100123", threadId: largeThreadId },
        ],
      }),
    ).toBe(true);
  });

  it("does not collapse distinct thread ids that differ beyond double precision", () => {
    installTelegramSuppressionRegistry();

    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: "telegram",
        originatingTo: "telegram:group:-100123:topic:9007199254740993",
        messagingToolSentTargets: [
          { tool: "message", provider: "telegram", to: "-100123", threadId: "9007199254740992" },
        ],
      }),
    ).toBe(false);
  });
});

describe("hasSourceRoutedMessagingToolDelivery", () => {
  it("attests delivery when the sent target matches the source route and carried text", () => {
    expect(
      hasSourceRoutedMessagingToolDelivery({
        messageProvider: "telegram",
        originatingTo: "123",
        messagingToolSentTargets: [{ tool: "message", provider: "telegram", to: "123" }],
        messagingToolSentTexts: ["hello there"],
      }),
    ).toBe(true);
  });

  it("attests delivery from aggregate media evidence when the route matches", () => {
    expect(
      hasSourceRoutedMessagingToolDelivery({
        messageProvider: "telegram",
        originatingTo: "123",
        messagingToolSentTargets: [{ tool: "message", provider: "telegram", to: "123" }],
        messagingToolSentMediaUrls: ["file:///tmp/photo.jpg"],
      }),
    ).toBe(true);
  });

  it("does not attest delivery for an unrelated-target send even with sent content", () => {
    // The reply text was clearly sent somewhere, but not to the source
    // conversation - a genuinely silent source conversation must still be
    // free to fall back to the no-visible-reply notice.
    expect(
      hasSourceRoutedMessagingToolDelivery({
        messageProvider: "telegram",
        originatingTo: "123",
        messagingToolSentTargets: [{ tool: "message", provider: "telegram", to: "456" }],
        messagingToolSentTexts: ["hello there"],
      }),
    ).toBe(false);
  });

  it("does not attest delivery when routing cannot be determined at all", () => {
    // No messageProvider and no sent targets: routing is simply unknown. This
    // must default to "not attested" rather than guessing, per the same
    // lose-content-is-worse-than-a-duplicate contract as suppression: an
    // under-attestation only risks an extra fallback notice, while an
    // over-attestation could hide a turn that never actually replied.
    expect(
      hasSourceRoutedMessagingToolDelivery({
        originatingTo: "123",
        messagingToolSentTexts: ["hello there"],
      }),
    ).toBe(false);
  });

  it("does not attest delivery when the route matches but nothing was actually sent", () => {
    expect(
      hasSourceRoutedMessagingToolDelivery({
        messageProvider: "telegram",
        originatingTo: "123",
        messagingToolSentTargets: [{ tool: "message", provider: "telegram", to: "123" }],
      }),
    ).toBe(false);
  });

  it("does not attest delivery when the aggregate text is blank/whitespace-only", () => {
    // A blank string surviving in the sent-texts list is not evidence that
    // anything was actually delivered.
    expect(
      hasSourceRoutedMessagingToolDelivery({
        messageProvider: "telegram",
        originatingTo: "123",
        messagingToolSentTargets: [{ tool: "message", provider: "telegram", to: "123" }],
        messagingToolSentTexts: ["   \n\t "],
        messagingToolSentMediaUrls: [""],
      }),
    ).toBe(false);
  });

  it("still attests delivery when only one of several sent texts is non-blank", () => {
    expect(
      hasSourceRoutedMessagingToolDelivery({
        messageProvider: "telegram",
        originatingTo: "123",
        messagingToolSentTargets: [{ tool: "message", provider: "telegram", to: "123" }],
        messagingToolSentTexts: ["", "actual reply text"],
      }),
    ).toBe(true);
  });

  it("known limitation: aggregate content from an unrelated send can attest a contentless source-routed send", () => {
    // MessagingToolSend only records target identity, not per-target sent
    // text/media, so a turn that sends via the messaging tool to BOTH the
    // source conversation (with no content of its own) and an unrelated
    // target (which does carry content) cannot distinguish which target the
    // aggregate text belongs to. This is a documented tradeoff, not a
    // regression: the alternative (never attesting without per-target
    // evidence) would reintroduce the original bug for the common
    // single-target case.
    expect(
      hasSourceRoutedMessagingToolDelivery({
        messageProvider: "telegram",
        originatingTo: "123",
        messagingToolSentTargets: [
          { tool: "message", provider: "telegram", to: "123" },
          { tool: "message", provider: "telegram", to: "456" },
        ],
        messagingToolSentTexts: ["reply that actually went to 456"],
      }),
    ).toBe(true);
  });

  it("attests delivery when the origin account is unset but the target account is set", () => {
    // Partial routing metadata (only one side specifies accountId) must not
    // be treated as a mismatch - shouldSuppressMessagingToolReplies only
    // rejects when BOTH sides specify an account and they differ.
    expect(
      hasSourceRoutedMessagingToolDelivery({
        messageProvider: "telegram",
        originatingTo: "123",
        messagingToolSentTargets: [
          { tool: "message", provider: "telegram", to: "123", accountId: "acct-1" },
        ],
        messagingToolSentTexts: ["hello there"],
      }),
    ).toBe(true);
  });
});
