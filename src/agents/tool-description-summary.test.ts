import { describe, expect, it } from "vitest";
import {
  describeToolForVerbose,
  summarizeToolDescriptionText,
} from "./tool-description-summary.js";

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}
function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
function hasDanglingSurrogate(value: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}

describe("tool description summaries", () => {
  it("keeps compact summaries UTF-16 safe at truncation boundaries", () => {
    // "abcd" occupies indices 0-3, the 😀 surrogate pair occupies indices 4-5.
    // With maxLen=8 the naive cut is at maxLen-3=5, landing between the two
    // surrogate halves. Confirm that first.
    const input = "abcd\u{1F600} efgh";
    expect(isHighSurrogate(input.charCodeAt(4))).toBe(true);
    expect(isLowSurrogate(input.charCodeAt(5))).toBe(true);

    const summary = summarizeToolDescriptionText({
      displaySummary: input,
      maxLen: 8,
    });

    expect(summary).toBe("abcd...");
    expect(hasDanglingSurrogate(summary)).toBe(false);
  });

  it("keeps verbose descriptions UTF-16 safe at truncation boundaries", () => {
    const input = "abcd\u{1F600} efgh";
    expect(isHighSurrogate(input.charCodeAt(4))).toBe(true);
    expect(isLowSurrogate(input.charCodeAt(5))).toBe(true);

    const description = describeToolForVerbose({
      rawDescription: input,
      fallback: "Tool",
      maxLen: 8,
    });

    expect(description).toBe("abcd...");
    expect(hasDanglingSurrogate(description)).toBe(false);
  });

  it("does not shorten a compact summary whose cut point lands on a normal character boundary", () => {
    // maxLen=8 -> cut point at index 5; no surrogate pair anywhere near it, and
    // no space before the cut (boundary check requires >=48), so the plain
    // 5-char slice is kept verbatim.
    const input = "abcdefgh ijkl";
    expect(isHighSurrogate(input.charCodeAt(5))).toBe(false);
    expect(isLowSurrogate(input.charCodeAt(5))).toBe(false);

    const summary = summarizeToolDescriptionText({
      displaySummary: input,
      maxLen: 8,
    });

    expect(summary).toBe("abcde...");
  });

  it("returns short summaries unchanged", () => {
    const summary = summarizeToolDescriptionText({ displaySummary: "short" });
    expect(summary).toBe("short");
  });
});
