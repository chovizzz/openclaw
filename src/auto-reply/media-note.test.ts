import { describe, expect, it } from "vitest";
import { buildInboundMediaNote } from "./media-note.js";
import { createSuccessfulImageMediaDecision } from "./media-understanding.test-fixtures.js";

describe("buildInboundMediaNote", () => {
  it("formats single MediaPath as a media note (collapses redundant duplicate URL, #47587)", () => {
    // When the channel mirrors the local path into MediaUrl (Telegram album
    // media is the canonical case), the formatter should not render `path | path`.
    const note = buildInboundMediaNote({
      MediaPath: "/tmp/a.png",
      MediaType: "image/png",
      MediaUrl: "/tmp/a.png",
    });
    expect(note).toBe("[media attached: /tmp/a.png (image/png)]");
  });

  it("formats multiple MediaPaths as numbered media notes (collapses duplicate URLs, #47587)", () => {
    const note = buildInboundMediaNote({
      MediaPaths: ["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"],
      MediaUrls: ["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"],
    });
    expect(note).toBe(
      [
        "[media attached: 3 files]",
        "[media attached 1/3: /tmp/a.png]",
        "[media attached 2/3: /tmp/b.png]",
        "[media attached 3/3: /tmp/c.png]",
      ].join("\n"),
    );
  });

  // Reverse coverage for #47587: only a URL that is genuinely identical to the
  // path may be dropped. A distinct URL carries information and must survive.
  it("preserves a URL that differs from the local path (#47587)", () => {
    const single = buildInboundMediaNote({
      MediaPath: "/tmp/a.png",
      MediaType: "image/png",
      MediaUrl: "https://example.com/a.png",
    });
    expect(single).toBe("[media attached: /tmp/a.png (image/png) | https://example.com/a.png]");
  });

  it("dedupes per entry so a mixed batch keeps its distinct URLs (#47587)", () => {
    // Index 0 mirrors the path (drop the suffix); index 1 has a real remote URL
    // (keep it). Each entry is decided independently.
    const mixed = buildInboundMediaNote({
      MediaPaths: ["/tmp/local.png", "/tmp/remote.png"],
      MediaUrls: ["/tmp/local.png", "https://example.com/remote.png"],
    });
    expect(mixed).toBe(
      [
        "[media attached: 2 files]",
        "[media attached 1/2: /tmp/local.png]",
        "[media attached 2/2: /tmp/remote.png | https://example.com/remote.png]",
      ].join("\n"),
    );
  });

  it("keeps a URL whose path prefix matches but which is not identical (#47587)", () => {
    // Near-miss: the URL merely contains the path. It is still a different
    // value and must not be collapsed.
    const note = buildInboundMediaNote({
      MediaPath: "/tmp/a.png",
      MediaUrl: "https://example.com/tmp/a.png",
    });
    expect(note).toBe("[media attached: /tmp/a.png | https://example.com/tmp/a.png]");
  });

  it("skips media notes for attachments with understanding output", () => {
    const note = buildInboundMediaNote({
      MediaPaths: ["/tmp/a.png", "/tmp/b.png"],
      MediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
      MediaUnderstanding: [
        {
          kind: "audio.transcription",
          attachmentIndex: 0,
          text: "hello",
          provider: "groq",
        },
      ],
    });
    expect(note).toBe("[media attached: /tmp/b.png | https://example.com/b.png]");
  });

  it("only suppresses attachments when media understanding succeeded", () => {
    const note = buildInboundMediaNote({
      MediaPaths: ["/tmp/a.png", "/tmp/b.png"],
      MediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
      MediaUnderstandingDecisions: [
        {
          capability: "image",
          outcome: "skipped",
          attachments: [
            {
              attachmentIndex: 0,
              attempts: [
                {
                  type: "provider",
                  outcome: "skipped",
                  reason: "maxBytes: too large",
                },
              ],
            },
          ],
        },
      ],
    });
    expect(note).toBe(
      [
        "[media attached: 2 files]",
        "[media attached 1/2: /tmp/a.png | https://example.com/a.png]",
        "[media attached 2/2: /tmp/b.png | https://example.com/b.png]",
      ].join("\n"),
    );
  });

  it("suppresses attachments when media understanding succeeds via decisions", () => {
    const note = buildInboundMediaNote({
      MediaPaths: ["/tmp/a.png", "/tmp/b.png"],
      MediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
      MediaUnderstandingDecisions: [
        createSuccessfulImageMediaDecision() as unknown as NonNullable<
          Parameters<typeof buildInboundMediaNote>[0]["MediaUnderstandingDecisions"]
        >[number],
      ],
    });
    expect(note).toBe("[media attached: /tmp/b.png | https://example.com/b.png]");
  });

  it("strips audio attachments when transcription succeeded via MediaUnderstanding (issue #4197)", () => {
    const note = buildInboundMediaNote({
      MediaPaths: ["/tmp/voice.ogg", "/tmp/image.png"],
      MediaUrls: ["https://example.com/voice.ogg", "https://example.com/image.png"],
      MediaTypes: ["audio/ogg", "image/png"],
      MediaUnderstanding: [
        {
          kind: "audio.transcription",
          attachmentIndex: 0,
          text: "Hello world",
          provider: "whisper",
        },
      ],
    });
    // Audio attachment should be stripped (already transcribed), image should remain
    expect(note).toBe(
      "[media attached: /tmp/image.png (image/png) | https://example.com/image.png]",
    );
  });

  it("only strips audio attachments that were transcribed", () => {
    const note = buildInboundMediaNote({
      MediaPaths: ["/tmp/voice-1.ogg", "/tmp/voice-2.ogg"],
      MediaUrls: ["https://example.com/voice-1.ogg", "https://example.com/voice-2.ogg"],
      MediaTypes: ["audio/ogg", "audio/ogg"],
      MediaUnderstanding: [
        {
          kind: "audio.transcription",
          attachmentIndex: 0,
          text: "First transcript",
          provider: "whisper",
        },
      ],
    });
    expect(note).toBe(
      "[media attached: /tmp/voice-2.ogg (audio/ogg) | https://example.com/voice-2.ogg]",
    );
  });

  it("strips audio attachments when Transcript is present (issue #4197)", () => {
    const note = buildInboundMediaNote({
      MediaPaths: ["/tmp/voice.opus"],
      MediaTypes: ["audio/opus"],
      Transcript: "Hello world from Whisper",
    });
    // Audio should be stripped when transcript is available
    expect(note).toBeUndefined();
  });

  it("does not strip multiple audio attachments using transcript-only fallback", () => {
    const note = buildInboundMediaNote({
      MediaPaths: ["/tmp/voice-1.ogg", "/tmp/voice-2.ogg"],
      MediaTypes: ["audio/ogg", "audio/ogg"],
      Transcript: "Transcript text without per-attachment mapping",
    });
    expect(note).toBe(
      [
        "[media attached: 2 files]",
        "[media attached 1/2: /tmp/voice-1.ogg (audio/ogg)]",
        "[media attached 2/2: /tmp/voice-2.ogg (audio/ogg)]",
      ].join("\n"),
    );
  });

  it("strips audio by extension even without mime type (issue #4197)", () => {
    const note = buildInboundMediaNote({
      MediaPaths: ["/tmp/voice_message.ogg", "/tmp/document.pdf"],
      MediaUnderstanding: [
        {
          kind: "audio.transcription",
          attachmentIndex: 0,
          text: "Transcribed audio content",
          provider: "whisper",
        },
      ],
    });
    // Only PDF should remain, audio stripped by extension
    expect(note).toBe("[media attached: /tmp/document.pdf]");
  });

  it("keeps audio attachments when no transcription available", () => {
    const note = buildInboundMediaNote({
      MediaPaths: ["/tmp/voice.ogg"],
      MediaTypes: ["audio/ogg"],
    });
    // No transcription = keep audio attachment as fallback
    expect(note).toBe("[media attached: /tmp/voice.ogg (audio/ogg)]");
  });
});
