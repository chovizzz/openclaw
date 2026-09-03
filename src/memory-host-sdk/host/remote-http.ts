import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import type { SsrFPolicy } from "../../infra/net/ssrf.js";

export function buildRemoteBaseUrlPolicy(baseUrl: string): SsrFPolicy | undefined {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    // Keep policy tied to the configured host so private operator endpoints
    // continue to work, while cross-host redirects stay blocked.
    return { allowedHostnames: [parsed.hostname] };
  } catch {
    return undefined;
  }
}

export async function withRemoteHttpResponse<T>(params: {
  url: string;
  init?: RequestInit;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  /**
   * Caller-owned abort signal. Forwarded as the guard's top-level `signal` (not
   * `init.signal`, which the guard overwrites with its own derived signal) so
   * the in-flight request is torn down and rejects with the caller's own abort
   * reason instead of a generic AbortError.
   */
  signal?: AbortSignal;
  auditContext?: string;
  onResponse: (response: Response) => Promise<T>;
}): Promise<T> {
  const { response, release } = await fetchWithSsrFGuard({
    url: params.url,
    fetchImpl: params.fetchImpl,
    init: params.init,
    signal: params.signal,
    policy: params.ssrfPolicy,
    auditContext: params.auditContext ?? "memory-remote",
  });
  try {
    return await params.onResponse(response);
  } finally {
    await release();
  }
}
