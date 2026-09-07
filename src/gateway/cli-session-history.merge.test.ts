import { describe, expect, it } from "vitest";
import { mergeImportedChatHistoryMessages } from "./cli-session-history.merge.js";

const assistant = (text: string, timestamp = 1_000) => ({
  role: "assistant",
  content: text,
  timestamp,
});

describe("mergeImportedChatHistoryMessages", () => {
  it("returns local messages untouched when there is nothing to import", () => {
    const local = [assistant("hello")];
    expect(
      mergeImportedChatHistoryMessages({ localMessages: local, importedMessages: [] }),
    ).toEqual(local);
  });

  it("appends a genuinely new imported message", () => {
    const merged = mergeImportedChatHistoryMessages({
      localMessages: [assistant("first", 1_000)],
      importedMessages: [assistant("second", 2_000)],
    });
    expect(merged).toHaveLength(2);
  });

  describe("directive-tag-insensitive dedupe (#125030)", () => {
    it("drops a reload-imported reply that differs only by an inline reply tag", () => {
      // After a reload the Claude CLI re-emits the same reply with its inline
      // directive tags rendered. Comparing raw text let the identical reply
      // through a second time, so the user saw it twice.
      const merged = mergeImportedChatHistoryMessages({
        localMessages: [assistant("Here is the answer.")],
        importedMessages: [assistant("[[reply_to_current]]Here is the answer.")],
      });
      expect(merged).toHaveLength(1);
      expect((merged[0] as { content: string }).content).toBe("Here is the answer.");
    });

    it("drops a reload-imported reply that differs only by an audio tag", () => {
      const merged = mergeImportedChatHistoryMessages({
        localMessages: [assistant("Here is the answer.")],
        importedMessages: [assistant("[[audio_as_voice]] Here is the answer.")],
      });
      expect(merged).toHaveLength(1);
    });

    // Reverse coverage. Dedupe must key on the *visible* text only. Two replies
    // whose visible text genuinely differs must both survive, even when they are
    // near-identical and carry the same directive tags. Dropping one here would
    // lose a real message, which is worse than showing a duplicate.
    it("keeps two replies whose visible text differs by one word", () => {
      const merged = mergeImportedChatHistoryMessages({
        localMessages: [assistant("Deploy succeeded on staging.", 1_000)],
        importedMessages: [assistant("Deploy succeeded on production.", 1_100)],
      });
      expect(merged).toHaveLength(2);
    });

    it("keeps two replies that differ only outside the stripped tags", () => {
      const merged = mergeImportedChatHistoryMessages({
        localMessages: [assistant("[[reply_to_current]]Answer A", 1_000)],
        importedMessages: [assistant("[[reply_to_current]]Answer B", 1_100)],
      });
      expect(merged).toHaveLength(2);
    });

    it("keeps same-text replies from different roles", () => {
      const merged = mergeImportedChatHistoryMessages({
        localMessages: [{ role: "user", content: "status?", timestamp: 1_000 }],
        importedMessages: [{ role: "assistant", content: "status?", timestamp: 1_000 }],
      });
      expect(merged).toHaveLength(2);
    });

    it("keeps identical text sent far apart in time", () => {
      // Outside the 5 minute dedupe window these are two real occurrences.
      const merged = mergeImportedChatHistoryMessages({
        localMessages: [assistant("[[reply_to_current]]ping", 0)],
        importedMessages: [assistant("ping", 10 * 60 * 1000)],
      });
      expect(merged).toHaveLength(2);
    });
  });

  it("prefers the externalId when one is present", () => {
    const merged = mergeImportedChatHistoryMessages({
      localMessages: [{ ...assistant("old text"), __openclaw: { externalId: "x1" } }],
      importedMessages: [
        { ...assistant("totally different text"), __openclaw: { externalId: "x1" } },
      ],
    });
    expect(merged).toHaveLength(1);
  });
});
