import { parseFiniteNumber as parseFiniteNumberish } from "./parse-finite-number.js";
import { PROVIDER_LABELS } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot, UsageProviderId } from "./provider-usage.types.js";

/** Node timers overflow past this; a raw setTimeout/AbortSignal.timeout would fire almost immediately. */
export const MAX_TIMER_TIMEOUT_MS = 2_147_483_647;

function resolveUsageTimeoutMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs)) {
    return MAX_TIMER_TIMEOUT_MS;
  }
  return Math.min(MAX_TIMER_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs)));
}

export async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(resolveUsageTimeoutMs(timeoutMs));
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  // Keep the signal alive after headers so stalled response bodies cannot outlive
  // the deadline or caller cancellation. fetch binds it to request and body reads.
  return await fetchFn(url, { ...init, signal });
}

export function parseFiniteNumber(value: unknown): number | undefined {
  return parseFiniteNumberish(value);
}

type BuildUsageHttpErrorSnapshotOptions = {
  provider: UsageProviderId;
  status: number;
  message?: string;
  tokenExpiredStatuses?: readonly number[];
};

export function buildUsageErrorSnapshot(
  provider: UsageProviderId,
  error: string,
): ProviderUsageSnapshot {
  return {
    provider,
    displayName: PROVIDER_LABELS[provider],
    windows: [],
    error,
  };
}

export function buildUsageHttpErrorSnapshot(
  options: BuildUsageHttpErrorSnapshotOptions,
): ProviderUsageSnapshot {
  const tokenExpiredStatuses = options.tokenExpiredStatuses ?? [];
  if (tokenExpiredStatuses.includes(options.status)) {
    return buildUsageErrorSnapshot(options.provider, "Token expired");
  }
  const suffix = options.message?.trim() ? `: ${options.message.trim()}` : "";
  return buildUsageErrorSnapshot(options.provider, `HTTP ${options.status}${suffix}`);
}
