import { describe, expect, it } from "vitest";
import {
  DEFAULT_INPUT_FILE_MAX_CHARS,
  extractFileContentFromSource,
  resolveInputFileLimits,
} from "./input-files.js";

describe("extractFileContentFromSource text clamping", () => {
  it("backs off from a UTF-16 surrogate pair straddling the max-chars limit", async () => {
    const prefix = "a".repeat(DEFAULT_INPUT_FILE_MAX_CHARS - 1);
    const text = `${prefix}😀tail`;

    // Sanity check: confirm the naive `.slice(0, maxChars)` cut point really
    // does land between the high and low surrogate of the emoji for this
    // input, so this test proves the fix rather than passing trivially.
    const highSurrogate = text.charCodeAt(DEFAULT_INPUT_FILE_MAX_CHARS - 1);
    const lowSurrogate = text.charCodeAt(DEFAULT_INPUT_FILE_MAX_CHARS);
    expect(highSurrogate).toBeGreaterThanOrEqual(0xd800);
    expect(highSurrogate).toBeLessThanOrEqual(0xdbff);
    expect(lowSurrogate).toBeGreaterThanOrEqual(0xdc00);
    expect(lowSurrogate).toBeLessThanOrEqual(0xdfff);

    const result = await extractFileContentFromSource({
      source: {
        type: "base64",
        data: Buffer.from(text, "utf8").toString("base64"),
        mediaType: "text/plain",
        filename: "emoji-boundary.txt",
      },
      limits: resolveInputFileLimits(),
    });

    // The safe truncation drops the entire straddling surrogate pair rather
    // than emitting a lone surrogate / replacement character.
    expect(result.text).toBe(prefix);
    expect(result.text).not.toMatch(/[\ud800-\udfff]/u);
    expect(result.text).not.toContain("😀");
  });

  it("does not shorten ASCII text whose length lands exactly on the max-chars limit", async () => {
    const text = "a".repeat(DEFAULT_INPUT_FILE_MAX_CHARS);

    const result = await extractFileContentFromSource({
      source: {
        type: "base64",
        data: Buffer.from(text, "utf8").toString("base64"),
        mediaType: "text/plain",
        filename: "aligned.txt",
      },
      limits: resolveInputFileLimits(),
    });

    expect(result.text).toBe(text);
    expect(result.text?.length).toBe(DEFAULT_INPUT_FILE_MAX_CHARS);
  });
});
