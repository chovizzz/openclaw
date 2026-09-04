import type { OpenClawConfig } from "../config/config.js";
import { compileConfigRegex } from "../security/config-regex.js";
import { readLoggingConfig } from "./config.js";
import { resolveNodeRequireFromMeta } from "./node-require.js";
import { replacePatternBounded } from "./redact-bounded.js";

const requireConfig = resolveNodeRequireFromMeta(import.meta.url);

export type RedactSensitiveMode = "off" | "tools";

const DEFAULT_REDACT_MODE: RedactSensitiveMode = "tools";
const DEFAULT_REDACT_MIN_LENGTH = 18;
const DEFAULT_REDACT_KEEP_START = 6;
const DEFAULT_REDACT_KEEP_END = 4;

const TELEGRAM_BOT_TOKEN_REDACT_PATTERN = String.raw`\bbot(\d{6,}:[A-Za-z0-9_-]{20,})\b`;
const TELEGRAM_TOKEN_REDACT_PATTERN = String.raw`\b(\d{6,}:[A-Za-z0-9_-]{20,})\b`;

// GitLab token families (upstream #112954). Deliberately not `\b`-anchored:
// several embed `=`/`.` separators that break word boundaries. Written in
// `/.../g` form so they stay CASE-SENSITIVE - the default `gi` compilation makes
// `GLPAT-...`-shaped ordinary identifiers match and destroys useful log lines.
// Every branch is a flat character class with a bounded quantifier, so none can
// backtrack exponentially on adversarial input.
const GITLAB_REDACT_PATTERNS: string[] = [
  String.raw`/(glpat-[A-Za-z0-9._=\-]{20,})/g`,
  String.raw`/(gloas-(?:[A-Fa-f0-9]{65,}|[A-Za-z0-9_-]{64}|[A-Fa-f0-9]{32,}))/g`,
  String.raw`/(gldt-[A-Za-z0-9_-]{20,})/g`,
  String.raw`/(glcbt-[A-Za-z0-9]{1,5}_[A-Za-z0-9_-]{20,})/g`,
  String.raw`/(glptt-[A-Za-z0-9_-]{40,})/g`,
  String.raw`/(glft-(?:[A-Za-z0-9_-]{20,}|[a-h0-9]+-[0-9]+_))/g`,
  String.raw`/(glimt-[A-Za-z0-9_-]{25,})/g`,
  String.raw`/(glagent-[A-Za-z0-9_-]{50,})/g`,
  String.raw`/(glwt-[A-Za-z0-9_-]{20,})/g`,
  String.raw`/(glsoat-[A-Za-z0-9_-]{20,})/g`,
  String.raw`/(glffct-[A-Za-z0-9_-]{20,})/g`,
  String.raw`/(glrt-[A-Za-z0-9._-]{20,})/g`,
  String.raw`/(glrtr?-[A-Za-z0-9_-]{27,300}\.[0-9a-z]{2}\.[0-9a-z]{9})/g`,
  String.raw`/(GR1348941[A-Za-z0-9_-]{20,})/g`,
  String.raw`/(_gitlab_session=[A-Za-z0-9%._-]{20,})/g`,
];

// Also case-sensitive: under `gi`, `hf_` matches `HF_CONFIGURATION`, `r8_`
// matches `R8_COMPILATION`, and `AKID`/`LTAI` match ordinary SCREAMING_CASE
// identifiers. Real keys always use the exact documented casing.
const VENDOR_PREFIX_REDACT_PATTERNS: string[] = [
  String.raw`/\b(AKID[A-Za-z0-9]{10,})\b/g`,
  String.raw`/\b(LTAI[A-Za-z0-9]{10,})\b/g`,
  String.raw`/\b(hf_[A-Za-z0-9]{10,})\b/g`,
  String.raw`/\b(r8_[A-Za-z0-9]{10,})\b/g`,
];

// Both alternations are flat character classes anchored on a literal quote, so
// neither can backtrack catastrophically.
const HTTP_CLIENT_REDACT_PATTERNS: string[] = [
  String.raw`(^|[\s,{])["']?(?:api[-_]key|access[-_]token|refresh[-_]token|authToken|auth[-_]token|clientSecret|client[-_]secret|appSecret|app[-_]secret)["']?\s*[:=]\s*(["'])([^"'\r\n]+)\2`,
  String.raw`(^|[\s,{])["']?(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)["']?\s*[:=]\s*(["'])([^"'\r\n]+)\2`,
];

// `replacePatternBounded` splits inputs over 32KB into DISJOINT 16KB slices, so
// any pattern whose whole match, or whose left-context assertion, can straddle a
// slice boundary must run against the full string instead - otherwise the secret
// is cut in half and both halves are emitted verbatim. Everything listed here is
// a flat character-class scan with no nested quantifiers, so running it unchunked
// stays linear in the input length.
const CHUNK_UNSAFE_PATTERN_SOURCES = new Set<string>([
  TELEGRAM_BOT_TOKEN_REDACT_PATTERN,
  TELEGRAM_TOKEN_REDACT_PATTERN,
  ...GITLAB_REDACT_PATTERNS,
  ...VENDOR_PREFIX_REDACT_PATTERNS,
  ...HTTP_CLIENT_REDACT_PATTERNS,
]);
const chunkUnsafePatterns = new WeakSet<RegExp>();

const DEFAULT_REDACT_PATTERNS: string[] = [
  // ENV-style assignments.
  String.raw`\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\b\s*[=:]\s*(["']?)([^\s"'\\]+)\1`,
  // JSON fields.
  String.raw`"(?:apiKey|token|secret|password|passwd|accessToken|refreshToken|authToken|clientSecret|appSecret)"\s*:\s*"([^"]+)"`,
  // HTTP client diagnostics stringify request config objects with JSON or
  // util.inspect-style fields (unquoted or single-quoted keys) rather than
  // env/CLI syntax, so the JSON pattern above misses them.
  ...HTTP_CLIENT_REDACT_PATTERNS,
  // CLI flags.
  String.raw`--(?:api[-_]?key|token|secret|password|passwd)\s+(["']?)([^\s"']+)\1`,
  // Authorization headers.
  String.raw`Authorization\s*[:=]\s*Bearer\s+([A-Za-z0-9._\-+=]+)`,
  String.raw`\bBearer\s+([A-Za-z0-9._\-+=]{18,})\b`,
  // PEM blocks.
  String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----`,
  // Common token prefixes.
  String.raw`\b(sk-[A-Za-z0-9_-]{8,})\b`,
  String.raw`\b(ghp_[A-Za-z0-9]{20,})\b`,
  String.raw`\b(github_pat_[A-Za-z0-9_]{20,})\b`,
  // GitLab token families. Ported from upstream #112954.
  ...GITLAB_REDACT_PATTERNS,
  String.raw`\b(xox[baprs]-[A-Za-z0-9-]{10,})\b`,
  String.raw`\b(xapp-[A-Za-z0-9-]{10,})\b`,
  String.raw`\b(gsk_[A-Za-z0-9_-]{10,})\b`,
  String.raw`\b(AIza[0-9A-Za-z\-_]{20,})\b`,
  String.raw`\b(pplx-[A-Za-z0-9_-]{10,})\b`,
  String.raw`\b(npm_[A-Za-z0-9]{10,})\b`,
  // Additional access-key and token-style prefixes.
  ...VENDOR_PREFIX_REDACT_PATTERNS,
  // Telegram Bot API URLs embed the token as `/bot<token>/...` (no word-boundary before digits).
  TELEGRAM_BOT_TOKEN_REDACT_PATTERN,
  TELEGRAM_TOKEN_REDACT_PATTERN,
];

type LoggingConfig = OpenClawConfig["logging"];

// Field-name classifiers used when a *value* is redacted in isolation (a JSON
// field, a persisted tool-result detail) and therefore carries no surrounding
// `KEY=value` text for the pattern list to latch onto.
const STRUCTURED_SECRET_FIELD_RE =
  /^(?:api[-_]?key|apiKey|token|secret|password|passwd|access[-_]?token|accessToken|refresh[-_]?token|refreshToken|id[-_]?token|idToken|auth[-_]?token|authToken|client[-_]?secret|clientSecret|app[-_]?secret|appSecret|card[-_]?number|cardNumber|card[-_]?cvc|card[-_]?cvv|cvc|cvv|security[-_]?code|securityCode)$/i;
// `*_KEY` is far too broad on its own: ordinary data fields such as `primary_key`,
// `partition_key`, `sort_key`, `cache_key`, `object_key`, `idempotency_key`, and
// `public_key` would be masked, and because the key is inherited down the subtree
// that would destroy whole branches of persisted diagnostics.
const BENIGN_KEY_SUFFIX_PREFIXES = new Set([
  "primary",
  "partition",
  "sort",
  "range",
  "cache",
  "object",
  "bucket",
  "index",
  "shard",
  "group",
  "row",
  "column",
  "foreign",
  "composite",
  "natural",
  "surrogate",
  "idempotency",
  "dedupe",
  "dedup",
  "public",
  "locale",
  "translation",
  "i18n",
  "map",
  "record",
  "entity",
]);

function hasBenignKeySuffix(key: string): boolean {
  const match = /^(.*?)[_-]?key$/i.exec(key);
  if (!match) {
    return false;
  }
  const head = match[1].replace(/[_-]+$/, "");
  const lastSegment = head.split(/[_-]/).filter(Boolean).at(-1);
  return lastSegment !== undefined && BENIGN_KEY_SUFFIX_PREFIXES.has(lastSegment.toLowerCase());
}

const STRUCTURED_SECRET_ENV_FIELD_RE =
  /^(?:(?:[A-Z0-9]+[_-])+(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)|API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CARD[_-]?NUMBER|CARD[_-]?CVC|CARD[_-]?CVV|CVC|CVV|SECURITY[_-]?CODE)$/i;

type RedactOptions = {
  mode?: RedactSensitiveMode;
  patterns?: string[];
};

function normalizeMode(value?: string): RedactSensitiveMode {
  return value === "off" ? "off" : DEFAULT_REDACT_MODE;
}

function parsePattern(raw: string): RegExp | null {
  if (!raw.trim()) {
    return null;
  }
  const match = raw.match(/^\/(.+)\/([gimsuy]*)$/);
  let pattern: RegExp | null;
  if (match) {
    const flags = match[2].includes("g") ? match[2] : `${match[2]}g`;
    pattern = compileConfigRegex(match[1], flags)?.regex ?? null;
  } else {
    pattern = compileConfigRegex(raw, "gi")?.regex ?? null;
  }
  if (pattern && CHUNK_UNSAFE_PATTERN_SOURCES.has(raw)) {
    chunkUnsafePatterns.add(pattern);
  }
  return pattern;
}

function resolvePatterns(value?: string[]): RegExp[] {
  const source = value?.length ? value : DEFAULT_REDACT_PATTERNS;
  return source.map(parsePattern).filter((re): re is RegExp => Boolean(re));
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

// Surrogate-safe slice. `src/utils.ts` exports an identical helper, but it also
// drags in node:fs/os/path, and this module sits on the logging hot path (and is
// re-exported through the plugin SDK text barrel), so the few lines are inlined
// rather than creating an import cycle risk.
function sliceUtf16Safe(input: string, start: number, end?: number): string {
  const len = input.length;
  let from = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
  let to = end === undefined ? len : end < 0 ? Math.max(len + end, 0) : Math.min(end, len);
  if (to <= from) {
    return "";
  }
  if (from > 0 && from < len) {
    if (isLowSurrogate(input.charCodeAt(from)) && isHighSurrogate(input.charCodeAt(from - 1))) {
      from += 1;
    }
  }
  if (to > 0 && to < len) {
    if (isHighSurrogate(input.charCodeAt(to - 1)) && isLowSurrogate(input.charCodeAt(to))) {
      to -= 1;
    }
  }
  return input.slice(from, to);
}

function maskToken(token: string): string {
  if (token.length < DEFAULT_REDACT_MIN_LENGTH) {
    return "***";
  }
  // Slice on UTF-16 code-unit boundaries so a surrogate pair straddling the
  // keep-start/keep-end cut never leaks a lone surrogate into log output.
  const start = sliceUtf16Safe(token, 0, DEFAULT_REDACT_KEEP_START);
  const end = sliceUtf16Safe(token, -DEFAULT_REDACT_KEEP_END);
  return `${start}…${end}`;
}

function redactPemBlock(block: string): string {
  const lines = block.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return "***";
  }
  return `${lines[0]}\n…redacted…\n${lines[lines.length - 1]}`;
}

function redactMatch(match: string, groups: string[]): string {
  if (match.includes("PRIVATE KEY-----")) {
    return redactPemBlock(match);
  }
  const token =
    groups.filter((value) => typeof value === "string" && value.length > 0).at(-1) ?? match;
  const masked = maskToken(token);
  if (token === match) {
    return masked;
  }
  return match.replace(token, masked);
}

function redactText(text: string, patterns: RegExp[]): string {
  let next = text;
  for (const pattern of patterns) {
    const replacer = (...args: string[]) => redactMatch(args[0], args.slice(1, args.length - 2));
    next = chunkUnsafePatterns.has(pattern)
      ? next.replace(pattern, replacer)
      : replacePatternBounded(next, pattern, replacer);
  }
  return next;
}

// Re-entrancy guard. Config load paths (and the persisted config-audit log)
// emit log lines, and those sinks call back into redaction with no options,
// which would re-enter loadConfig() while it is still resolving. Fail closed
// onto built-in tools-mode redaction instead of recursing.
let resolvingConfigRedaction = false;
// Last options successfully read from config. Reused when the guard trips so a
// re-entrant call still honors user `logging.redactPatterns` instead of silently
// falling back to defaults only.
let lastResolvedConfigRedaction: RedactOptions | null = null;

function resolveConfigRedaction(): RedactOptions {
  if (resolvingConfigRedaction) {
    // Fail closed on re-entry: reuse the cached *patterns* so a user's custom
    // ones are not silently dropped, but never inherit a cached `off` — a
    // re-entrant call happens while config is loading, which is exactly when
    // secrets flow through, and honoring `off` there would disable redaction
    // at the worst moment.
    const cached = lastResolvedConfigRedaction;
    if (!cached || normalizeMode(cached.mode) === "off") {
      return {
        mode: DEFAULT_REDACT_MODE,
        ...(cached?.patterns ? { patterns: cached.patterns } : {}),
      };
    }
    return cached;
  }
  let cfg: OpenClawConfig["logging"] | undefined;
  resolvingConfigRedaction = true;
  try {
    const loaded = requireConfig?.("../config/config.js") as
      | {
          loadConfig?: () => OpenClawConfig;
        }
      | undefined;
    cfg = loaded?.loadConfig?.().logging;
  } catch {
    cfg = undefined;
  } finally {
    resolvingConfigRedaction = false;
  }
  const resolved: RedactOptions = {
    mode: normalizeMode(cfg?.redactSensitive),
    patterns: cfg?.redactPatterns,
  };
  if (cfg) {
    lastResolvedConfigRedaction = resolved;
  }
  return resolved;
}

export function redactSensitiveText(text: string, options?: RedactOptions): string {
  if (!text) {
    return text;
  }
  const resolved = options ?? resolveConfigRedaction();
  if (normalizeMode(resolved.mode) === "off") {
    return text;
  }
  const patterns = resolvePatterns(resolved.patterns);
  if (!patterns.length) {
    return text;
  }
  return redactText(text, patterns);
}

export function redactToolDetail(detail: string): string {
  const resolved = resolveConfigRedaction();
  if (normalizeMode(resolved.mode) !== "tools") {
    return detail;
  }
  return redactSensitiveText(detail, resolved);
}

// Forces tools-mode regardless of `logging.redactSensitive` (which governs log
// output, not UI surfaces), and merges user `logging.redactPatterns` with the
// built-in defaults so both apply. Used for payloads streamed to the Control UI
// and for persisted tool-result details.
export function redactToolPayloadText(text: string): string {
  if (!text) {
    return text;
  }
  return redactSensitiveText(text, resolveToolPayloadRedaction(readLoggingConfig()));
}

function resolveToolPayloadRedaction(loggingConfig: LoggingConfig | undefined): RedactOptions {
  const userPatterns = loggingConfig?.redactPatterns;
  const patterns =
    userPatterns && userPatterns.length > 0
      ? [...userPatterns, ...DEFAULT_REDACT_PATTERNS]
      : undefined;
  return { mode: "tools", patterns };
}

// Same contract as redactToolPayloadText, but with the logging config supplied
// by the caller. Persisted-session writers already hold the resolved config and
// must not re-enter loadConfig() from inside a write path.
export function redactToolPayloadTextWithConfig(
  text: string,
  loggingConfig?: LoggingConfig,
): string {
  if (!text) {
    return text;
  }
  return redactSensitiveText(text, resolveToolPayloadRedaction(loggingConfig));
}

/** True when the field name alone marks its value as a credential. */
export function isSensitiveFieldKey(key: string): boolean {
  if (hasBenignKeySuffix(key)) {
    return false;
  }
  return STRUCTURED_SECRET_FIELD_RE.test(key) || STRUCTURED_SECRET_ENV_FIELD_RE.test(key);
}

// Redacts a value that is known to sit under `key`. Patterns run first so a
// recognizable token keeps its masked hint; if nothing matched but the key name
// is itself a credential name, the whole value is masked.
export function redactSensitiveFieldValueWithConfig(
  key: string,
  value: string,
  loggingConfig?: LoggingConfig,
): string {
  const redacted = redactSensitiveText(value, resolveToolPayloadRedaction(loggingConfig));
  if (redacted !== value) {
    return redacted;
  }
  if (isSensitiveFieldKey(key)) {
    return maskToken(value);
  }
  return value;
}

export function redactSensitiveFieldValue(key: string, value: string): string {
  return redactSensitiveFieldValueWithConfig(key, value, readLoggingConfig());
}

export function getDefaultRedactPatterns(): string[] {
  return [...DEFAULT_REDACT_PATTERNS];
}
