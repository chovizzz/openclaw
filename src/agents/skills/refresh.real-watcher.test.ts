import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type SkillsChangeEvent,
  ensureSkillsWatcher,
  registerSkillsChangeListener,
  resetSkillsRefreshForTest,
} from "./refresh.js";

// This suite intentionally does NOT mock chokidar. It exists to prove (not
// merely assert via a mock) that the skills watcher actually fires on real
// filesystem changes for the standard `<skillsRoot>/<skillName>/SKILL.md`
// layout. chokidar v4+ removed glob support, so a watch target like
// `<root>/*/SKILL.md` is matched as a literal path and never matches a real
// file -- see refresh.ts for the directory+filter approach that replaces it.
describe("ensureSkillsWatcher (real chokidar)", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    await resetSkillsRefreshForTest();
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("fires for a SKILL.md change in a skill subfolder, and not for unrelated file changes", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-watch-"));
    const skillsRoot = path.join(workspaceDir, "skills");
    const skillDir = path.join(skillsRoot, "my-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "initial\n");
    const otherDir = path.join(skillsRoot, "other-skill");
    await fs.mkdir(otherDir, { recursive: true });
    await fs.writeFile(path.join(otherDir, "notes.txt"), "irrelevant\n");

    const events: SkillsChangeEvent[] = [];
    const unregister = registerSkillsChangeListener((event) => {
      if (event.workspaceDir === workspaceDir) {
        events.push(event);
      }
    });

    try {
      ensureSkillsWatcher({
        workspaceDir,
        config: { skills: { load: { watchDebounceMs: 30 } } },
      });

      // Let chokidar finish its initial scan before making changes.
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Negative direction: a change to a non-SKILL.md file must not trigger
      // a refresh.
      await fs.writeFile(path.join(otherDir, "notes.txt"), "changed\n");
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(events).toHaveLength(0);

      // Positive direction: a change to SKILL.md in a skill subfolder must
      // trigger a refresh. This is the case that was silently broken by
      // chokidar's glob removal.
      await fs.writeFile(path.join(skillDir, "SKILL.md"), "changed\n");
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(events.length).toBeGreaterThan(0);
      expect(events.some((event) => event.changedPath?.endsWith("SKILL.md"))).toBe(true);
      expect(events.every((event) => event.reason === "watch")).toBe(true);
    } finally {
      unregister();
    }
  }, 10_000);
});
