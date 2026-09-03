import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import WebSocket from "ws";
import { isLoopbackHost } from "../gateway/net.js";
import { type SsrFPolicy, resolvePinnedHostnameWithPolicy } from "../infra/net/ssrf.js";
import { rawDataToString } from "../infra/ws.js";
import { redactSensitiveText } from "../logging/redact.js";
import { getDirectAgentForCdp, withNoProxyForCdpUrl } from "./cdp-proxy-bypass.js";
import { CDP_HTTP_REQUEST_TIMEOUT_MS, CDP_WS_HANDSHAKE_TIMEOUT_MS } from "./cdp-timeouts.js";
import { resolveBrowserRateLimitMessage } from "./client-fetch.js";

export { isLoopbackHost };

/**
 * Detects whether a raw URL string contains an explicitly written port.
 *
 * WHATWG `URL` normalizes default ports (e.g. `:80` for http, `:443` for
 * https) to an empty `.port` string, making it impossible to distinguish
 * "user wrote :80" from "user omitted the port". This helper inspects the
 * raw string to preserve that intent.
 *
 * Handles IPv6 bracket notation and userinfo (user:pass@host) correctly.
 */
function hasRawExplicitPort(raw: string): boolean {
  // Strip scheme (e.g. "http://") and take only the authority portion
  // (everything before the first /, ?, or #).
  const authority = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/, 1)[0] ?? "";

  // Strip userinfo (user:pass@); the colon there is not a port separator.
  const hostPort = authority.includes("@")
    ? authority.slice(authority.lastIndexOf("@") + 1)
    : authority;

  // IPv6: [::1]:9222 has a port after the closing bracket.
  if (hostPort.startsWith("[")) {
    return /^\[[^\]]+\]:\d+$/.test(hostPort);
  }

  // IPv4 / hostname: host:port
  return /:\d+$/.test(hostPort);
}

export function parseBrowserHttpUrl(raw: string, label: string) {
  const trimmed = raw.trim();
  const parsed = new URL(trimmed);
  const allowed = ["http:", "https:", "ws:", "wss:"];
  if (!allowed.includes(parsed.protocol)) {
    throw new Error(`${label} must be http(s) or ws(s), got: ${parsed.protocol.replace(":", "")}`);
  }

  const isSecure = parsed.protocol === "https:" || parsed.protocol === "wss:";
  const port =
    parsed.port && Number.parseInt(parsed.port, 10) > 0
      ? Number.parseInt(parsed.port, 10)
      : isSecure
        ? 443
        : 80;

  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`${label} has invalid port: ${parsed.port}`);
  }

  const normalized = parsed.toString().replace(/\/$/, "");
  const hasExplicitPort = hasRawExplicitPort(trimmed);

  // When the user explicitly wrote a default port (e.g. :80 for http),
  // WHATWG normalization drops it from the URL string. Rebuild a
  // port-preserving normalized form so callers don't need raw-string hacks.
  // Note: the URL .port setter silently discards protocol-default ports,
  // so we must inject the port via string surgery on the normalized form.
  let normalizedWithPort: string;
  if (hasExplicitPort && !parsed.port) {
    const proto = parsed.protocol + "//";
    const rest = normalized.slice(proto.length);
    // Skip userinfo (user:pass@) if present
    const atIdx = rest.indexOf("@");
    const hostStart = atIdx >= 0 ? atIdx + 1 : 0;
    const hostPart = rest.slice(hostStart);
    // Find the end of the host: IPv6 brackets, a path slash, or a port colon.
    const hostLen = hostPart.startsWith("[")
      ? hostPart.indexOf("]") + 1
      : (() => {
          const idx = hostPart.search(/[:/]/);
          return idx < 0 ? hostPart.length : idx;
        })();
    const insertAt = hostStart + hostLen;
    normalizedWithPort = proto + rest.slice(0, insertAt) + ":" + port + rest.slice(insertAt);
  } else {
    normalizedWithPort = normalized;
  }

  return {
    parsed,
    port,
    hasExplicitPort,
    normalized,
    normalizedWithPort,
  };
}

/**
 * Returns true when the URL uses a WebSocket protocol (ws: or wss:).
 * Used to distinguish direct-WebSocket CDP endpoints
 * from HTTP(S) endpoints that require /json/version discovery.
 */
export function isWebSocketUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "ws:" || parsed.protocol === "wss:";
  } catch {
    return false;
  }
}

export async function assertCdpEndpointAllowed(
  cdpUrl: string,
  ssrfPolicy?: SsrFPolicy,
): Promise<void> {
  if (!ssrfPolicy) {
    return;
  }
  const parsed = new URL(cdpUrl);
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
    throw new Error(`Invalid CDP URL protocol: ${parsed.protocol.replace(":", "")}`);
  }
  await resolvePinnedHostnameWithPolicy(parsed.hostname, {
    policy: ssrfPolicy,
  });
}

export function redactCdpUrl(cdpUrl: string | null | undefined): string | null | undefined {
  if (typeof cdpUrl !== "string") {
    return cdpUrl;
  }
  const trimmed = cdpUrl.trim();
  if (!trimmed) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    parsed.username = "";
    parsed.password = "";
    return redactSensitiveText(parsed.toString().replace(/\/$/, ""));
  } catch {
    return redactSensitiveText(trimmed);
  }
}

type CdpResponse = {
  id: number;
  result?: unknown;
  error?: { message?: string };
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

export type CdpSendFn = (
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
) => Promise<unknown>;

export function getHeadersWithAuth(url: string, headers: Record<string, string> = {}) {
  const mergedHeaders = { ...headers };
  try {
    const parsed = new URL(url);
    const hasAuthHeader = Object.keys(mergedHeaders).some(
      (key) => normalizeLowercaseStringOrEmpty(key) === "authorization",
    );
    if (hasAuthHeader) {
      return mergedHeaders;
    }
    if (parsed.username || parsed.password) {
      const auth = Buffer.from(`${parsed.username}:${parsed.password}`).toString("base64");
      return { ...mergedHeaders, Authorization: `Basic ${auth}` };
    }
  } catch {
    // ignore
  }
  return mergedHeaders;
}

export function appendCdpPath(cdpUrl: string, path: string): string {
  const url = new URL(cdpUrl);
  const basePath = url.pathname.replace(/\/$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  url.pathname = `${basePath}${suffix}`;
  return url.toString();
}

export function normalizeCdpHttpBaseForJsonEndpoints(cdpUrl: string): string {
  try {
    const url = new URL(cdpUrl);
    if (url.protocol === "ws:") {
      url.protocol = "http:";
    } else if (url.protocol === "wss:") {
      url.protocol = "https:";
    }
    url.pathname = url.pathname.replace(/\/devtools\/browser\/.*$/, "");
    url.pathname = url.pathname.replace(/\/cdp$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    // Best-effort fallback for non-URL-ish inputs.
    return cdpUrl
      .replace(/^ws:/, "http:")
      .replace(/^wss:/, "https:")
      .replace(/\/devtools\/browser\/.*$/, "")
      .replace(/\/cdp$/, "")
      .replace(/\/$/, "");
  }
}

function createCdpSender(ws: WebSocket) {
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const send: CdpSendFn = (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ) => {
    const id = nextId++;
    const msg = { id, method, params, sessionId };
    ws.send(JSON.stringify(msg));
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  };

  const closeWithError = (err: Error) => {
    for (const [, p] of pending) {
      p.reject(err);
    }
    pending.clear();
    try {
      ws.close();
    } catch {
      // ignore
    }
  };

  ws.on("error", (err) => {
    closeWithError(err instanceof Error ? err : new Error(String(err)));
  });

  ws.on("message", (data) => {
    try {
      const parsed = JSON.parse(rawDataToString(data)) as CdpResponse;
      if (typeof parsed.id !== "number") {
        return;
      }
      const p = pending.get(parsed.id);
      if (!p) {
        return;
      }
      pending.delete(parsed.id);
      if (parsed.error?.message) {
        p.reject(new Error(parsed.error.message));
        return;
      }
      p.resolve(parsed.result);
    } catch {
      // ignore
    }
  });

  ws.on("close", () => {
    closeWithError(new Error("CDP socket closed"));
  });

  return { send, closeWithError };
}

export async function fetchJson<T>(
  url: string,
  timeoutMs = CDP_HTTP_REQUEST_TIMEOUT_MS,
  init?: RequestInit,
): Promise<T> {
  const res = await fetchCdpChecked(url, timeoutMs, init);
  return (await res.json()) as T;
}

export async function fetchCdpChecked(
  url: string,
  timeoutMs = CDP_HTTP_REQUEST_TIMEOUT_MS,
  init?: RequestInit,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(ctrl.abort.bind(ctrl), timeoutMs);
  // Merge the caller's signal with the request timeout so a canceled caller
  // aborts the in-flight fetch instead of waiting out the full timeout budget.
  // Without a caller signal this is byte-for-byte the previous behavior.
  const signal = init?.signal ? AbortSignal.any([ctrl.signal, init.signal]) : ctrl.signal;
  try {
    const headers = getHeadersWithAuth(url, (init?.headers as Record<string, string>) || {});
    const res = await withNoProxyForCdpUrl(url, () => fetch(url, { ...init, headers, signal }));
    if (!res.ok) {
      if (res.status === 429) {
        // Do not reflect upstream response text into the error surface (log/agent injection risk)
        throw new Error(`${resolveBrowserRateLimitMessage(url)} Do NOT retry the browser tool.`);
      }
      throw new Error(`HTTP ${res.status}`);
    }
    return res;
  } finally {
    clearTimeout(t);
  }
}

export async function fetchOk(
  url: string,
  timeoutMs = CDP_HTTP_REQUEST_TIMEOUT_MS,
  init?: RequestInit,
): Promise<void> {
  await fetchCdpChecked(url, timeoutMs, init);
}

export function openCdpWebSocket(
  wsUrl: string,
  opts?: { headers?: Record<string, string>; handshakeTimeoutMs?: number },
): WebSocket {
  const headers = getHeadersWithAuth(wsUrl, opts?.headers ?? {});
  const handshakeTimeoutMs =
    typeof opts?.handshakeTimeoutMs === "number" && Number.isFinite(opts.handshakeTimeoutMs)
      ? Math.max(1, Math.floor(opts.handshakeTimeoutMs))
      : CDP_WS_HANDSHAKE_TIMEOUT_MS;
  const agent = getDirectAgentForCdp(wsUrl);
  return new WebSocket(wsUrl, {
    handshakeTimeout: handshakeTimeoutMs,
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(agent ? { agent } : {}),
  });
}

export async function withCdpSocket<T>(
  wsUrl: string,
  fn: (send: CdpSendFn) => Promise<T>,
  opts?: { headers?: Record<string, string>; handshakeTimeoutMs?: number },
): Promise<T> {
  const ws = openCdpWebSocket(wsUrl, opts);
  const { send, closeWithError } = createCdpSender(ws);

  const openPromise = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err));
    ws.once("close", () => reject(new Error("CDP socket closed")));
  });

  try {
    await openPromise;
  } catch (err) {
    closeWithError(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }

  try {
    return await fn(send);
  } catch (err) {
    closeWithError(err instanceof Error ? err : new Error(String(err)));
    throw err;
  } finally {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }
}
