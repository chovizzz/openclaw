import type { SsrFPolicy } from "../../infra/net/ssrf.js";
import { postJson } from "./post-json.js";

export async function fetchRemoteEmbeddingVectors(params: {
  url: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  body: unknown;
  errorPrefix: string;
  /** Caller-owned abort signal; cancels the in-flight request. */
  signal?: AbortSignal;
}): Promise<number[][]> {
  return await postJson({
    url: params.url,
    headers: params.headers,
    ssrfPolicy: params.ssrfPolicy,
    fetchImpl: params.fetchImpl,
    body: params.body,
    errorPrefix: params.errorPrefix,
    signal: params.signal,
    parse: (payload) => {
      const typedPayload = payload as {
        data?: Array<{ embedding?: number[] }>;
      };
      const data = typedPayload.data ?? [];
      return data.map((entry) => entry.embedding ?? []);
    },
  });
}
