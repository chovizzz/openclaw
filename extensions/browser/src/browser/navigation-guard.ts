import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { hasProxyEnvConfigured } from "../infra/net/proxy-env.js";
import {
  isPrivateNetworkAllowedByPolicy,
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
  type SsrFPolicy,
} from "../infra/net/ssrf.js";

const NETWORK_NAVIGATION_PROTOCOLS = new Set(["http:", "https:"]);
const SAFE_NON_NETWORK_URLS = new Set(["about:blank"]);
const BROWSER_NAVIGATION_CREDENTIALS_BLOCKED_MESSAGE =
  "Navigation blocked: URL-embedded credentials are not supported for page navigation. Set HTTP Basic auth with `openclaw browser set credentials <username> <password>` or use an authenticated browser profile.";

function isAllowedNonNetworkNavigationUrl(parsed: URL): boolean {
  // Keep non-network navigation explicit; about:blank is the only allowed bootstrap URL.
  return SAFE_NON_NETWORK_URLS.has(parsed.href);
}

export class InvalidBrowserNavigationUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBrowserNavigationUrlError";
  }
}

/** Parse a page-navigation URL and reject credentials before any transport dispatch. */
export function parseBrowserNavigationUrl(url: string): URL {
  const rawUrl = normalizeOptionalString(url) ?? "";
  if (!rawUrl) {
    throw new InvalidBrowserNavigationUrlError("url is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // A malformed URL containing "@" may still carry credentials; never echo it.
    const diagnostic = rawUrl.includes("@") ? "[redacted credential-bearing URL]" : rawUrl;
    throw new InvalidBrowserNavigationUrlError(`Invalid URL: ${diagnostic}`);
  }

  if (parsed.username || parsed.password) {
    throw new InvalidBrowserNavigationUrlError(BROWSER_NAVIGATION_CREDENTIALS_BLOCKED_MESSAGE);
  }
  return parsed;
}

export type BrowserNavigationPolicyOptions = {
  ssrfPolicy?: SsrFPolicy;
};

export type BrowserNavigationRequestLike = {
  url(): string;
  redirectedFrom(): BrowserNavigationRequestLike | null;
};

export function withBrowserNavigationPolicy(
  ssrfPolicy?: SsrFPolicy,
): BrowserNavigationPolicyOptions {
  return ssrfPolicy ? { ssrfPolicy } : {};
}

export function requiresInspectableBrowserNavigationRedirects(ssrfPolicy?: SsrFPolicy): boolean {
  return !isPrivateNetworkAllowedByPolicy(ssrfPolicy);
}

export async function assertBrowserNavigationAllowed(
  opts: {
    url: string;
    lookupFn?: LookupFn;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const parsed = parseBrowserNavigationUrl(opts.url);

  if (!NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol)) {
    if (isAllowedNonNetworkNavigationUrl(parsed)) {
      return;
    }
    throw new InvalidBrowserNavigationUrlError(
      `Navigation blocked: unsupported protocol "${parsed.protocol}"`,
    );
  }

  // Browser network stacks may apply env proxy routing at connect-time, which
  // can bypass strict destination-binding intent from pre-navigation DNS checks.
  // In strict mode, fail closed unless private-network navigation is explicitly
  // enabled by policy.
  if (hasProxyEnvConfigured() && !isPrivateNetworkAllowedByPolicy(opts.ssrfPolicy)) {
    throw new InvalidBrowserNavigationUrlError(
      "Navigation blocked: strict browser SSRF policy cannot be enforced while env proxy variables are set",
    );
  }

  await resolvePinnedHostnameWithPolicy(parsed.hostname, {
    lookupFn: opts.lookupFn,
    policy: opts.ssrfPolicy,
  });
}

/**
 * Best-effort post-navigation guard for final page URLs.
 * Only validates network URLs (http/https) and about:blank to avoid false
 * positives on browser-internal error pages (e.g. chrome-error://).
 */
export async function assertBrowserNavigationResultAllowed(
  opts: {
    url: string;
    lookupFn?: LookupFn;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const rawUrl = normalizeOptionalString(opts.url) ?? "";
  if (!rawUrl) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }
  if (
    NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol) ||
    isAllowedNonNetworkNavigationUrl(parsed)
  ) {
    await assertBrowserNavigationAllowed(opts);
  }
}

export async function assertBrowserNavigationRedirectChainAllowed(
  opts: {
    request?: BrowserNavigationRequestLike | null;
    lookupFn?: LookupFn;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const chain: string[] = [];
  let current = opts.request ?? null;
  while (current) {
    chain.push(current.url());
    current = current.redirectedFrom();
  }
  for (const url of chain.toReversed()) {
    await assertBrowserNavigationAllowed({
      url,
      lookupFn: opts.lookupFn,
      ssrfPolicy: opts.ssrfPolicy,
    });
  }
}
