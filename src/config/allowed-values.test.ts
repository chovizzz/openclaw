import { describe, expect, it } from "vitest";
import { summarizeAllowedValues } from "./allowed-values.js";

describe("summarizeAllowedValues", () => {
  it("does not collapse mixed-type entries that stringify similarly", () => {
    const summary = summarizeAllowedValues([1, "1", 1, "1"]);
    expect(summary).not.toBeNull();
    if (!summary) {
      return;
    }
    expect(summary.hiddenCount).toBe(0);
    expect(summary.formatted).toContain('1, "1"');
    expect(summary.values).toHaveLength(2);
  });

  it("keeps distinct long values even when labels truncate the same way", () => {
    const prefix = "a".repeat(200);
    const summary = summarizeAllowedValues([`${prefix}x`, `${prefix}y`]);
    expect(summary).not.toBeNull();
    if (!summary) {
      return;
    }
    expect(summary.hiddenCount).toBe(0);
    expect(summary.values).toHaveLength(2);
    expect(summary.values[0]).not.toBe(summary.values[1]);
  });

  it("backs off from a UTF-16 surrogate pair straddling the 160-char hint limit", () => {
    const MAX_ALLOWED_VALUE_CHARS = 160;
    const prefix = "a".repeat(159);
    const value = `${prefix}😀tail`;

    // Sanity check: confirm the naive `.slice(0, 160)` cut point really does
    // land between the high and low surrogate of the emoji for this input,
    // so this test is proving the fix rather than passing trivially.
    expect(value.length).toBeGreaterThan(MAX_ALLOWED_VALUE_CHARS);
    const highSurrogate = value.charCodeAt(MAX_ALLOWED_VALUE_CHARS - 1);
    const lowSurrogate = value.charCodeAt(MAX_ALLOWED_VALUE_CHARS);
    expect(highSurrogate).toBeGreaterThanOrEqual(0xd800);
    expect(highSurrogate).toBeLessThanOrEqual(0xdbff);
    expect(lowSurrogate).toBeGreaterThanOrEqual(0xdc00);
    expect(lowSurrogate).toBeLessThanOrEqual(0xdfff);

    const summary = summarizeAllowedValues([value]);

    expect(summary).toStrictEqual({
      formatted: `"${prefix}... (+6 chars)"`,
      hiddenCount: 0,
      values: [value],
    });
    // The label must not contain a lone (unpaired) surrogate code unit.
    expect(summary?.formatted).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("does not shorten an ASCII value whose length lands exactly on the hint limit", () => {
    const value = "a".repeat(160);

    const summary = summarizeAllowedValues([value]);

    // Length is exactly at the limit (not over it), so no truncation marker
    // should appear and no characters should be dropped.
    expect(summary?.formatted).toBe(`"${value}"`);
    expect(summary?.formatted).not.toContain("chars)");
  });
});
