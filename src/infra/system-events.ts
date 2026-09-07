// Lightweight in-memory queue for human-readable system events that should be
// prefixed to the next prompt. We intentionally avoid persistence to keep
// events ephemeral. Events are session-scoped and require an explicit key.

import { resolveGlobalMap } from "../shared/global-singleton.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import {
  mergeDeliveryContext,
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../utils/delivery-context.js";

export type SystemEvent = {
  text: string;
  ts: number;
  contextKey?: string | null;
  deliveryContext?: DeliveryContext;
  trusted?: boolean;
};

const MAX_EVENTS = 20;

// Dedupe identity is derived from the live queue, never from sticky "last seen"
// state. A sticky lastText permanently suppressed a repeated event even after
// the original was drained, which silently dropped events.
type SessionQueue = {
  queue: SystemEvent[];
  lastContextKey: string | null;
};

const SYSTEM_EVENT_QUEUES_KEY = Symbol.for("openclaw.systemEvents.queues");

const queues = resolveGlobalMap<string, SessionQueue>(SYSTEM_EVENT_QUEUES_KEY);

type SystemEventOptions = {
  sessionKey: string;
  contextKey?: string | null;
  deliveryContext?: DeliveryContext;
  trusted?: boolean;
};

function requireSessionKey(key?: string | null): string {
  const trimmed = normalizeOptionalString(key) ?? "";
  if (!trimmed) {
    throw new Error("system events require a sessionKey");
  }
  return trimmed;
}

function normalizeContextKey(key?: string | null): string | null {
  return normalizeOptionalLowercaseString(key) ?? null;
}

function getSessionQueue(sessionKey: string): SessionQueue | undefined {
  return queues.get(requireSessionKey(sessionKey));
}

function getOrCreateSessionQueue(sessionKey: string): SessionQueue {
  const key = requireSessionKey(sessionKey);
  const existing = queues.get(key);
  if (existing) {
    return existing;
  }
  const created: SessionQueue = {
    queue: [],
    lastContextKey: null,
  };
  queues.set(key, created);
  return created;
}

function cloneSystemEvent(event: SystemEvent): SystemEvent {
  return {
    ...event,
    ...(event.deliveryContext ? { deliveryContext: { ...event.deliveryContext } } : {}),
  };
}

export function isSystemEventContextChanged(
  sessionKey: string,
  contextKey?: string | null,
): boolean {
  const existing = getSessionQueue(sessionKey);
  const normalized = normalizeContextKey(contextKey);
  return normalized !== (existing?.lastContextKey ?? null);
}

// Total route identity. deliveryContextKey() is deliberately not used here: it
// returns undefined whenever channel or `to` is missing, which would collapse
// every partially-specified route into one bucket and dedupe away genuinely
// different events.
function deliveryRouteIdentity(context?: DeliveryContext): string {
  if (!context) {
    return "";
  }
  const threadId = context.threadId != null ? String(context.threadId) : "";
  // JSON.stringify, not a `|` join: a delimiter-joined key lets distinct routes
  // collide when a field itself contains the delimiter (to="a|b" would equal
  // to="a", accountId="b"), and a collision here silently drops a real event.
  return JSON.stringify([
    context.channel ?? "",
    context.to ?? "",
    context.accountId ?? "",
    threadId,
  ]);
}

function areDeliveryContextsEqual(left?: DeliveryContext, right?: DeliveryContext): boolean {
  return deliveryRouteIdentity(left) === deliveryRouteIdentity(right);
}

/**
 * Two events are the same event only when their full identity matches: visible
 * text, context key, trust flag, and delivery route. Text alone is far too
 * coarse — the same wording routed to a different chat, or carrying different
 * trust, is a genuinely different event and must not be swallowed.
 */
function isDuplicateSystemEvent(
  existing: SystemEvent,
  incoming: Pick<SystemEvent, "text" | "contextKey" | "deliveryContext" | "trusted">,
): boolean {
  return (
    existing.text === incoming.text &&
    (existing.contextKey ?? null) === (incoming.contextKey ?? null) &&
    (existing.trusted ?? true) === (incoming.trusted ?? true) &&
    areDeliveryContextsEqual(existing.deliveryContext, incoming.deliveryContext)
  );
}

/**
 * Scope of the duplicate search:
 * - keyed events (contextKey set) scan the whole pending queue, because a
 *   retried delivery for the same context can arrive after other events.
 * - unkeyed events only compare against the queue tail, so a recurring status
 *   line ("Node connected") can legitimately repeat later in the session.
 */
function findDuplicateInQueue(
  queue: readonly SystemEvent[],
  incoming: Pick<SystemEvent, "text" | "contextKey" | "deliveryContext" | "trusted">,
): SystemEvent | undefined {
  if ((incoming.contextKey ?? null) === null) {
    const last = queue.at(-1);
    return last && isDuplicateSystemEvent(last, incoming) ? last : undefined;
  }
  return queue.find((event) => isDuplicateSystemEvent(event, incoming));
}

export function enqueueSystemEvent(text: string, options: SystemEventOptions) {
  const key = requireSessionKey(options?.sessionKey);
  const entry = getOrCreateSessionQueue(key);
  const cleaned = text.trim();
  if (!cleaned) {
    return false;
  }
  const normalizedContextKey = normalizeContextKey(options?.contextKey);
  const normalizedDeliveryContext = normalizeDeliveryContext(options?.deliveryContext);
  const trusted = options.trusted !== false;
  const incoming = {
    text: cleaned,
    contextKey: normalizedContextKey,
    deliveryContext: normalizedDeliveryContext,
    trusted,
  };
  if (findDuplicateInQueue(entry.queue, incoming)) {
    return false;
  }
  // Only a contextful event may advance lastContextKey; an unkeyed event
  // interleaving must not clobber the context the caller is tracking.
  if (normalizedContextKey !== null) {
    entry.lastContextKey = normalizedContextKey;
  }
  entry.queue.push({
    ...incoming,
    ts: Date.now(),
  });
  if (entry.queue.length > MAX_EVENTS) {
    entry.queue.shift();
  }
  return true;
}

export function drainSystemEventEntries(sessionKey: string): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  const entry = getSessionQueue(key);
  if (!entry || entry.queue.length === 0) {
    return [];
  }
  const out = entry.queue.map(cloneSystemEvent);
  entry.queue.length = 0;
  entry.lastContextKey = null;
  queues.delete(key);
  return out;
}

export function drainSystemEvents(sessionKey: string): string[] {
  return drainSystemEventEntries(sessionKey).map((event) => event.text);
}

export function peekSystemEventEntries(sessionKey: string): SystemEvent[] {
  return getSessionQueue(sessionKey)?.queue.map(cloneSystemEvent) ?? [];
}

export function peekSystemEvents(sessionKey: string): string[] {
  return peekSystemEventEntries(sessionKey).map((event) => event.text);
}

export function hasSystemEvents(sessionKey: string) {
  return (getSessionQueue(sessionKey)?.queue.length ?? 0) > 0;
}

export function resolveSystemEventDeliveryContext(
  events: readonly SystemEvent[],
): DeliveryContext | undefined {
  let resolved: DeliveryContext | undefined;
  for (const event of events) {
    resolved = mergeDeliveryContext(event.deliveryContext, resolved);
  }
  return resolved;
}

export function resetSystemEventsForTest() {
  queues.clear();
}
