import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { FeishuMessageEvent } from "./bot.js";
import {
  createDedupeCache,
  createPersistentDedupe,
  readJsonFileWithFallback,
} from "./dedup-runtime-api.js";

// Persistent TTL: 24 hours — survives restarts & WebSocket reconnects.
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const MEMORY_MAX_SIZE = 1_000;
const FILE_MAX_ENTRIES = 10_000;
const EVENT_DEDUP_TTL_MS = 5 * 60 * 1000;
const EVENT_MEMORY_MAX_SIZE = 2_000;
type PersistentDedupeData = Record<string, number>;

const memoryDedupe = createDedupeCache({ ttlMs: DEDUP_TTL_MS, maxSize: MEMORY_MAX_SIZE });
const processingClaims = createDedupeCache({
  ttlMs: EVENT_DEDUP_TTL_MS,
  maxSize: EVENT_MEMORY_MAX_SIZE,
});

function resolveStateDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const stateOverride = env.OPENCLAW_STATE_DIR?.trim();
  if (stateOverride) {
    return stateOverride;
  }
  if (env.VITEST || env.NODE_ENV === "test") {
    return path.join(os.tmpdir(), ["openclaw-vitest", String(process.pid)].join("-"));
  }
  return path.join(os.homedir(), ".openclaw");
}

function resolveNamespaceFilePath(namespace: string): string {
  const safe = namespace.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(resolveStateDirFromEnv(), "feishu", "dedup", `${safe}.json`);
}

const persistentDedupe = createPersistentDedupe({
  ttlMs: DEDUP_TTL_MS,
  memoryMaxSize: MEMORY_MAX_SIZE,
  fileMaxEntries: FILE_MAX_ENTRIES,
  resolveFilePath: resolveNamespaceFilePath,
});

function resolveEventDedupeKey(
  namespace: string,
  messageId: string | undefined | null,
): string | null {
  const trimmed = messageId?.trim();
  if (!trimmed) {
    return null;
  }
  return `${namespace}:${trimmed}`;
}

function normalizeMessageId(messageId: string | undefined | null): string | null {
  const trimmed = messageId?.trim();
  return trimmed ? trimmed : null;
}

function resolveMemoryDedupeKey(
  namespace: string,
  messageId: string | undefined | null,
): string | null {
  const trimmed = normalizeMessageId(messageId);
  if (!trimmed) {
    return null;
  }
  return `${namespace}:${trimmed}`;
}

export function tryBeginFeishuMessageProcessing(
  messageId: string | undefined | null,
  namespace = "global",
): boolean {
  return !processingClaims.check(resolveEventDedupeKey(namespace, messageId));
}

export function releaseFeishuMessageProcessing(
  messageId: string | undefined | null,
  namespace = "global",
): void {
  processingClaims.delete(resolveEventDedupeKey(namespace, messageId));
}

export async function finalizeFeishuMessageProcessing(params: {
  messageId: string | undefined | null;
  namespace?: string;
  log?: (...args: unknown[]) => void;
  claimHeld?: boolean;
}): Promise<boolean> {
  const { messageId, namespace = "global", log, claimHeld = false } = params;
  const normalizedMessageId = normalizeMessageId(messageId);
  const memoryKey = resolveMemoryDedupeKey(namespace, messageId);
  if (!memoryKey || !normalizedMessageId) {
    return false;
  }
  if (!claimHeld && !tryBeginFeishuMessageProcessing(normalizedMessageId, namespace)) {
    return false;
  }
  if (!tryRecordMessage(memoryKey)) {
    releaseFeishuMessageProcessing(normalizedMessageId, namespace);
    return false;
  }
  if (!(await tryRecordMessagePersistent(normalizedMessageId, namespace, log))) {
    releaseFeishuMessageProcessing(normalizedMessageId, namespace);
    return false;
  }
  return true;
}

export async function recordProcessedFeishuMessage(
  messageId: string | undefined | null,
  namespace = "global",
  log?: (...args: unknown[]) => void,
): Promise<boolean> {
  const normalizedMessageId = normalizeMessageId(messageId);
  const memoryKey = resolveMemoryDedupeKey(namespace, messageId);
  if (!memoryKey || !normalizedMessageId) {
    return false;
  }
  tryRecordMessage(memoryKey);
  return await tryRecordMessagePersistent(normalizedMessageId, namespace, log);
}

export async function hasProcessedFeishuMessage(
  messageId: string | undefined | null,
  namespace = "global",
  log?: (...args: unknown[]) => void,
): Promise<boolean> {
  const normalizedMessageId = normalizeMessageId(messageId);
  const memoryKey = resolveMemoryDedupeKey(namespace, messageId);
  if (!memoryKey || !normalizedMessageId) {
    return false;
  }
  if (hasRecordedMessage(memoryKey)) {
    return true;
  }
  return hasRecordedMessagePersistent(normalizedMessageId, namespace, log);
}

/**
 * Synchronous dedup — memory only.
 * Kept for backward compatibility; prefer {@link tryRecordMessagePersistent}.
 */
export function tryRecordMessage(messageId: string): boolean {
  return !memoryDedupe.check(messageId);
}

export function hasRecordedMessage(messageId: string): boolean {
  const trimmed = messageId.trim();
  if (!trimmed) {
    return false;
  }
  return memoryDedupe.peek(trimmed);
}

export async function tryRecordMessagePersistent(
  messageId: string,
  namespace = "global",
  log?: (...args: unknown[]) => void,
): Promise<boolean> {
  return persistentDedupe.checkAndRecord(messageId, {
    namespace,
    onDiskError: (error) => {
      log?.(`feishu-dedup: disk error, falling back to memory: ${String(error)}`);
    },
  });
}

export async function hasRecordedMessagePersistent(
  messageId: string,
  namespace = "global",
  log?: (...args: unknown[]) => void,
): Promise<boolean> {
  const trimmed = messageId.trim();
  if (!trimmed) {
    return false;
  }
  const now = Date.now();
  const filePath = resolveNamespaceFilePath(namespace);
  try {
    const { value } = await readJsonFileWithFallback<PersistentDedupeData>(filePath, {});
    const seenAt = value[trimmed];
    if (typeof seenAt !== "number" || !Number.isFinite(seenAt)) {
      return false;
    }
    return DEDUP_TTL_MS <= 0 || now - seenAt < DEDUP_TTL_MS;
  } catch (error) {
    log?.(`feishu-dedup: persistent peek failed: ${String(error)}`);
    return false;
  }
}

export async function warmupDedupFromDisk(
  namespace: string,
  log?: (...args: unknown[]) => void,
): Promise<number> {
  return persistentDedupe.warmup(namespace, (error) => {
    log?.(`feishu-dedup: warmup disk error: ${String(error)}`);
  });
}

function resolveFeishuSenderIdentity(event: FeishuMessageEvent): string | undefined {
  const senderId = event.sender?.sender_id;
  return (
    senderId?.open_id?.trim() ||
    senderId?.union_id?.trim() ||
    senderId?.user_id?.trim() ||
    undefined
  );
}

/**
 * Resolve the dedupe identity for an inbound Feishu event.
 *
 * Feishu can redeliver the same logical text message with a fresh `message_id`
 * (retry/reconnect), defeating message_id-based dedupe (#46778). For text we key
 * on a stable retry identity instead: same sender + chat + create_time + content
 * is the same logical message. `create_time` is the message's own server
 * timestamp and stays fixed across redeliveries, so a genuine repeat send (which
 * gets a new create_time) keeps a distinct key and is never suppressed. Falls
 * back to `message_id` when any field is missing, or for non-text messages
 * (media dedupe and synthetic events already have stable/unique ids), so
 * behavior is unchanged there.
 *
 * IMPORTANT: this is a pure function of the event. Call it only on the original
 * inbound event, never on a debounce-merged event whose content was rewritten,
 * or the hash will drift from the entry-gate claim.
 */
export function resolveFeishuDedupeId(event: FeishuMessageEvent): string {
  const messageId = event.message.message_id?.trim() ?? "";
  if (event.message.message_type?.trim() !== "text") {
    return messageId;
  }
  const createTime = event.message.create_time?.trim();
  const chatId = event.message.chat_id?.trim();
  const senderId = resolveFeishuSenderIdentity(event);
  if (!createTime || !chatId || !senderId) {
    return messageId;
  }
  const contentHash = createHash("sha256")
    .update(event.message.content ?? "", "utf8")
    .digest("hex")
    .slice(0, 32);
  return JSON.stringify(["text-retry", senderId, chatId, createTime, contentHash]);
}
