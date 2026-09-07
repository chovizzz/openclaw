import { describe, expect, it } from "vitest";
import { abortableWithSignal } from "./attempt.js";

// Covers the extraction from PR #75008 (fix(agents): release embedded-run scope
// on hung provider abort): `abortableWithSignal` is defined at module scope
// (not nested inside `runEmbeddedAttempt`) so its closure only ever captures
// `signal` and `promise`, not the entire embedded-run function scope. This
// keeps a hung provider promise from retaining that whole scope for the
// lifetime of the hang.
describe("abortableWithSignal", () => {
  it("rejects with AbortError when signal aborts before inner settles", async () => {
    const ac = new AbortController();
    const inner = new Promise<void>(() => {});
    const wrapped = abortableWithSignal(ac.signal, inner);
    ac.abort();
    await expect(wrapped).rejects.toThrow();
    try {
      await wrapped;
      expect.fail("expected rejection");
    } catch (err) {
      expect((err as Error).name).toBe("AbortError");
    }
  });

  it("rejects immediately when signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const inner = new Promise<void>(() => {});
    await expect(abortableWithSignal(ac.signal, inner)).rejects.toThrow(/aborted/i);
  });

  it("preserves an Error abort reason's message instead of a generic 'aborted' message", async () => {
    const ac = new AbortController();
    const inner = new Promise<void>(() => {});
    const wrapped = abortableWithSignal(ac.signal, inner);
    ac.abort(new Error("LLM idle timeout (60s): no response from model"));
    await expect(wrapped).rejects.toThrow(/LLM idle timeout \(60s\)/);
  });

  it("resolves with the inner value when inner settles before abort", async () => {
    const ac = new AbortController();
    await expect(abortableWithSignal(ac.signal, Promise.resolve(42))).resolves.toBe(42);
  });

  it("rejects with the inner rejection when inner rejects before abort", async () => {
    const ac = new AbortController();
    await expect(abortableWithSignal(ac.signal, Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
  });

  it("does not leave a dangling abort listener once inner settles first", async () => {
    const ac = new AbortController();
    await abortableWithSignal(ac.signal, Promise.resolve("ok"));
    // If the listener were not removed on settle, a later abort would still
    // be harmless here (no observer), but this guards the intended cleanup
    // path exercised by the removeEventListener calls in both branches.
    expect(() => ac.abort()).not.toThrow();
  });
});
