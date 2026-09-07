// Thread-binding message tests cover user-visible names and lifecycle text.
import { describe, expect, it } from "vitest";
import {
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "./thread-bindings-messages.js";

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}
function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
function hasDanglingSurrogate(value: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}

describe("thread-binding names", () => {
  it("does not split surrogate pairs at native name limits (thread name, 100 char cap)", () => {
    // resolveThreadBindingThreadName builds "🤖 " + label then truncates to 100 units.
    // "🤖 " is 3 units (surrogate pair + space); 96 leading x's brings us to index 99,
    // where the 🚀 emoji's surrogate pair sits at indices 99-100 -- straddling the
    // cut point at 100.
    const label = `${"x".repeat(96)}\u{1F680}tail`;
    const raw = `🤖 ${label}`.replace(/\s+/g, " ").trim();
    expect(isHighSurrogate(raw.charCodeAt(99))).toBe(true);
    expect(isLowSurrogate(raw.charCodeAt(100))).toBe(true);
    expect(raw.length).toBeGreaterThan(100);

    const threadName = resolveThreadBindingThreadName({ label });

    expect(threadName).toBe(`🤖 ${"x".repeat(96)}`);
    expect(hasDanglingSurrogate(threadName)).toBe(false);
  });

  it("does not split surrogate pairs at native name limits (intro text, 100 char cap)", () => {
    // resolveThreadBindingIntroText truncates the raw label (no "🤖 " prefix) to 100
    // units. 99 leading x's brings the cut point to index 99, right at the 🚀 pair.
    const label = `${"x".repeat(99)}\u{1F680}tail`;
    expect(isHighSurrogate(label.charCodeAt(99))).toBe(true);
    expect(isLowSurrogate(label.charCodeAt(100))).toBe(true);
    expect(label.length).toBeGreaterThan(100);

    const intro = resolveThreadBindingIntroText({ label });

    expect(intro).toContain(`${"x".repeat(99)} session active`);
    expect(hasDanglingSurrogate(intro)).toBe(false);
  });

  it("does not shorten a thread name whose cut point lands on a normal character boundary", () => {
    // No surrogate pairs anywhere near index 100: truncation must keep exactly
    // 100 units, not drop an extra one defensively.
    const label = `${"y".repeat(97)}tail`;
    const raw = `🤖 ${label}`.replace(/\s+/g, " ").trim();
    expect(isHighSurrogate(raw.charCodeAt(100))).toBe(false);
    expect(isLowSurrogate(raw.charCodeAt(100))).toBe(false);
    expect(raw.length).toBeGreaterThan(100);

    const threadName = resolveThreadBindingThreadName({ label });

    expect(threadName).toBe(raw.slice(0, 100));
    expect(threadName.length).toBe(100);
  });

  it("returns short labels unchanged", () => {
    const threadName = resolveThreadBindingThreadName({ label: "short" });
    expect(threadName).toBe("🤖 short");
  });
});
