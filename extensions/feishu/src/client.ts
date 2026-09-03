import type { Agent } from "node:https";
import * as Lark from "@larksuiteoapi/node-sdk";
import { resolveAmbientNodeProxyAgent } from "openclaw/plugin-sdk/extension-shared";
import type { FeishuConfig, FeishuDomain, ResolvedFeishuAccount } from "./types.js";

const FEISHU_SDK_ORIGIN = "https://open.feishu.cn";

const FEISHU_WS_CONFIG = {
  PingInterval: 30,
  PingTimeout: 3,
} as const;
type FeishuClientSdk = Pick<
  typeof Lark,
  | "AppType"
  | "Client"
  | "defaultHttpInstance"
  | "Domain"
  | "EventDispatcher"
  | "LoggerLevel"
  | "WSClient"
>;

const defaultFeishuClientSdk: FeishuClientSdk = {
  AppType: Lark.AppType,
  Client: Lark.Client,
  defaultHttpInstance: Lark.defaultHttpInstance,
  Domain: Lark.Domain,
  EventDispatcher: Lark.EventDispatcher,
  LoggerLevel: Lark.LoggerLevel,
  WSClient: Lark.WSClient,
};

let feishuClientSdk: FeishuClientSdk = defaultFeishuClientSdk;

/** Default HTTP timeout for Feishu API requests (30 seconds). */
export const FEISHU_HTTP_TIMEOUT_MS = 30_000;
export const FEISHU_HTTP_TIMEOUT_MAX_MS = 300_000;
export const FEISHU_HTTP_TIMEOUT_ENV_VAR = "OPENCLAW_FEISHU_HTTP_TIMEOUT_MS";

type FeishuHttpInstanceLike = Pick<
  typeof feishuClientSdk.defaultHttpInstance,
  "request" | "get" | "post" | "put" | "patch" | "delete" | "head" | "options"
>;

async function getWsProxyAgent(): Promise<Agent | undefined> {
  return resolveAmbientNodeProxyAgent<Agent>();
}

// Multi-account client cache
const clientCache = new Map<
  string,
  {
    client: Lark.Client;
    config: { appId: string; appSecret: string; domain?: FeishuDomain; httpTimeoutMs: number };
  }
>();

function resolveSdkDomain(domain: FeishuDomain | undefined): Lark.Domain {
  // The SDK parses ":port" inside a custom domain string as an API route parameter, so a
  // private-deployment origin must never be handed to the SDK directly. Keep the SDK on a
  // canonical origin and re-target the request in our own HTTP transport instead.
  return domain === "lark" ? feishuClientSdk.Domain.Lark : feishuClientSdk.Domain.Feishu;
}

/**
 * Create an HTTP instance that delegates to the Lark SDK's default instance
 * but injects a default request timeout to prevent indefinite hangs
 * (e.g. when the Feishu API is slow, causing per-chat queue deadlocks).
 */
function createTimeoutHttpInstance(
  defaultTimeoutMs: number,
  configuredDomain?: FeishuDomain,
): Lark.HttpInstance {
  const base: FeishuHttpInstanceLike = feishuClientSdk.defaultHttpInstance;
  const customDomain =
    configuredDomain && configuredDomain !== "feishu" && configuredDomain !== "lark"
      ? new URL(configuredDomain)
      : undefined;

  /**
   * Re-target SDK-generated URLs at the configured private-deployment origin, preserving its
   * port and base path. Requests that already point somewhere else are left untouched so a
   * look-alike host (open.feishu.cn.evil.test) can never capture the rewrite.
   */
  function resolveRequestUrl(url: string): string {
    if (!customDomain) {
      return url;
    }
    const requestUrl = new URL(url);
    if (requestUrl.origin !== FEISHU_SDK_ORIGIN) {
      return url;
    }
    const destination = new URL(customDomain);
    destination.pathname = `${destination.pathname.replace(/\/+$/, "")}${requestUrl.pathname}`;
    destination.search = requestUrl.search;
    destination.hash = requestUrl.hash;
    return destination.toString();
  }

  function injectTimeout<D>(opts?: Lark.HttpRequestOptions<D>): Lark.HttpRequestOptions<D> {
    const next = { timeout: defaultTimeoutMs, ...opts } as Lark.HttpRequestOptions<D> & {
      url?: string;
    };
    if (typeof next.url === "string") {
      next.url = resolveRequestUrl(next.url);
    }
    return next;
  }

  return {
    request: (opts) => base.request(injectTimeout(opts)),
    get: (url, opts) => base.get(resolveRequestUrl(url), injectTimeout(opts)),
    post: (url, data, opts) => base.post(resolveRequestUrl(url), data, injectTimeout(opts)),
    put: (url, data, opts) => base.put(resolveRequestUrl(url), data, injectTimeout(opts)),
    patch: (url, data, opts) => base.patch(resolveRequestUrl(url), data, injectTimeout(opts)),
    delete: (url, opts) => base.delete(resolveRequestUrl(url), injectTimeout(opts)),
    head: (url, opts) => base.head(resolveRequestUrl(url), injectTimeout(opts)),
    options: (url, opts) => base.options(resolveRequestUrl(url), injectTimeout(opts)),
  };
}

/**
 * Credentials needed to create a Feishu client.
 * Both FeishuConfig and ResolvedFeishuAccount satisfy this interface.
 */
export type FeishuClientCredentials = {
  accountId?: string;
  appId?: string;
  appSecret?: string;
  domain?: FeishuDomain;
  httpTimeoutMs?: number;
  config?: Pick<FeishuConfig, "httpTimeoutMs">;
};

export function resolveConfiguredHttpTimeoutMs(creds: FeishuClientCredentials): number {
  const clampTimeout = (value: number): number => {
    const rounded = Math.floor(value);
    return Math.min(Math.max(rounded, 1), FEISHU_HTTP_TIMEOUT_MAX_MS);
  };

  const fromDirectField = creds.httpTimeoutMs;
  if (
    typeof fromDirectField === "number" &&
    Number.isFinite(fromDirectField) &&
    fromDirectField > 0
  ) {
    return clampTimeout(fromDirectField);
  }

  const envRaw = process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR];
  if (envRaw) {
    const envValue = Number(envRaw);
    if (Number.isFinite(envValue) && envValue > 0) {
      return clampTimeout(envValue);
    }
  }

  const fromConfig = creds.config?.httpTimeoutMs;
  const timeout = fromConfig;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
    return FEISHU_HTTP_TIMEOUT_MS;
  }
  return clampTimeout(timeout);
}

/**
 * Create or get a cached Feishu client for an account.
 * Accepts any object with appId, appSecret, and optional domain/accountId.
 */
export function createFeishuClient(creds: FeishuClientCredentials): Lark.Client {
  const { accountId = "default", appId, appSecret, domain } = creds;
  const defaultHttpTimeoutMs = resolveConfiguredHttpTimeoutMs(creds);

  if (!appId || !appSecret) {
    throw new Error(`Feishu credentials not configured for account "${accountId}"`);
  }

  // Check cache
  const cached = clientCache.get(accountId);
  if (
    cached &&
    cached.config.appId === appId &&
    cached.config.appSecret === appSecret &&
    cached.config.domain === domain &&
    cached.config.httpTimeoutMs === defaultHttpTimeoutMs
  ) {
    return cached.client;
  }

  // Create new client with timeout-aware HTTP instance
  const client = new feishuClientSdk.Client({
    appId,
    appSecret,
    appType: feishuClientSdk.AppType.SelfBuild,
    domain: resolveSdkDomain(domain),
    httpInstance: createTimeoutHttpInstance(defaultHttpTimeoutMs, domain),
  });

  // Cache it
  clientCache.set(accountId, {
    client,
    config: { appId, appSecret, domain, httpTimeoutMs: defaultHttpTimeoutMs },
  });

  return client;
}

/**
 * Create a Feishu WebSocket client for an account.
 * Note: WSClient is not cached since each call creates a new connection.
 */
/** WebSocket lifecycle callbacks accepted by newer `@larksuiteoapi/node-sdk`
 * releases. The pinned SDK's `IConstructorParams` does not declare them yet, so
 * the shape is declared locally and forwarded verbatim; older SDKs ignore the
 * extra keys. */
export type FeishuWsClientCallbacks = {
  onError?: (err: Error) => void;
  onReady?: () => void;
  onReconnected?: () => void;
  onReconnecting?: () => void;
};

export async function createFeishuWSClient(
  account: ResolvedFeishuAccount,
  callbacks: FeishuWsClientCallbacks = {},
): Promise<Lark.WSClient> {
  const { accountId, appId, appSecret, domain } = account;

  if (!appId || !appSecret) {
    throw new Error(`Feishu credentials not configured for account "${accountId}"`);
  }

  const agent = await getWsProxyAgent();
  const defaultHttpTimeoutMs = resolveConfiguredHttpTimeoutMs(account);
  return new feishuClientSdk.WSClient({
    appId,
    appSecret,
    domain: resolveSdkDomain(domain),
    httpInstance: createTimeoutHttpInstance(defaultHttpTimeoutMs, domain),
    ...callbacks,
    loggerLevel: feishuClientSdk.LoggerLevel.info,
    wsConfig: FEISHU_WS_CONFIG,
    ...(agent ? { agent } : {}),
  } as ConstructorParameters<typeof feishuClientSdk.WSClient>[0] &
    FeishuWsClientCallbacks & {
      wsConfig: typeof FEISHU_WS_CONFIG;
    });
}

/**
 * Create an event dispatcher for an account.
 */
export function createEventDispatcher(account: ResolvedFeishuAccount): Lark.EventDispatcher {
  return new feishuClientSdk.EventDispatcher({
    encryptKey: account.encryptKey,
    verificationToken: account.verificationToken,
  });
}

/**
 * Get a cached client for an account (if exists).
 */
export function getFeishuClient(accountId: string): Lark.Client | null {
  return clientCache.get(accountId)?.client ?? null;
}

/**
 * Clear client cache for a specific account or all accounts.
 */
export function clearClientCache(accountId?: string): void {
  if (accountId) {
    clientCache.delete(accountId);
  } else {
    clientCache.clear();
  }
}

export function setFeishuClientRuntimeForTest(overrides?: {
  sdk?: Partial<FeishuClientSdk>;
}): void {
  feishuClientSdk = overrides?.sdk
    ? { ...defaultFeishuClientSdk, ...overrides.sdk }
    : defaultFeishuClientSdk;
}
