import { describe, expect, it } from "vitest";
import type { FeishuMessageEvent } from "./bot.js";
import { resolveFeishuDedupeId } from "./dedup.js";

function makeEvent(overrides?: {
  messageId?: string;
  messageType?: string;
  chatId?: string;
  createTime?: string;
  content?: string;
  openId?: string;
}): FeishuMessageEvent {
  return {
    sender: {
      sender_id: { open_id: overrides?.openId ?? "ou_sender" },
      sender_type: "user",
    },
    message: {
      message_id: overrides?.messageId ?? "om_default",
      chat_id: overrides?.chatId ?? "oc_chat",
      chat_type: "p2p",
      message_type: overrides?.messageType ?? "text",
      content: overrides?.content ?? JSON.stringify({ text: "hello" }),
      create_time: overrides?.createTime ?? "1700000000000",
    },
  };
}

describe("resolveFeishuDedupeId", () => {
  it("gives redeliveries of the same text a stable id despite fresh message_ids", () => {
    const first = resolveFeishuDedupeId(makeEvent({ messageId: "om_first" }));
    const redelivered = resolveFeishuDedupeId(makeEvent({ messageId: "om_second" }));

    expect(first).toBe(redelivered);
    expect(first).not.toBe("om_first");
  });

  it("keeps a genuine resend (new create_time) distinct so it is not suppressed", () => {
    const original = resolveFeishuDedupeId(makeEvent({ createTime: "1700000000000" }));
    const resend = resolveFeishuDedupeId(makeEvent({ createTime: "1700000005000" }));

    expect(original).not.toBe(resend);
  });

  it("distinguishes different content at the same timestamp", () => {
    const a = resolveFeishuDedupeId(makeEvent({ content: JSON.stringify({ text: "yes" }) }));
    const b = resolveFeishuDedupeId(makeEvent({ content: JSON.stringify({ text: "no" }) }));

    expect(a).not.toBe(b);
  });

  it("falls back to message_id when create_time is missing", () => {
    const event = makeEvent({ messageId: "om_no_time", createTime: undefined });
    event.message.create_time = undefined;

    expect(resolveFeishuDedupeId(event)).toBe("om_no_time");
  });

  it("falls back to message_id for non-text messages", () => {
    const event = resolveFeishuDedupeId(makeEvent({ messageId: "om_media", messageType: "image" }));

    expect(event).toBe("om_media");
  });

  it("falls back to message_id when the sender identity is unavailable", () => {
    const event = makeEvent({ messageId: "om_no_sender" });
    event.sender.sender_id = {};

    expect(resolveFeishuDedupeId(event)).toBe("om_no_sender");
  });

  it("uses union_id then user_id when open_id is absent", () => {
    const base = makeEvent({ messageId: "om_a" });
    base.sender.sender_id = { union_id: "on_union" };
    const other = makeEvent({ messageId: "om_b" });
    other.sender.sender_id = { union_id: "on_union" };

    expect(resolveFeishuDedupeId(base)).toBe(resolveFeishuDedupeId(other));
  });
});
