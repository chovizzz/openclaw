/**
 * Regression coverage for surrogate-safe truncation in compact tool display
 * detail coercion (coerceDisplayValue, reached via resolveToolVerbAndDetailForArgs
 * -> resolveDetailFromKeys).
 */
import { describe, expect, it } from "vitest";
import { resolveToolVerbAndDetailForArgs } from "./tool-display-common.js";

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}
function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const codeUnit = value.charCodeAt(i);
    if (isHighSurrogate(codeUnit)) {
      if (i + 1 >= value.length || !isLowSurrogate(value.charCodeAt(i + 1))) {
        return true;
      }
    } else if (isLowSurrogate(codeUnit)) {
      if (i === 0 || !isHighSurrogate(value.charCodeAt(i - 1))) {
        return true;
      }
    }
  }
  return false;
}

describe("coerceDisplayValue surrogate-safe truncation", () => {
  it("does not split an emoji straddling the truncation cut point (default maxStringChars=160)", () => {
    // coerceDisplayValue truncates at Math.max(0, maxStringChars - 3) = 157 when
    // firstLine.length > 160. Build a string whose surrogate pair (an emoji)
    // straddles code unit index 157: 157 leading 'a's, then the emoji at
    // indices 157-158, then more 'b's past the limit.
    const cutPoint = 160 - 3;
    const detailValue = `${"a".repeat(cutPoint)}\u{1F600}${"b".repeat(50)}`;

    // Sanity: confirm the cut point genuinely lands inside the surrogate pair,
    // i.e. the code unit at the cut index is a high surrogate (the naive
    // `.slice(0, cutPoint)` would keep only that lone high surrogate).
    expect(isHighSurrogate(detailValue.charCodeAt(cutPoint))).toBe(true);
    expect(isLowSurrogate(detailValue.charCodeAt(cutPoint + 1))).toBe(true);
    expect(detailValue.length).toBeGreaterThan(160);

    const { detail } = resolveToolVerbAndDetailForArgs({
      toolKey: "custom_tool",
      args: { note: detailValue },
      fallbackDetailKeys: ["note"],
      detailMode: "first",
    });

    expect(detail).toBeDefined();
    // The pre-fix behavior rendered a lone high surrogate (U+FFFD on display);
    // the fix must drop the whole code point at the cut instead of splitting it.
    expect(hasLoneSurrogate(detail as string)).toBe(false);
    // The whole emoji is dropped (not half-kept): head keeps only the leading 'a's.
    expect(detail).toBe(`${"a".repeat(cutPoint)}…`);
  });

  it("leaves plain (non-surrogate) long values truncated as before, with the cut point unchanged", () => {
    const detailValue = "x".repeat(300);

    const { detail } = resolveToolVerbAndDetailForArgs({
      toolKey: "custom_tool",
      args: { note: detailValue },
      fallbackDetailKeys: ["note"],
      detailMode: "first",
    });

    // Behavior-preserving for ASCII: cut point stays at maxStringChars - 3 = 157.
    expect(detail).toBe(`${"x".repeat(157)}…`);
    expect(hasLoneSurrogate(detail as string)).toBe(false);
  });

  it("does not shorten a value whose cut point lands on a normal character boundary", () => {
    // No surrogate pairs anywhere near the cut point (index 157): truncation
    // must keep exactly 157 characters, not drop an extra one defensively.
    const detailValue = `${"c".repeat(157)}d${"e".repeat(50)}`;
    expect(isHighSurrogate(detailValue.charCodeAt(157))).toBe(false);
    expect(isLowSurrogate(detailValue.charCodeAt(157))).toBe(false);

    const { detail } = resolveToolVerbAndDetailForArgs({
      toolKey: "custom_tool",
      args: { note: detailValue },
      fallbackDetailKeys: ["note"],
      detailMode: "first",
    });

    expect(detail).toBe(`${"c".repeat(157)}…`);
  });

  it("returns short values unchanged", () => {
    const { detail } = resolveToolVerbAndDetailForArgs({
      toolKey: "custom_tool",
      args: { note: "short value with no emoji" },
      fallbackDetailKeys: ["note"],
      detailMode: "first",
    });
    expect(detail).toBe("short value with no emoji");
  });
});
