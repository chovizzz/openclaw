import type { ConfigUiHint } from "../config-ui-hints-types.js";
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.js";

export const SENSITIVE_URL_HINT_TAG = "url-secret";

// Aligned with upstream packages/net-policy/src/redact-sensitive-url.ts; these
// names reach the persisted config-audit log, so under-matching leaks to disk.
const SENSITIVE_URL_QUERY_PARAM_NAMES = new Set([
  "token",
  "key",
  "api_key",
  "apikey",
  "secret",
  "access_token",
  "auth_token",
  "password",
  "pass",
  "passwd",
  "auth",
  "jwt",
  "session",
  "id_token",
  "code",
  "client_secret",
  "app_secret",
  "hook_token",
  "refresh_token",
  "signature",
  "x_amz_signature",
  "x_amz_security_token",
  "private_key",
  "credential",
  "authorization",
  // Common signed/API gateway aliases that do not contain an existing secret-name marker.
  "sig",
  "x_api_key",
  "x_access_token",
  "x_auth_token",
]);
// Proxy and per-resource bearer URLs may prefix a token key or suffix it with a random hex id.
const SUFFIXED_OR_SCOPED_TOKEN_QUERY_PARAM_RE = /(?:^|_)token(?:_[a-f0-9]{16,})?$/u;

export function isSensitiveUrlQueryParamName(name: string): boolean {
  // Hyphenated spellings (api-key, auth-token) normalize onto the underscore set.
  const normalized = normalizeLowercaseStringOrEmpty(name).replace(/-/g, "_");
  return (
    SENSITIVE_URL_QUERY_PARAM_NAMES.has(normalized) ||
    SUFFIXED_OR_SCOPED_TOKEN_QUERY_PARAM_RE.test(normalized)
  );
}

export function isSensitiveUrlConfigPath(path: string): boolean {
  if (path.endsWith(".baseUrl") || path.endsWith(".httpUrl")) {
    return true;
  }
  if (path.endsWith(".request.proxy.url")) {
    return true;
  }
  return /^mcp\.servers\.(?:\*|[^.]+)\.url$/.test(path);
}

export function hasSensitiveUrlHintTag(hint: Pick<ConfigUiHint, "tags"> | undefined): boolean {
  return hint?.tags?.includes(SENSITIVE_URL_HINT_TAG) === true;
}

export function redactSensitiveUrl(value: string): string {
  try {
    const parsed = new URL(value);
    let mutated = false;
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? "***" : "";
      parsed.password = parsed.password ? "***" : "";
      mutated = true;
    }
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (isSensitiveUrlQueryParamName(key)) {
        parsed.searchParams.set(key, "***");
        mutated = true;
      }
    }
    return mutated ? parsed.toString() : value;
  } catch {
    return value;
  }
}

// Whole-URL parsing is only trusted for real network schemes. An error string
// such as "SomeError: text wss://u:p@host" is a *valid* URL with scheme
// "someerror", which hides the embedded credentials inside the path while
// still mutating the query — and an early return on that would skip the
// fragment redaction below entirely.
const NETWORK_URL_RE = /^\s*(?:https?|wss?|ftp):\/\//iu;

export function redactSensitiveUrlLikeString(value: string): string {
  const whole = NETWORK_URL_RE.test(value) ? redactSensitiveUrl(value) : value;
  // Always run the fragment pass: it is idempotent on already-redacted text and
  // is the only thing that catches URLs embedded in free text.
  // Userinfo: match greedily to the *last* `@` before the path so a password
  // containing `@` cannot leak its tail; global so every URL in the text is
  // covered. Query keys are percent-decoded before classification so an
  // encoded name (`access_%74oken`) cannot dodge the sensitive-name check.
  return whole
    .replace(/\/\/([^/?#\s]*)@/g, "//***:***@")
    .replace(/([?&])([^=&\s]+)=([^&#\s"'<>)]*)/g, (match, prefix: string, key: string) =>
      isSensitiveUrlQueryParamName(decodeQueryKey(key)) ? `${prefix}${key}=***` : match,
    );
}

function decodeQueryKey(key: string): string {
  try {
    return decodeURIComponent(key.replace(/\+/g, " "));
  } catch {
    return key;
  }
}
