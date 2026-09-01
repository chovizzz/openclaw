import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "../types.js";
import type { BlockStreamingCoalescing } from "./block-streaming.js";

export type BlockReplyCoalescer = {
  enqueue: (payload: ReplyPayload) => void;
  flush: (options?: { force?: boolean }) => Promise<void>;
  hasBuffered: () => boolean;
  stop: () => void;
};

export function createBlockReplyCoalescer(params: {
  config: BlockStreamingCoalescing;
  shouldAbort: () => boolean;
  onFlush: (payload: ReplyPayload) => Promise<void> | void;
}): BlockReplyCoalescer {
  const { config, shouldAbort, onFlush } = params;
  const minChars = Math.max(1, Math.floor(config.minChars));
  const maxChars = Math.max(minChars, Math.floor(config.maxChars));
  const idleMs = Math.max(0, Math.floor(config.idleMs));
  const joiner = config.joiner ?? "";
  const flushOnEnqueue = config.flushOnEnqueue === true;

  let bufferText = "";
  // Keep the whole originating payload instead of copying a field allowlist:
  // rebuilding the payload from named fields silently dropped everything else
  // (explicit `replyToCurrent` / `replyToTag` routing, interactive/channel data),
  // so a coalesced block lost the routing the agent asked for.
  let bufferedPayload: ReplyPayload | undefined;
  let idleTimer: NodeJS.Timeout | undefined;

  const clearIdleTimer = () => {
    if (!idleTimer) {
      return;
    }
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const resetBuffer = () => {
    bufferText = "";
    bufferedPayload = undefined;
  };

  const scheduleIdleFlush = () => {
    if (idleMs <= 0) {
      return;
    }
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      void flush({ force: false });
    }, idleMs);
  };

  const flush = async (options?: { force?: boolean }) => {
    clearIdleTimer();
    if (shouldAbort()) {
      resetBuffer();
      return;
    }
    if (!bufferText || !bufferedPayload) {
      return;
    }
    if (!options?.force && !flushOnEnqueue && bufferText.length < minChars) {
      scheduleIdleFlush();
      return;
    }
    // The buffer only ever holds text-only payloads (anything with media flushes
    // straight through in `enqueue`), so media keys are cleared explicitly: a
    // malformed payload whose media looks empty to `hasMedia` (for example a
    // whitespace-only `mediaUrls` entry shadowing `mediaUrl`) must not leak its
    // media into the coalesced text block.
    const payload: ReplyPayload = {
      ...bufferedPayload,
      text: bufferText,
      mediaUrl: undefined,
      mediaUrls: undefined,
    };
    resetBuffer();
    await onFlush(payload);
  };

  const enqueue = (payload: ReplyPayload) => {
    if (shouldAbort()) {
      return;
    }
    const reply = resolveSendableOutboundReplyParts(payload);
    const hasMedia = reply.hasMedia;
    const text = reply.text;
    const hasText = reply.hasText;
    if (hasMedia) {
      void flush({ force: true });
      void onFlush(payload);
      return;
    }
    if (!hasText) {
      return;
    }

    // When flushOnEnqueue is set, treat each enqueued payload as its own outbound block
    // and flush immediately instead of waiting for coalescing thresholds.
    if (flushOnEnqueue) {
      if (bufferText) {
        void flush({ force: true });
      }
      bufferedPayload = payload;
      bufferText = text;
      void flush({ force: true });
      return;
    }

    const replyToConflict = Boolean(
      bufferText &&
      payload.replyToId &&
      (!bufferedPayload?.replyToId || bufferedPayload.replyToId !== payload.replyToId),
    );
    const visibilityConflict =
      bufferText &&
      bufferedPayload &&
      (bufferedPayload.isReasoning !== payload.isReasoning ||
        bufferedPayload.isCompactionNotice !== payload.isCompactionNotice);
    if (
      bufferText &&
      (replyToConflict ||
        bufferedPayload?.audioAsVoice !== payload.audioAsVoice ||
        visibilityConflict)
    ) {
      void flush({ force: true });
    }

    if (!bufferText) {
      bufferedPayload = payload;
    }

    const nextText = bufferText ? `${bufferText}${joiner}${text}` : text;
    if (nextText.length > maxChars) {
      if (bufferText) {
        void flush({ force: true });
        bufferedPayload = payload;
        if (text.length >= maxChars) {
          void onFlush(payload);
          return;
        }
        bufferText = text;
        scheduleIdleFlush();
        return;
      }
      void onFlush(payload);
      return;
    }

    bufferText = nextText;
    if (bufferText.length >= maxChars) {
      void flush({ force: true });
      return;
    }
    scheduleIdleFlush();
  };

  return {
    enqueue,
    flush,
    hasBuffered: () => Boolean(bufferText),
    stop: () => clearIdleTimer(),
  };
}
