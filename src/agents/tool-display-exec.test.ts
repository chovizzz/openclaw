/**
 * Regression coverage for surrogate-safe truncation of the compact raw-command
 * detail rendered for exec tool calls (compactRawCommand, reached via
 * resolveExecDetail).
 */
import { describe, expect, it } from "vitest";
import { resolveExecDetail } from "./tool-display-exec.js";

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

describe("compactRawCommand surrogate-safe truncation (via resolveExecDetail)", () => {
  it("does not split an emoji straddling the truncation cut point (default maxLength=120)", () => {
    // compactRawCommand truncates the one-line command to Math.max(0, maxLength - 1) = 119
    // when it exceeds maxLength=120. Use an unknown binary so summarizeExecCommand
    // yields a generic summary and resolveExecDetail returns the compact raw form.
    const cutPoint = 120 - 1;
    const prefix = "/opt/custom/bin/run ";
    const filler = "a".repeat(cutPoint - prefix.length);
    const longCommand = `${prefix}${filler}\u{1F600}${"b".repeat(50)}`;
    const oneLine = longCommand
      .replace(/\s*\n\s*/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();

    // Sanity: confirm the cut point genuinely lands inside the surrogate pair.
    expect(isHighSurrogate(oneLine.charCodeAt(cutPoint))).toBe(true);
    expect(isLowSurrogate(oneLine.charCodeAt(cutPoint + 1))).toBe(true);
    expect(oneLine.length).toBeGreaterThan(120);

    const result = resolveExecDetail({ command: longCommand });

    expect(result).toBeDefined();
    // The whole emoji is dropped at the boundary rather than half of it.
    expect(hasLoneSurrogate(result as string)).toBe(false);
    expect(result).toBe(`${prefix}${filler}…`);
  });

  it("leaves plain (non-surrogate) long commands truncated as before, with the cut point unchanged", () => {
    const longCommand = `/opt/custom/bin/run ${"x".repeat(200)}`;
    const result = resolveExecDetail({ command: longCommand });

    // Behavior-preserving: cut point stays at maxLength - 1 = 119.
    const oneLine = longCommand
      .replace(/\s*\n\s*/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    expect(result).toBe(`${oneLine.slice(0, 119)}…`);
    expect(hasLoneSurrogate(result as string)).toBe(false);
  });

  it("does not shorten a command whose cut point lands on a normal character boundary", () => {
    const cutPoint = 120 - 1;
    const prefix = "/opt/custom/bin/run ";
    const filler = "c".repeat(cutPoint - prefix.length);
    const longCommand = `${prefix}${filler}d${"e".repeat(50)}`;
    const oneLine = longCommand
      .replace(/\s*\n\s*/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    expect(isHighSurrogate(oneLine.charCodeAt(cutPoint))).toBe(false);
    expect(isLowSurrogate(oneLine.charCodeAt(cutPoint))).toBe(false);

    const result = resolveExecDetail({ command: longCommand });

    expect(result).toBe(`${prefix}${filler}…`);
  });

  it("returns short commands unchanged", () => {
    const result = resolveExecDetail({ command: "echo hi" });
    expect(result).toContain("echo hi");
  });
});
