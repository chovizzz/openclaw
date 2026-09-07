import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { MessagingToolSend } from "../../agents/pi-embedded-runner.js";
import type { OpenClawConfig } from "../../config/config.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import {
  resolveOriginAccountId,
  resolveOriginMessageProvider,
  resolveOriginMessageTo,
} from "./origin-routing.js";
import {
  applyReplyThreading,
  filterMessagingToolDuplicates,
  filterMessagingToolMediaDuplicates,
  shouldSuppressMessagingToolReplies,
} from "./reply-payloads.js";
import { resolveReplyToMode } from "./reply-threading.js";

export function resolveFollowupDeliveryPayloads(params: {
  cfg: OpenClawConfig;
  payloads: ReplyPayload[];
  messageProvider?: string;
  originatingAccountId?: string;
  originatingChannel?: string;
  originatingChatType?: string | null;
  originatingTo?: string;
  sentMediaUrls?: string[];
  sentTargets?: MessagingToolSend[];
  sentTexts?: string[];
}): ReplyPayload[] {
  const replyToChannel = resolveOriginMessageProvider({
    originatingChannel: params.originatingChannel,
    provider: params.messageProvider,
  }) as OriginatingChannelType | undefined;
  const replyToMode = resolveReplyToMode(
    params.cfg,
    replyToChannel,
    params.originatingAccountId,
    params.originatingChatType,
  );
  const sanitizedPayloads = params.payloads.flatMap((payload) => {
    const text = payload.text;
    if (!text || !text.includes("HEARTBEAT_OK")) {
      return [payload];
    }
    const stripped = stripHeartbeatToken(text, { mode: "message" });
    const hasMedia = resolveSendableOutboundReplyParts(payload).hasMedia;
    if (stripped.shouldSkip && !hasMedia) {
      return [];
    }
    return [{ ...payload, text: stripped.text }];
  });
  // Media dedupe first: the text dedupe below keeps a text-duplicate payload
  // alive only when it still carries unsent content, so already-sent media must
  // be stripped before that check runs.
  const mediaFilteredPayloads = filterMessagingToolMediaDuplicates({
    payloads: sanitizedPayloads,
    sentMediaUrls: params.sentMediaUrls ?? [],
  });
  const dedupedPayloads = filterMessagingToolDuplicates({
    payloads: mediaFilteredPayloads,
    sentTexts: params.sentTexts ?? [],
  });
  // Thread only what actually survives dedupe. replyToMode=first|batched hands
  // out a single reply-to slot, so threading before dedupe let a payload that
  // was about to be dropped consume the slot and leave the surviving reply
  // unthreaded. Neither dedupe stage reads the threading fields, so deferring
  // this is safe.
  const replyTaggedPayloads = applyReplyThreading({
    payloads: dedupedPayloads,
    replyToMode,
    replyToChannel,
  });
  const suppressMessagingToolReplies = shouldSuppressMessagingToolReplies({
    messageProvider: replyToChannel,
    messagingToolSentTargets: params.sentTargets,
    originatingTo: resolveOriginMessageTo({
      originatingTo: params.originatingTo,
    }),
    accountId: resolveOriginAccountId({
      originatingAccountId: params.originatingAccountId,
    }),
  });
  return suppressMessagingToolReplies ? [] : replyTaggedPayloads;
}
