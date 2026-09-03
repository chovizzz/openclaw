import { afterEach, describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import {
  buildUsageErrorSnapshot,
  buildUsageHttpErrorSnapshot,
  fetchJson,
  MAX_TIMER_TIMEOUT_MS,
  parseFiniteNumber,
} from "./provider-usage.fetch.shared.js";

describe("provider usage fetch shared helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds a provider error snapshot", () => {
    expect(buildUsageErrorSnapshot("zai", "API error")).toEqual({
      provider: "zai",
      displayName: "z.ai",
      windows: [],
      error: "API error",
    });
  });

  it.each([
    { value: 12, expected: 12 },
    { value: "12.5", expected: 12.5 },
    { value: "not-a-number", expected: undefined },
  ])("parses finite numbers for %j", ({ value, expected }) => {
    expect(parseFiniteNumber(value)).toBe(expected);
  });

  it("forwards request init with a deadline signal", async () => {
    const fetchFnMock = vi.fn(
      async (_input: URL | RequestInfo, init?: RequestInit) =>
        new Response(JSON.stringify({ aborted: init?.signal?.aborted ?? false }), { status: 200 }),
    );
    const fetchFn = withFetchPreconnect(fetchFnMock);

    const response = await fetchJson(
      "https://example.com/usage",
      {
        method: "POST",
        headers: { authorization: "Bearer test" },
      },
      1_000,
      fetchFn,
    );

    expect(fetchFnMock).toHaveBeenCalledWith(
      "https://example.com/usage",
      expect.objectContaining({
        method: "POST",
        headers: { authorization: "Bearer test" },
        signal: expect.any(AbortSignal),
      }),
    );
    await expect(response.json()).resolves.toEqual({ aborted: false });
  });

  it("aborts timed out requests", async () => {
    const fetchFnMock = vi.fn(
      (_input: URL | RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted by timeout")), {
            once: true,
          });
        }),
    );
    const fetchFn = withFetchPreconnect(fetchFnMock);

    await expect(fetchJson("https://example.com/usage", {}, 10, fetchFn)).rejects.toThrow(
      "aborted by timeout",
    );
  });

  it("keeps the deadline active while the response body is read", async () => {
    let signal: AbortSignal | undefined;
    const fetchFnMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
            // Body never completes: only a still-live deadline signal can unstick it.
            signal?.addEventListener("abort", () => controller.error(signal?.reason), {
              once: true,
            });
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const fetchFn = withFetchPreconnect(fetchFnMock);

    const response = await fetchJson("https://example.com/usage", {}, 10, fetchFn);

    await expect(response.text()).rejects.toBeDefined();
    expect(signal?.aborted).toBe(true);
  });

  it("keeps caller cancellation active while the response body is read", async () => {
    const callerAbort = new AbortController();
    const callerReason = new Error("cancelled by caller");
    let signal: AbortSignal | undefined;
    const fetchFnMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener("abort", () => controller.error(signal?.reason), {
              once: true,
            });
          },
        }),
      );
    });
    const fetchFn = withFetchPreconnect(fetchFnMock);

    const response = await fetchJson(
      "https://example.com/usage",
      { signal: callerAbort.signal },
      1_000,
      fetchFn,
    );
    const bodyRead = response.text();
    callerAbort.abort(callerReason);

    await expect(bodyRead).rejects.toBe(callerReason);
    expect(signal?.reason).toBe(callerReason);
  });

  it("caps oversized request timeouts before scheduling", async () => {
    // An unclamped value overflows Node's timer and would abort after ~1ms.
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(new AbortController().signal);
    const fetchFnMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const fetchFn = withFetchPreconnect(fetchFnMock);

    await fetchJson("https://example.com/usage", {}, MAX_TIMER_TIMEOUT_MS + 1_000_000, fetchFn);

    expect(timeoutSpy).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
  });

  it("maps configured status codes to token expired", () => {
    const snapshot = buildUsageHttpErrorSnapshot({
      provider: "openai-codex",
      status: 401,
      tokenExpiredStatuses: [401, 403],
    });

    expect(snapshot.error).toBe("Token expired");
    expect(snapshot.provider).toBe("openai-codex");
    expect(snapshot.windows).toHaveLength(0);
  });

  it("includes trimmed API error messages in HTTP errors", () => {
    const snapshot = buildUsageHttpErrorSnapshot({
      provider: "anthropic",
      status: 403,
      message: " missing scope ",
    });

    expect(snapshot.error).toBe("HTTP 403: missing scope");
  });

  it("omits empty HTTP error message suffixes", () => {
    const snapshot = buildUsageHttpErrorSnapshot({
      provider: "anthropic",
      status: 429,
      message: "   ",
    });

    expect(snapshot.error).toBe("HTTP 429");
  });
});
