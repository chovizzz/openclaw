import { isMessagingToolDuplicate } from "../../agents/pi-embedded-helpers.js";
import type { MessagingToolSend } from "../../agents/pi-embedded-runner.js";
import { getLoadedChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { normalizeTargetForProvider } from "../../infra/outbound/target-normalization.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import { normalizeOptionalAccountId } from "../../routing/account-id.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import type { ReplyPayload } from "../types.js";

/**
 * Removes payloads whose text a messaging tool already sent.
 *
 * A duplicate text is not on its own a reason to drop the whole payload: the
 * same payload can still carry media, interactive controls, or channel-specific
 * content that was never delivered. Dropping it there silently loses that
 * content, so a text duplicate is only removed when nothing else is left to
 * send. Run this after media dedupe so already-sent media is not mistaken for
 * unsent content.
 */
export function filterMessagingToolDuplicates(params: {
  payloads: ReplyPayload[];
  sentTexts: string[];
}): ReplyPayload[] {
  const { payloads, sentTexts } = params;
  if (sentTexts.length === 0) {
    return payloads;
  }
  return payloads.filter(
    (payload) =>
      !isMessagingToolDuplicate(payload.text ?? "", sentTexts) ||
      hasReplyPayloadContent({ ...payload, text: undefined }),
  );
}

export function filterMessagingToolMediaDuplicates(params: {
  payloads: ReplyPayload[];
  sentMediaUrls: string[];
}): ReplyPayload[] {
  const normalizeMediaForDedupe = (value: string): string => {
    const trimmed = value.trim();
    if (!trimmed) {
      return "";
    }
    if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith("file://")) {
      return trimmed;
    }
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === "file:") {
        return decodeURIComponent(parsed.pathname || "");
      }
    } catch {
      // Keep fallback below for non-URL-like inputs.
    }
    return trimmed.replace(/^file:\/\//i, "");
  };

  const { payloads, sentMediaUrls } = params;
  if (sentMediaUrls.length === 0) {
    return payloads;
  }
  const sentSet = new Set(sentMediaUrls.map(normalizeMediaForDedupe).filter(Boolean));
  return payloads.map((payload) => {
    const mediaUrl = payload.mediaUrl;
    const mediaUrls = payload.mediaUrls;
    const stripSingle = mediaUrl && sentSet.has(normalizeMediaForDedupe(mediaUrl));
    const filteredUrls = mediaUrls?.filter((u) => !sentSet.has(normalizeMediaForDedupe(u)));
    if (!stripSingle && (!mediaUrls || filteredUrls?.length === mediaUrls.length)) {
      return payload;
    }
    return {
      ...payload,
      mediaUrl: stripSingle ? undefined : mediaUrl,
      mediaUrls: filteredUrls?.length ? filteredUrls : undefined,
    };
  });
}

function normalizeProviderForComparison(value?: string): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
  const normalizedChannel = normalizeChannelId(trimmed);
  if (normalizedChannel) {
    return normalizedChannel;
  }
  return lowered;
}

function normalizeThreadIdForComparison(value?: string): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  // Keep the id as a string. Round-tripping numeric-looking ids through
  // Number.parseInt silently loses precision past 2^53, so two distinct topic
  // ids could collapse to the same value and suppress a reply that belonged to
  // a different thread.
  return normalizeLowercaseStringOrEmpty(trimmed);
}

function resolveTargetProviderForComparison(params: {
  currentProvider: string;
  targetProvider?: string;
}): string {
  const targetProvider = normalizeProviderForComparison(params.targetProvider);
  if (!targetProvider || targetProvider === "message") {
    return params.currentProvider;
  }
  return targetProvider;
}

function targetsMatchForSuppression(params: {
  provider: string;
  originTarget: string;
  targetKey: string;
  targetThreadId?: string;
}): boolean {
  // Read-only lookup on purpose: getChannelPlugin falls back to loading the
  // bundled channel module, and this runs on the reply hot path where a plugin
  // that is not already registered should simply fall through to generic route
  // matching rather than drag a channel implementation into the process.
  const pluginMatch = getLoadedChannelPlugin(params.provider)?.outbound
    ?.targetsMatchForReplySuppression;
  if (pluginMatch) {
    return pluginMatch({
      originTarget: params.originTarget,
      targetKey: params.targetKey,
      targetThreadId: normalizeThreadIdForComparison(params.targetThreadId),
    });
  }
  return params.targetKey === params.originTarget;
}

export function shouldSuppressMessagingToolReplies(params: {
  messageProvider?: string;
  messagingToolSentTargets?: MessagingToolSend[];
  originatingTo?: string;
  accountId?: string;
}): boolean {
  const provider = normalizeProviderForComparison(params.messageProvider);
  if (!provider) {
    return false;
  }
  const originTarget = normalizeTargetForProvider(provider, params.originatingTo);
  if (!originTarget) {
    return false;
  }
  const originAccount = normalizeOptionalAccountId(params.accountId);
  const sentTargets = params.messagingToolSentTargets ?? [];
  if (sentTargets.length === 0) {
    return false;
  }
  return sentTargets.some((target) => {
    const targetProvider = resolveTargetProviderForComparison({
      currentProvider: provider,
      targetProvider: target?.provider,
    });
    if (targetProvider !== provider) {
      return false;
    }
    const targetKey = normalizeTargetForProvider(targetProvider, target.to);
    if (!targetKey) {
      return false;
    }
    const targetAccount = normalizeOptionalAccountId(target.accountId);
    if (originAccount && targetAccount && originAccount !== targetAccount) {
      return false;
    }
    return targetsMatchForSuppression({
      provider,
      originTarget,
      targetKey,
      targetThreadId: target.threadId,
    });
  });
}

/**
 * True when a messaging-tool send visibly delivered to the *source*
 * conversation (the same route `shouldSuppressMessagingToolReplies` matches
 * against). Used to attest observed delivery for automatic-mode turns that
 * answered entirely via the message tool: without this, a message-tool reply
 * to the source conversation followed by no further final text still draws
 * the no-visible-reply fallback into that conversation.
 *
 * Route matching is what keeps a send to an unrelated target (a different
 * chat, a different provider) from counting as "the reply was delivered
 * here". A false negative here (treating a real source-routed delivery as
 * unattested) only costs a duplicate fallback notice; a false positive
 * (crediting an unrelated-target send as the source reply) would hide a
 * conversation that genuinely got no reply. So when routing itself cannot be
 * determined, this returns false (do not attest) rather than guessing - losing
 * an attestation is recoverable (worst case: an extra fallback line), losing
 * visibility into a truly silent turn is not.
 *
 * This repo's `MessagingToolSend` records only target identity (provider/to/
 * thread/account), not per-target sent text or media, so there is no
 * per-route content evidence to check the way upstream's richer dedupe
 * decision object does. The route match itself already implies a send
 * happened at that target; requiring non-blank aggregate sent text/media is
 * the closest available equivalent to "that send actually carried content".
 * Known limitation inherited from that aggregate shape: when a single turn
 * sends via the messaging tool to *both* the source conversation and an
 * unrelated target, the aggregate text/media cannot be attributed back to a
 * specific target, so a source-routed send with no content of its own can
 * still be attested off of content that actually went elsewhere. This also
 * inherits `shouldSuppressMessagingToolReplies`'s existing route-matching
 * semantics as-is (for example a missing/`"message"`-placeholder target
 * provider defaults to the current provider) - this function does not add or
 * remove any routing leniency of its own.
 */
export function hasSourceRoutedMessagingToolDelivery(params: {
  messageProvider?: string;
  messagingToolSentTargets?: MessagingToolSend[];
  messagingToolSentTexts?: string[];
  messagingToolSentMediaUrls?: string[];
  originatingTo?: string;
  accountId?: string;
}): boolean {
  if (
    !shouldSuppressMessagingToolReplies({
      messageProvider: params.messageProvider,
      messagingToolSentTargets: params.messagingToolSentTargets,
      originatingTo: params.originatingTo,
      accountId: params.accountId,
    })
  ) {
    return false;
  }
  // `.some(Boolean-after-trim)` rather than `.length > 0`: an aggregate list
  // containing only "" or whitespace is not evidence anything was actually
  // delivered.
  return (
    (params.messagingToolSentTexts?.some((text) => text.trim().length > 0) ?? false) ||
    (params.messagingToolSentMediaUrls?.some((url) => url.trim().length > 0) ?? false)
  );
}
