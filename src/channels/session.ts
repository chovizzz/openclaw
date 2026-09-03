import type { MsgContext } from "../auto-reply/templating.js";
import type { GroupKeyResolution, SessionEntry } from "../config/sessions/types.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

let inboundSessionRuntimePromise: Promise<
  typeof import("../config/sessions/inbound.runtime.js")
> | null = null;

function loadInboundSessionRuntime() {
  inboundSessionRuntimePromise ??= import("../config/sessions/inbound.runtime.js");
  return inboundSessionRuntimePromise;
}

export type InboundLastRouteUpdate = {
  sessionKey: string;
  channel: SessionEntry["lastChannel"];
  to: string;
  accountId?: string;
  threadId?: string | number;
  mainDmOwnerPin?: {
    ownerRecipient: string;
    senderRecipient: string;
    onSkip?: (params: { ownerRecipient: string; senderRecipient: string }) => void;
  };
};

function shouldSkipPinnedMainDmRouteUpdate(
  pin: InboundLastRouteUpdate["mainDmOwnerPin"] | undefined,
): boolean {
  if (!pin) {
    return false;
  }
  const owner = normalizeLowercaseStringOrEmpty(pin.ownerRecipient);
  const sender = normalizeLowercaseStringOrEmpty(pin.senderRecipient);
  if (!owner || !sender || owner === sender) {
    return false;
  }
  pin.onSkip?.({ ownerRecipient: pin.ownerRecipient, senderRecipient: pin.senderRecipient });
  return true;
}

export async function recordInboundSession(params: {
  storePath: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
  updateLastRoute?: InboundLastRouteUpdate;
  onRecordError: (err: unknown) => void;
  /** Test/diagnostic hook: receives the detached session-meta task so callers can await it. */
  trackSessionMetaTask?: (task: Promise<unknown>) => void;
}): Promise<void> {
  const { storePath, sessionKey, ctx, groupResolution, createIfMissing } = params;
  const canonicalSessionKey = normalizeLowercaseStringOrEmpty(sessionKey);
  const runtime = await loadInboundSessionRuntime();
  const metaTask = runtime
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: canonicalSessionKey,
      ctx,
      groupResolution,
      createIfMissing,
    })
    .catch(async (err: unknown) => {
      try {
        // onRecordError may throw synchronously or return a rejected promise; either would
        // escape this detached task as an unhandled rejection and kill the gateway process.
        await Promise.resolve(params.onRecordError(err));
      } catch {
        // Error reporting must not reject the detached metadata task.
      }
    });
  params.trackSessionMetaTask?.(metaTask);
  void metaTask;

  const update = params.updateLastRoute;
  if (!update) {
    return;
  }
  if (shouldSkipPinnedMainDmRouteUpdate(update.mainDmOwnerPin)) {
    return;
  }
  const targetSessionKey = normalizeLowercaseStringOrEmpty(update.sessionKey);
  await runtime.updateLastRoute({
    storePath,
    sessionKey: targetSessionKey,
    deliveryContext: {
      channel: update.channel,
      to: update.to,
      accountId: update.accountId,
      threadId: update.threadId,
    },
    // Avoid leaking inbound origin metadata into a different target session.
    ctx: targetSessionKey === canonicalSessionKey ? ctx : undefined,
    groupResolution,
  });
}
