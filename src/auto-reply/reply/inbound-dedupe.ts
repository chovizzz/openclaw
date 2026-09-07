import { logVerbose, shouldLogVerbose } from "../../globals.js";
import { resolveGlobalDedupeCache, type DedupeCache } from "../../infra/dedupe.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import type { MsgContext } from "../templating.js";

const DEFAULT_INBOUND_DEDUPE_TTL_MS = 20 * 60_000;
const DEFAULT_INBOUND_DEDUPE_MAX = 5000;

/**
 * Keep inbound dedupe shared across bundled chunks so the same provider
 * message cannot bypass dedupe by entering through a different chunk copy.
 */
const INBOUND_DEDUPE_CACHE_KEY = Symbol.for("openclaw.inboundDedupeCache");
const INBOUND_DEDUPE_INFLIGHT_KEY = Symbol.for("openclaw.inboundDedupeInflight");

const inboundDedupeCache: DedupeCache = resolveGlobalDedupeCache(INBOUND_DEDUPE_CACHE_KEY, {
  ttlMs: DEFAULT_INBOUND_DEDUPE_TTL_MS,
  maxSize: DEFAULT_INBOUND_DEDUPE_MAX,
});
// Timestamped, not a bare Set: a claim whose dispatch promise never settles
// (neither resolve nor reject) would otherwise strand its key forever, and every
// later redelivery of that message would be silently dropped as "inflight".
// A claim older than the dedupe TTL is meaningless anyway — even a committed key
// would have expired by then — so treat it as abandoned and let the retry win.
const inboundDedupeInFlight = resolveGlobalSingleton(
  INBOUND_DEDUPE_INFLIGHT_KEY,
  () => new Map<string, number>(),
);

export type InboundDedupeClaimResult =
  | { status: "invalid" }
  | { status: "duplicate"; key: string }
  | { status: "inflight"; key: string }
  | { status: "claimed"; key: string };

const resolveInboundPeerId = (ctx: MsgContext) =>
  ctx.OriginatingTo ?? ctx.To ?? ctx.From ?? ctx.SessionKey;

function resolveInboundDedupeSessionScope(ctx: MsgContext): string {
  const sessionKey =
    (ctx.CommandSource === "native"
      ? normalizeOptionalString(ctx.CommandTargetSessionKey)
      : undefined) ||
    normalizeOptionalString(ctx.SessionKey) ||
    "";
  if (!sessionKey) {
    return "";
  }
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return sessionKey;
  }
  // The same physical inbound message should never run twice for the same
  // agent, even if a routing bug presents it under both main and direct keys.
  return `agent:${parsed.agentId}`;
}

export function buildInboundDedupeKey(ctx: MsgContext): string | null {
  const provider =
    normalizeOptionalLowercaseString(ctx.OriginatingChannel ?? ctx.Provider ?? ctx.Surface) || "";
  const messageId = normalizeOptionalString(ctx.MessageSid);
  if (!provider || !messageId) {
    return null;
  }
  const peerId = resolveInboundPeerId(ctx);
  if (!peerId) {
    return null;
  }
  const sessionScope = resolveInboundDedupeSessionScope(ctx);
  const accountId = normalizeOptionalString(ctx.AccountId) ?? "";
  const threadId =
    ctx.MessageThreadId !== undefined && ctx.MessageThreadId !== null
      ? String(ctx.MessageThreadId)
      : "";
  return [provider, accountId, sessionScope, peerId, threadId, messageId].filter(Boolean).join("|");
}

export function shouldSkipDuplicateInbound(
  ctx: MsgContext,
  opts?: { cache?: DedupeCache; now?: number },
): boolean {
  const key = buildInboundDedupeKey(ctx);
  if (!key) {
    return false;
  }
  const cache = opts?.cache ?? inboundDedupeCache;
  const skipped = cache.check(key, opts?.now);
  if (skipped && shouldLogVerbose()) {
    logVerbose(`inbound dedupe: skipped ${key}`);
  }
  return skipped;
}

export function claimInboundDedupe(
  ctx: MsgContext,
  opts?: { cache?: DedupeCache; now?: number; inFlight?: Map<string, number> },
): InboundDedupeClaimResult {
  const key = buildInboundDedupeKey(ctx);
  if (!key) {
    return { status: "invalid" };
  }
  const cache = opts?.cache ?? inboundDedupeCache;
  const now = opts?.now ?? Date.now();
  if (cache.peek(key, opts?.now)) {
    return { status: "duplicate", key };
  }
  const inFlight = opts?.inFlight ?? inboundDedupeInFlight;
  const claimedAt = inFlight.get(key);
  if (claimedAt !== undefined && now - claimedAt < DEFAULT_INBOUND_DEDUPE_TTL_MS) {
    return { status: "inflight", key };
  }
  inFlight.set(key, now);
  return { status: "claimed", key };
}

export function commitInboundDedupe(
  key: string,
  opts?: { cache?: DedupeCache; now?: number; inFlight?: Map<string, number> },
): void {
  const cache = opts?.cache ?? inboundDedupeCache;
  cache.check(key, opts?.now);
  const inFlight = opts?.inFlight ?? inboundDedupeInFlight;
  inFlight.delete(key);
}

export function releaseInboundDedupe(key: string, opts?: { inFlight?: Map<string, number> }): void {
  const inFlight = opts?.inFlight ?? inboundDedupeInFlight;
  inFlight.delete(key);
}

export function resetInboundDedupe(): void {
  inboundDedupeCache.clear();
  inboundDedupeInFlight.clear();
}
