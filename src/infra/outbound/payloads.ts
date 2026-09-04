import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import {
  formatBtwTextForExternalDelivery,
  isRenderablePayload,
  shouldSuppressReasoningPayload,
} from "../../auto-reply/reply/reply-payloads.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import {
  hasInteractiveReplyBlocks,
  hasReplyChannelData,
  hasReplyPayloadContent,
  type InteractiveReply,
} from "../../interactive/payload.js";

export type NormalizedOutboundPayload = {
  text: string;
  mediaUrls: string[];
  audioAsVoice?: boolean;
  interactive?: InteractiveReply;
  channelData?: Record<string, unknown>;
};

export type OutboundPayloadJson = {
  text: string;
  mediaUrl: string | null;
  mediaUrls?: string[];
  audioAsVoice?: boolean;
  interactive?: InteractiveReply;
  channelData?: Record<string, unknown>;
};

// Relay housekeeping strings the agent emits to describe what it did on the
// internal side. They are not answers, and they leak local workspace paths when
// delivered to an external channel, so drop them before delivery. Every pattern
// is fully anchored so ordinary prose that merely mentions the same words is
// kept.
function isSuppressedRelayStatusText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }
  if (/^no channel reply\.?$/i.test(normalized)) {
    return true;
  }
  if (/^replied in-thread\.?$/i.test(normalized)) {
    return true;
  }
  if (/^replied in #[-\w]+\.?$/i.test(normalized)) {
    return true;
  }
  // Relay wiki-update notices. Narrowed from upstream on purpose: the trailing
  // "No channel reply." marker is REQUIRED here. Upstream made it optional, which
  // silently drops legitimate replies like
  // `Updated [wiki/roadmap.md] with the launch notes.` - dropping a real answer is
  // worse than the leak this suppresses. The bracket body is length-bounded and
  // excludes `]`, and the tail excludes `[` so there is no ambiguous overlap
  // between the two quantified spans; matching stays linear on adversarial input.
  if (
    /^updated\s+\[[^\]]{0,512}wiki\/[^\]]{1,512}\](?:\([^)]{0,1024}\))?(?:\s+with[^[]{0,2048}?)?\.?\s*no channel reply\.?$/i.test(
      normalized,
    )
  ) {
    return true;
  }
  return false;
}

function mergeMediaUrls(...lists: Array<ReadonlyArray<string | undefined> | undefined>): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const list of lists) {
    if (!list) {
      continue;
    }
    for (const entry of list) {
      const trimmed = entry?.trim();
      if (!trimmed) {
        continue;
      }
      if (seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      merged.push(trimmed);
    }
  }
  return merged;
}

export function normalizeReplyPayloadsForDelivery(
  payloads: readonly ReplyPayload[],
): ReplyPayload[] {
  const normalized: ReplyPayload[] = [];
  for (const payload of payloads) {
    if (shouldSuppressReasoningPayload(payload)) {
      continue;
    }
    const parsed = parseReplyDirectives(payload.text ?? "");
    const explicitMediaUrls = payload.mediaUrls ?? parsed.mediaUrls;
    const explicitMediaUrl = payload.mediaUrl ?? parsed.mediaUrl;
    const mergedMedia = mergeMediaUrls(
      explicitMediaUrls,
      explicitMediaUrl ? [explicitMediaUrl] : undefined,
    );
    const parsedText = parsed.text ?? "";
    // Checked before the payload is built so relay status text with no media is
    // dropped rather than delivered.
    if (isSuppressedRelayStatusText(parsedText) && mergedMedia.length === 0) {
      continue;
    }
    const hasMultipleMedia = (explicitMediaUrls?.length ?? 0) > 1;
    const resolvedMediaUrl = hasMultipleMedia ? undefined : explicitMediaUrl;
    const next: ReplyPayload = {
      ...payload,
      text:
        formatBtwTextForExternalDelivery({
          ...payload,
          text: parsedText,
        }) ?? "",
      mediaUrls: mergedMedia.length ? mergedMedia : undefined,
      mediaUrl: resolvedMediaUrl,
      replyToId: payload.replyToId ?? parsed.replyToId,
      replyToTag: payload.replyToTag || parsed.replyToTag,
      replyToCurrent: payload.replyToCurrent || parsed.replyToCurrent,
      audioAsVoice: Boolean(payload.audioAsVoice || parsed.audioAsVoice),
    };
    if (parsed.isSilent && mergedMedia.length === 0) {
      continue;
    }
    if (!isRenderablePayload(next)) {
      continue;
    }
    normalized.push(next);
  }
  return normalized;
}

export function normalizeOutboundPayloads(
  payloads: readonly ReplyPayload[],
): NormalizedOutboundPayload[] {
  const normalizedPayloads: NormalizedOutboundPayload[] = [];
  for (const payload of normalizeReplyPayloadsForDelivery(payloads)) {
    const parts = resolveSendableOutboundReplyParts(payload);
    const interactive = payload.interactive;
    const channelData = payload.channelData;
    const hasChannelData = hasReplyChannelData(channelData);
    const hasInteractive = hasInteractiveReplyBlocks(interactive);
    const text = parts.text;
    if (
      !hasReplyPayloadContent({ ...payload, text, mediaUrls: parts.mediaUrls }, { hasChannelData })
    ) {
      continue;
    }
    normalizedPayloads.push({
      text,
      mediaUrls: parts.mediaUrls,
      audioAsVoice: payload.audioAsVoice === true ? true : undefined,
      ...(hasInteractive ? { interactive } : {}),
      ...(hasChannelData ? { channelData } : {}),
    });
  }
  return normalizedPayloads;
}

export function normalizeOutboundPayloadsForJson(
  payloads: readonly ReplyPayload[],
): OutboundPayloadJson[] {
  const normalized: OutboundPayloadJson[] = [];
  for (const payload of normalizeReplyPayloadsForDelivery(payloads)) {
    const parts = resolveSendableOutboundReplyParts(payload);
    normalized.push({
      text: parts.text,
      mediaUrl: payload.mediaUrl ?? null,
      mediaUrls: parts.mediaUrls.length ? parts.mediaUrls : undefined,
      audioAsVoice: payload.audioAsVoice === true ? true : undefined,
      interactive: payload.interactive,
      channelData: payload.channelData,
    });
  }
  return normalized;
}

export function formatOutboundPayloadLog(
  payload: Pick<NormalizedOutboundPayload, "text" | "channelData"> & {
    mediaUrls: readonly string[];
  },
): string {
  const lines: string[] = [];
  if (payload.text) {
    lines.push(payload.text.trimEnd());
  }
  for (const url of payload.mediaUrls) {
    lines.push(`MEDIA:${url}`);
  }
  return lines.join("\n");
}
