import { describe, expect, it } from "vitest";
import { sanitizeChatHistoryMessages } from "./chat.js";

const MAX_CHARS = 10_000;

describe("sanitizeChatHistoryMessages audio redaction", () => {
  it("omits base64 audio payloads from chat history", () => {
    const data = Buffer.from("voice-bytes").toString("base64");
    const result = sanitizeChatHistoryMessages(
      [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Audio reply" },
            {
              type: "audio",
              source: { type: "base64", media_type: "audio/mp3", data },
            },
          ],
          timestamp: 1,
        },
      ],
      MAX_CHARS,
    );

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(data);
    // Negative half: every non-payload field around the audio survives.
    expect(result).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Audio reply" },
          {
            type: "audio",
            source: {
              type: "base64",
              media_type: "audio/mp3",
              omitted: true,
              bytes: Buffer.byteLength(data, "utf8"),
            },
          },
        ],
        timestamp: 1,
      },
    ]);
  });

  it("leaves non-base64 audio sources untouched", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "audio", source: { type: "url", url: "https://example.test/a.mp3" } }],
        timestamp: 2,
      },
    ];
    expect(sanitizeChatHistoryMessages(structuredClone(messages), MAX_CHARS)).toEqual(messages);
  });

  it("still omits base64 image payloads", () => {
    const data = Buffer.from("png-bytes").toString("base64");
    const result = sanitizeChatHistoryMessages(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", data, mimeType: "image/png" },
          ],
          timestamp: 3,
        },
      ],
      MAX_CHARS,
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(data);
    expect(serialized).toContain("image/png");
    expect(serialized).toContain("look");
  });
});
