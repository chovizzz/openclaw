import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const watchMock = vi.fn(() => ({
  on: vi.fn(),
  close: vi.fn(async () => undefined),
}));

let refreshModule: typeof import("./refresh.js");

vi.mock("chokidar", () => ({
  default: { watch: watchMock },
}));

vi.mock("./plugin-skills.js", () => ({
  resolvePluginSkillDirs: vi.fn(() => []),
}));

const posixJoin = (...parts: string[]) => path.join(...parts).replaceAll("\\", "/");

describe("ensureSkillsWatcher", () => {
  beforeAll(async () => {
    refreshModule = await import("./refresh.js");
  });

  beforeEach(() => {
    watchMock.mockClear();
  });

  afterEach(async () => {
    await refreshModule.resetSkillsRefreshForTest();
  });

  it("ignores node_modules, dist, .git, and Python venvs by default", async () => {
    refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace" });

    // One watcher per unique watch target, not one watcher per workspace.
    const calls = watchMock.mock.calls as unknown as Array<
      [string, { depth?: number; ignored?: unknown }]
    >;
    const targets = calls.map((call) => call[0]);
    const opts = calls[0]?.[1] ?? {};

    expect(targets.length).toBeGreaterThan(0);
    expect(new Set(targets).size).toBe(targets.length);
    expect(opts.ignored).toBe(refreshModule.DEFAULT_SKILLS_WATCH_IGNORED);
    expect(opts.depth).toBe(2);
    const posix = (p: string) => p.replaceAll("\\", "/");
    expect(targets).toEqual(
      expect.arrayContaining([
        posix(path.join("/tmp/workspace", "skills", "SKILL.md")),
        posix(path.join("/tmp/workspace", "skills", "*", "SKILL.md")),
        posix(path.join("/tmp/workspace", ".agents", "skills", "SKILL.md")),
        posix(path.join("/tmp/workspace", ".agents", "skills", "*", "SKILL.md")),
        posix(path.join(os.homedir(), ".agents", "skills", "SKILL.md")),
        posix(path.join(os.homedir(), ".agents", "skills", "*", "SKILL.md")),
      ]),
    );
    expect(targets.every((target) => target.includes("SKILL.md"))).toBe(true);
    const ignored = refreshModule.DEFAULT_SKILLS_WATCH_IGNORED;

    // Node/JS paths
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/node_modules/pkg/index.js"))).toBe(
      true,
    );
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/dist/index.js"))).toBe(true);
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/.git/config"))).toBe(true);

    // Python virtual environments and caches
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/scripts/.venv/bin/python"))).toBe(
      true,
    );
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/venv/lib/python3.10/site.py"))).toBe(
      true,
    );
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/__pycache__/module.pyc"))).toBe(
      true,
    );
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/.mypy_cache/3.10/foo.json"))).toBe(
      true,
    );
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/.pytest_cache/v/cache"))).toBe(true);

    // Build artifacts and caches
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/build/output.js"))).toBe(true);
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/.cache/data.json"))).toBe(true);

    // Should NOT ignore normal skill files
    expect(ignored.some((re) => re.test("/tmp/.hidden/skills/index.md"))).toBe(false);
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/my-skill/SKILL.md"))).toBe(false);
  });

  it("reuses one watcher per shared directory across agent workspaces", async () => {
    refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace-a" });
    const afterFirst = watchMock.mock.calls.length;
    const firstTargets = new Set(
      (watchMock.mock.calls as unknown as Array<[string, unknown]>).map((call) => call[0]),
    );

    refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace-b" });
    const allTargets = (watchMock.mock.calls as unknown as Array<[string, unknown]>).map(
      (call) => call[0],
    );

    // Every target is still watched exactly once, so the shared roots
    // (global skills dir, home skills dir) did not open a second watcher.
    expect(new Set(allTargets).size).toBe(allTargets.length);

    // The second workspace only added watchers for its own workspace-scoped
    // targets; the shared ones were reused.
    const addedTargets = allTargets.slice(afterFirst);
    expect(addedTargets.length).toBeGreaterThan(0);
    expect(addedTargets.every((target) => !firstTargets.has(target))).toBe(true);
    expect(addedTargets.every((target) => target.includes("workspace-b"))).toBe(true);
  });

  it("keeps a shared watcher open until the last workspace unsubscribes", async () => {
    refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace-a" });
    refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace-b" });

    const sharedRoot = posixJoin(os.homedir(), ".agents", "skills", "SKILL.md");
    const sharedIndex = (watchMock.mock.calls as unknown as Array<[string, unknown]>).findIndex(
      (call) => call[0] === sharedRoot,
    );
    expect(sharedIndex).toBeGreaterThanOrEqual(0);
    const sharedWatcher = watchMock.mock.results[sharedIndex]?.value as {
      close: ReturnType<typeof vi.fn>;
    };

    // Disabling watch for one workspace must not close a watcher the other
    // workspace still depends on.
    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/workspace-a",
      config: { skills: { load: { watch: false } } },
    });
    expect(sharedWatcher.close).not.toHaveBeenCalled();

    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/workspace-b",
      config: { skills: { load: { watch: false } } },
    });
    expect(sharedWatcher.close).toHaveBeenCalled();
  });
});
