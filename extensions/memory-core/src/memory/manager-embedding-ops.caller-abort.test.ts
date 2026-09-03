import { describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "./embeddings.js";
import { MemoryManagerEmbeddingOps } from "./manager-embedding-ops.js";

/**
 * Minimal concrete subclass so `embedQueryWithTimeout` (protected) can be driven
 * directly. Only the fields the query path reads are populated; nothing here
 * touches sqlite or the filesystem.
 */
class EmbedQueryHarness extends MemoryManagerEmbeddingOps {
  protected readonly cfg = {} as never;
  protected readonly agentId = "test-agent";
  protected readonly workspaceDir = "/tmp/does-not-exist";
  protected readonly settings = {} as never;
  protected batch = {
    enabled: false,
    wait: false,
    concurrency: 1,
    pollIntervalMs: 1,
    timeoutMs: 1,
  };
  protected readonly vector = { enabled: false, available: false };
  protected readonly cache = { enabled: false };
  protected db = {} as never;
  protected batchFailureCount = 0;
  protected batchFailureLastError: string | undefined = undefined;
  protected batchFailureLastProvider: string | undefined = undefined;
  protected batchFailureLock = Promise.resolve();

  // Unreachable on the embedQuery path; present only to satisfy the abstract base.
  protected computeProviderKey(): string {
    throw new Error("not used by embedQueryWithTimeout");
  }
  protected async sync(): Promise<void> {
    throw new Error("not used by embedQueryWithTimeout");
  }
  protected getIndexConcurrency(): number {
    return 1;
  }
  protected pruneEmbeddingCacheIfNeeded(): void {}
  protected async indexFile(): Promise<void> {
    throw new Error("not used by embedQueryWithTimeout");
  }

  setProvider(provider: EmbeddingProvider | null) {
    this.provider = provider;
  }

  embedQueryForTest(text: string, signal?: AbortSignal) {
    return this.embedQueryWithTimeout(text, signal);
  }
}

function buildHarness(embedQuery: EmbeddingProvider["embedQuery"]) {
  const harness = new EmbedQueryHarness();
  harness.setProvider({
    id: "openai",
    model: "text-embedding-test",
    embedQuery,
    embedBatch: async () => [],
  });
  return harness;
}

describe("embedQueryWithTimeout provider signal forwarding", () => {
  it("hands the caller signal to the provider so a remote backend can cancel", async () => {
    const embedQuery = vi.fn(async (_text: string, opts?: { signal?: AbortSignal }) => {
      // Mirror a real remote provider: reject with the caller's own reason once
      // the signal fires, rather than resolving a vector nobody is waiting for.
      return await new Promise<number[]>((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true });
      });
    });
    const harness = buildHarness(embedQuery);
    const controller = new AbortController();
    const reason = new Error("memory_search deadline elapsed");

    const pending = harness.embedQueryForTest("hello", controller.signal);
    const settled = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await settled;

    expect(embedQuery).toHaveBeenCalledTimes(1);
    expect(embedQuery.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("calls through the original single-argument shape when there is no signal", async () => {
    const embedQuery = vi.fn(async () => [0.1, 0.2]);
    const harness = buildHarness(embedQuery);

    await expect(harness.embedQueryForTest("hello")).resolves.toEqual([0.1, 0.2]);
    expect(embedQuery).toHaveBeenCalledTimes(1);
    // No second argument at all, so a third-party provider that destructures
    // `opts` positionally still sees exactly what it saw before this seam.
    expect(embedQuery.mock.calls[0]).toHaveLength(1);
  });

  it("does not call the provider when the caller already aborted", async () => {
    const embedQuery = vi.fn(async () => [0.1, 0.2]);
    const harness = buildHarness(embedQuery);
    const controller = new AbortController();
    const reason = new Error("already canceled");
    controller.abort(reason);

    await expect(harness.embedQueryForTest("hello", controller.signal)).rejects.toBe(reason);
    expect(embedQuery).not.toHaveBeenCalled();
  });
});
