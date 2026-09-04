import {
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  DEFAULT_LOCAL_MODEL,
  DEFAULT_MISTRAL_EMBEDDING_MODEL,
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  DEFAULT_VOYAGE_EMBEDDING_MODEL,
  getMemoryEmbeddingProvider,
  listMemoryEmbeddingProviders,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderAdapter,
  type MemoryEmbeddingProviderCreateOptions,
  type MemoryEmbeddingProviderRuntime,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { formatErrorMessage } from "../dreaming-shared.js";
import { canAutoSelectLocal } from "./provider-adapters.js";

export {
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  DEFAULT_LOCAL_MODEL,
  DEFAULT_MISTRAL_EMBEDDING_MODEL,
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  DEFAULT_VOYAGE_EMBEDDING_MODEL,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";

/**
 * Fork-local widening of the core `MemoryEmbeddingProvider` contract: `embedQuery`
 * takes an optional caller abort signal so a caller that already gave up (for
 * example the `memory_search` 15s deadline) can cancel the in-flight embedding
 * request instead of merely abandoning the promise.
 *
 * The extra parameter is optional, so every existing arity-1 producer stays
 * assignable and every existing arity-1 call site is unchanged. Cancellation is
 * best-effort: the local llama backend can only refuse to start, and providers
 * that never adopted the parameter (the Ollama plugin, third-party providers)
 * ignore it and run to completion.
 */
export type EmbeddingProvider = Omit<MemoryEmbeddingProvider, "embedQuery"> & {
  embedQuery: (text: string, opts?: { signal?: AbortSignal }) => Promise<number[]>;
  /**
   * Optional shutdown hook so a provider can release process-level resources
   * (native model handles, sockets, child processes) when the owning
   * `MemoryIndexManager` closes. Optional so every existing provider stays
   * assignable; `MemoryIndexManager.close()` calls it only when present.
   */
  close?: () => Promise<void> | void;
};
export type EmbeddingProviderId = string;
export type EmbeddingProviderRequest = string;
export type EmbeddingProviderFallback = string;
export type EmbeddingProviderRuntime = MemoryEmbeddingProviderRuntime;

export type EmbeddingProviderResult = {
  provider: EmbeddingProvider | null;
  requestedProvider: EmbeddingProviderRequest;
  fallbackFrom?: string;
  fallbackReason?: string;
  providerUnavailableReason?: string;
  runtime?: EmbeddingProviderRuntime;
};

type CreateEmbeddingProviderOptions = MemoryEmbeddingProviderCreateOptions & {
  provider: EmbeddingProviderRequest;
  fallback: EmbeddingProviderFallback;
};

function formatProviderError(adapter: MemoryEmbeddingProviderAdapter, err: unknown): string {
  return adapter.formatSetupError?.(err) ?? formatErrorMessage(err);
}

function shouldContinueAutoSelection(
  adapter: MemoryEmbeddingProviderAdapter,
  err: unknown,
): boolean {
  return adapter.shouldContinueAutoSelection?.(err) ?? false;
}

function getAdapter(
  id: string,
  config?: MemoryEmbeddingProviderCreateOptions["config"],
): MemoryEmbeddingProviderAdapter {
  const adapter = getMemoryEmbeddingProvider(id, config);
  if (!adapter) {
    throw new Error(`Unknown memory embedding provider: ${id}`);
  }
  return adapter;
}

function listAutoSelectAdapters(
  options: CreateEmbeddingProviderOptions,
): MemoryEmbeddingProviderAdapter[] {
  return listMemoryEmbeddingProviders(options.config)
    .filter((adapter) => typeof adapter.autoSelectPriority === "number")
    .filter((adapter) =>
      adapter.id === "local" ? canAutoSelectLocal(options.local?.modelPath) : true,
    )
    .toSorted(
      (a, b) =>
        (a.autoSelectPriority ?? Number.MAX_SAFE_INTEGER) -
        (b.autoSelectPriority ?? Number.MAX_SAFE_INTEGER),
    );
}

function resolveProviderModel(
  adapter: MemoryEmbeddingProviderAdapter,
  requestedModel: string,
): string {
  const trimmed = requestedModel.trim();
  if (trimmed) {
    return trimmed;
  }
  return adapter.defaultModel ?? "";
}

export function resolveEmbeddingProviderFallbackModel(
  providerId: string,
  fallbackSourceModel: string,
  config?: MemoryEmbeddingProviderCreateOptions["config"],
): string {
  const adapter = getMemoryEmbeddingProvider(providerId, config);
  return adapter?.defaultModel ?? fallbackSourceModel;
}

async function createWithAdapter(
  adapter: MemoryEmbeddingProviderAdapter,
  options: CreateEmbeddingProviderOptions,
): Promise<EmbeddingProviderResult> {
  const result = await adapter.create({
    ...options,
    model: resolveProviderModel(adapter, options.model),
  });
  return {
    provider: result.provider,
    requestedProvider: options.provider,
    runtime: result.runtime,
  };
}

export async function createEmbeddingProvider(
  options: CreateEmbeddingProviderOptions,
): Promise<EmbeddingProviderResult> {
  if (options.provider === "auto") {
    const reasons: string[] = [];
    for (const adapter of listAutoSelectAdapters(options)) {
      try {
        const result = await createWithAdapter(adapter, {
          ...options,
          provider: adapter.id,
        });
        return {
          ...result,
          requestedProvider: "auto",
        };
      } catch (err) {
        const message = formatProviderError(adapter, err);
        if (shouldContinueAutoSelection(adapter, err)) {
          reasons.push(message);
          continue;
        }
        const wrapped = new Error(message) as Error & { cause?: unknown };
        wrapped.cause = err;
        throw wrapped;
      }
    }
    return {
      provider: null,
      requestedProvider: "auto",
      providerUnavailableReason:
        reasons.length > 0 ? reasons.join("\n\n") : "No embeddings provider available.",
    };
  }

  const primaryAdapter = getAdapter(options.provider, options.config);
  try {
    return await createWithAdapter(primaryAdapter, options);
  } catch (primaryErr) {
    const reason = formatProviderError(primaryAdapter, primaryErr);
    if (options.fallback && options.fallback !== "none" && options.fallback !== options.provider) {
      const fallbackAdapter = getAdapter(options.fallback, options.config);
      try {
        const fallbackResult = await createWithAdapter(fallbackAdapter, {
          ...options,
          provider: options.fallback,
        });
        return {
          ...fallbackResult,
          requestedProvider: options.provider,
          fallbackFrom: options.provider,
          fallbackReason: reason,
        };
      } catch (fallbackErr) {
        const fallbackReason = formatProviderError(fallbackAdapter, fallbackErr);
        const wrapped = new Error(
          `${reason}\n\nFallback to ${options.fallback} failed: ${fallbackReason}`,
        ) as Error & { cause?: unknown };
        wrapped.cause = primaryErr;
        throw wrapped;
      }
    }
    const wrapped = new Error(reason) as Error & { cause?: unknown };
    wrapped.cause = primaryErr;
    throw wrapped;
  }
}
