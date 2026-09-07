import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveFollowupDeliveryPayloads } from "./followup-delivery.js";

const baseConfig = {} as OpenClawConfig;

describe("resolveFollowupDeliveryPayloads", () => {
  it("drops heartbeat ack payloads without media", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "HEARTBEAT_OK" }],
      }),
    ).toEqual([]);
  });

  it("keeps media payloads when stripping heartbeat ack text", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "HEARTBEAT_OK", mediaUrl: "/tmp/image.png" }],
      }),
    ).toEqual([{ text: "", mediaUrl: "/tmp/image.png" }]);
  });

  it("drops text payloads already sent via messaging tool", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        sentTexts: ["hello world!"],
      }),
    ).toEqual([]);
  });

  it("drops media payloads already sent via messaging tool", () => {
    // Stripping the already-sent URL leaves nothing renderable, so the payload
    // is dropped outright. It used to survive as an empty object because reply
    // threading (which filters non-renderable payloads) ran before the media
    // dedupe; the caller then saw length 1 and tried to deliver an empty message.
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ mediaUrl: "/tmp/img.png" }],
        sentMediaUrls: ["/tmp/img.png"],
      }),
    ).toEqual([]);
  });

  it("suppresses replies when a messaging tool already sent to the same provider and target", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        messageProvider: "slack",
        originatingTo: "channel:C1",
        sentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      }),
    ).toEqual([]);
  });

  it("suppresses replies when originating channel resolves the provider", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        messageProvider: "heartbeat",
        originatingChannel: "telegram",
        originatingTo: "268300329",
        sentTargets: [{ tool: "telegram", provider: "telegram", to: "268300329" }],
      }),
    ).toEqual([]);
  });

  it("does not suppress replies when account differs", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        messageProvider: "heartbeat",
        originatingChannel: "telegram",
        originatingTo: "268300329",
        originatingAccountId: "personal",
        sentTargets: [
          { tool: "telegram", provider: "telegram", to: "268300329", accountId: "work" },
        ],
      }),
    ).toEqual([{ text: "hello world!" }]);
  });

  it("keeps the reply-to slot for the payload that survives dedupe", () => {
    // replyToMode=first hands out a single reply-to slot. Threading used to run
    // before dedupe, so a payload that was about to be dropped as a
    // messaging-tool duplicate consumed the slot and the surviving reply went
    // out unthreaded.
    const cfg = {
      channels: { telegram: { replyToMode: "first" } },
    } as unknown as OpenClawConfig;

    const result = resolveFollowupDeliveryPayloads({
      cfg,
      payloads: [
        { text: "already sent by the messaging tool", replyToId: "m-1" },
        { text: "the real answer", replyToId: "m-1" },
      ],
      messageProvider: "telegram",
      originatingChannel: "telegram",
      originatingTo: "268300329",
      sentTexts: ["already sent by the messaging tool"],
    });

    expect(result).toEqual([{ text: "the real answer", replyToId: "m-1" }]);
  });
});
