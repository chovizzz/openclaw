import { describe, expect, it } from "vitest";
import { createDedupeCache, resolveDedupeNonNegativeInteger } from "./dedupe.js";

describe("createDedupeCache", () => {
  it("ignores blank cache keys", () => {
    const cache = createDedupeCache({ ttlMs: 1_000, maxSize: 10 });

    expect(cache.check("", 100)).toBe(false);
    expect(cache.check(undefined, 100)).toBe(false);
    expect(cache.peek(null, 100)).toBe(false);
    expect(cache.size()).toBe(0);
  });

  it("keeps entries indefinitely when ttlMs is zero or negative", () => {
    const zeroTtlCache = createDedupeCache({ ttlMs: 0, maxSize: 10 });
    expect(zeroTtlCache.check("a", 100)).toBe(false);
    expect(zeroTtlCache.check("a", 10_000)).toBe(true);

    const negativeTtlCache = createDedupeCache({ ttlMs: -100, maxSize: 10 });
    expect(negativeTtlCache.check("b", 100)).toBe(false);
    expect(negativeTtlCache.peek("b", 10_000)).toBe(true);
  });

  it("touches duplicate reads so the newest key survives max-size pruning", () => {
    const cache = createDedupeCache({ ttlMs: 10_000, maxSize: 2 });

    expect(cache.check("a", 100)).toBe(false);
    expect(cache.check("b", 200)).toBe(false);
    expect(cache.check("a", 300)).toBe(true);
    expect(cache.check("c", 400)).toBe(false);

    expect(cache.peek("a", 500)).toBe(true);
    expect(cache.peek("b", 500)).toBe(false);
    expect(cache.peek("c", 500)).toBe(true);
  });

  it("clears itself when maxSize floors to zero", () => {
    const cache = createDedupeCache({ ttlMs: 1_000, maxSize: 0.9 });

    expect(cache.check("a", 100)).toBe(false);
    expect(cache.size()).toBe(0);
    expect(cache.peek("a", 200)).toBe(false);
  });

  it("supports explicit reset", () => {
    const cache = createDedupeCache({ ttlMs: 1_000, maxSize: 10 });

    expect(cache.check("a", 100)).toBe(false);
    expect(cache.check("b", 200)).toBe(false);
    expect(cache.size()).toBe(2);

    cache.clear();

    expect(cache.size()).toBe(0);
    expect(cache.peek("a", 300)).toBe(false);
  });
  it("bounds non-finite retention options instead of poisoning arithmetic", () => {
    // NaN maxSize used to leave pruning a no-op (`maxSize <= 0` is false for NaN
    // and pruneMapToMaxSize's `while (size > NaN)` never runs), so the cache grew
    // without bound. It now falls back to 0 = "cache retains nothing".
    const nanCache = createDedupeCache({ ttlMs: Number.NaN, maxSize: Number.NaN });
    expect(nanCache.check("a", 100)).toBe(false);
    expect(nanCache.size()).toBe(0);
    expect(nanCache.check("a", 101)).toBe(false);

    const infiniteCache = createDedupeCache({
      ttlMs: Number.POSITIVE_INFINITY,
      maxSize: Number.POSITIVE_INFINITY,
    });
    expect(infiniteCache.check("a", 100)).toBe(false);
    expect(infiniteCache.size()).toBe(0);

    const negativeInfiniteCache = createDedupeCache({
      ttlMs: Number.NEGATIVE_INFINITY,
      maxSize: Number.NEGATIVE_INFINITY,
    });
    expect(negativeInfiniteCache.check("a", 100)).toBe(false);
    expect(negativeInfiniteCache.size()).toBe(0);
  });

  it("never reports a false duplicate for distinct keys under any retention option", () => {
    // Reverse test: bounding retention must only ever make dedupe do *less*.
    // Two similar-but-distinct payloads must both be delivered.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0]) {
      const cache = createDedupeCache({ ttlMs: bad, maxSize: bad });
      expect(cache.check("msg:hello world", 100)).toBe(false);
      expect(cache.check("msg:hello world.", 100)).toBe(false);
      expect(cache.check("msg:hello  world", 100)).toBe(false);
    }
  });

  it("resolveDedupeNonNegativeInteger clamps and falls back", () => {
    expect(resolveDedupeNonNegativeInteger(5.9, 7)).toBe(5);
    expect(resolveDedupeNonNegativeInteger(-3, 7)).toBe(0);
    expect(resolveDedupeNonNegativeInteger(0, 7)).toBe(0);
    expect(resolveDedupeNonNegativeInteger(Number.NaN, 7)).toBe(7);
    expect(resolveDedupeNonNegativeInteger(Number.POSITIVE_INFINITY, 7)).toBe(7);
    expect(resolveDedupeNonNegativeInteger(Number.NEGATIVE_INFINITY, 7)).toBe(7);
  });
});
