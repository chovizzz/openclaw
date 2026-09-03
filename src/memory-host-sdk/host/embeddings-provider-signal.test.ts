import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as authModule from "../../agents/model-auth.js";

// `remote-http.ts` is a two-export module, so partial-mocking it is cheap and keeps
// `buildRemoteBaseUrlPolicy` real (the gemini/voyage client resolvers call it).
// Asserting at this seam is what proves the caller signal is handed to
// `fetchWithSsrFGuard` as a TOP-LEVEL `signal` rather than buried in `init.signal`,
// which the guard would overwrite with its own derived signal.
const withRemoteHttpResponseMock = vi.hoisted(() => vi.fn());

vi.mock("./remote-http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./remote-http.js")>();
  return { ...actual, withRemoteHttpResponse: withRemoteHttpResponseMock };
});

vi.mock("../../agents/model-auth.js", async () => {
  const { createModelAuthMockModule } = await import("../../test-utils/model-auth-mock.js");
  return createModelAuthMockModule();
});

let createVoyageEmbeddingProvider: typeof import("./embeddings-voyage.js").createVoyageEmbeddingProvider;
let createGeminiEmbeddingProvider: typeof import("./embeddings-gemini.js").createGeminiEmbeddingProvider;

beforeAll(async () => {
  ({ createVoyageEmbeddingProvider } = await import("./embeddings-voyage.js"));
  ({ createGeminiEmbeddingProvider } = await import("./embeddings-gemini.js"));
});

beforeEach(() => {
  withRemoteHttpResponseMock.mockReset();
  vi.mocked(authModule.resolveApiKeyForProvider).mockResolvedValue({
    apiKey: "test-key-123",
    mode: "api-key",
    source: "test",
  });
});

/** The `signal` the provider handed to `withRemoteHttpResponse` on call `index`. */
function forwardedSignal(index = 0): AbortSignal | undefined {
  return (withRemoteHttpResponseMock.mock.calls[index]?.[0] as { signal?: AbortSignal } | undefined)
    ?.signal;
}

describe("embedQuery signal forwarding", () => {
  it("voyage forwards the caller signal to the guarded fetch", async () => {
    withRemoteHttpResponseMock.mockResolvedValue([[0.1, 0.2]]);
    const { provider } = await createVoyageEmbeddingProvider({
      config: {} as never,
      provider: "voyage",
      model: "voyage-4-large",
      fallback: "none",
    });
    const controller = new AbortController();

    await provider.embedQuery("hello", { signal: controller.signal });
    expect(forwardedSignal()).toBe(controller.signal);

    await provider.embedQuery("hello");
    expect(forwardedSignal(1)).toBeUndefined();
  });

  it("voyage leaves embedBatch on the unsignalled path", async () => {
    withRemoteHttpResponseMock.mockResolvedValue([[0.1, 0.2]]);
    const { provider } = await createVoyageEmbeddingProvider({
      config: {} as never,
      provider: "voyage",
      model: "voyage-4-large",
      fallback: "none",
    });

    await provider.embedBatch(["hello"]);
    expect(forwardedSignal()).toBeUndefined();
  });

  it("gemini forwards the caller signal through the api-key rotation wrapper", async () => {
    withRemoteHttpResponseMock.mockResolvedValue({ embedding: { values: [0.1, 0.2] } });
    const { provider } = await createGeminiEmbeddingProvider({
      config: {} as never,
      provider: "gemini",
      model: "gemini-embedding-001",
      fallback: "none",
    });
    const controller = new AbortController();

    await provider.embedQuery("hello", { signal: controller.signal });
    // The request is built inside `executeWithApiKeyRotation`'s callback, so this
    // also proves the signal survives that indirection.
    expect(forwardedSignal()).toBe(controller.signal);

    await provider.embedQuery("hello");
    expect(forwardedSignal(1)).toBeUndefined();
  });
});
