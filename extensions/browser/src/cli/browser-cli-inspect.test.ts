import { Command } from "commander";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "../../test-support.js";
import * as browserCliSharedModule from "./browser-cli-shared.js";
import * as cliCoreApiModule from "./core-api.js";

const { defaultRuntime: runtime, runtimeErrors, resetRuntimeCapture } = createCliRuntimeCapture();

const gatewayMocks = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn(async () => ({
    ok: true,
    format: "ai",
    targetId: "t1",
    url: "https://example.com",
    snapshot: "ok",
  })),
}));

vi.mock("../../../../src/cli/gateway-rpc.js", () => ({
  callGatewayFromCli: gatewayMocks.callGatewayFromCli,
}));

const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ browser: {} })),
}));
vi.mock("../config/config.js", () => configMocks);

const sharedMocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn(
    async (_opts: unknown, params: { path?: string; query?: Record<string, unknown> }) => {
      const format = params.query?.format === "aria" ? "aria" : "ai";
      if (format === "aria") {
        return {
          ok: true,
          format: "aria",
          targetId: "t1",
          url: "https://example.com",
          nodes: [],
        };
      }
      return {
        ok: true,
        format: "ai",
        targetId: "t1",
        url: "https://example.com",
        snapshot: "ok",
      };
    },
  ),
}));
vi.spyOn(browserCliSharedModule, "callBrowserRequest").mockImplementation(
  sharedMocks.callBrowserRequest,
);
vi.spyOn(cliCoreApiModule, "loadConfig").mockImplementation(configMocks.loadConfig);
vi.spyOn(cliCoreApiModule.defaultRuntime, "log").mockImplementation(runtime.log);
vi.spyOn(cliCoreApiModule.defaultRuntime, "writeJson").mockImplementation(runtime.writeJson);
vi.spyOn(cliCoreApiModule.defaultRuntime, "error").mockImplementation(runtime.error);
vi.spyOn(cliCoreApiModule.defaultRuntime, "exit").mockImplementation(runtime.exit);

let registerBrowserInspectCommands: typeof import("./browser-cli-inspect.js").registerBrowserInspectCommands;

type SnapshotDefaultsCase = {
  label: string;
  args: string[];
  expectMode: "efficient" | undefined;
};

describe("browser cli snapshot defaults", () => {
  const runBrowserInspect = async (args: string[], withJson = false) => {
    const program = new Command().enablePositionalOptions();
    // Mirror the real CLI: the parent carries a *default* --timeout, which must
    // not be treated as an explicit request.
    const browser = program
      .command("browser")
      .option("--json", "JSON output", false)
      .option("--timeout <ms>", "Timeout in ms", "30000");
    registerBrowserInspectCommands(browser, () => ({}));
    await program.parseAsync(withJson ? ["browser", "--json", ...args] : ["browser", ...args], {
      from: "user",
    });

    const [, params] = sharedMocks.callBrowserRequest.mock.calls.at(-1) ?? [];
    return params as { path?: string; query?: Record<string, unknown> } | undefined;
  };

  const lastInspectCall = () =>
    (sharedMocks.callBrowserRequest.mock.calls.at(-1) ?? []) as unknown as [
      { timeout?: string } | undefined,
      { query?: Record<string, unknown>; body?: Record<string, unknown> } | undefined,
      { timeoutMs?: number } | undefined,
    ];

  const runSnapshot = async (args: string[]) => await runBrowserInspect(["snapshot", ...args]);

  beforeAll(async () => {
    ({ registerBrowserInspectCommands } = await import("./browser-cli-inspect.js"));
  });

  afterEach(() => {
    vi.clearAllMocks();
    resetRuntimeCapture();
    configMocks.loadConfig.mockReturnValue({ browser: {} });
  });

  it.each<SnapshotDefaultsCase>([
    {
      label: "uses config snapshot defaults when mode is not provided",
      args: [],
      expectMode: "efficient",
    },
    {
      label: "does not apply config snapshot defaults to aria snapshots",
      args: ["--format", "aria"],
      expectMode: undefined,
    },
  ])("$label", async ({ args, expectMode }) => {
    configMocks.loadConfig.mockReturnValue({
      browser: { snapshotDefaults: { mode: "efficient" } },
    });

    if (args.includes("--format")) {
      gatewayMocks.callGatewayFromCli.mockResolvedValueOnce({
        ok: true,
        format: "aria",
        targetId: "t1",
        url: "https://example.com",
        snapshot: "ok",
      });
    }

    const params = await runSnapshot(args);
    expect(params?.path).toBe("/snapshot");
    if (expectMode === undefined) {
      expect((params?.query as { mode?: unknown } | undefined)?.mode).toBeUndefined();
    } else {
      expect(params?.query).toMatchObject({
        format: "ai",
        mode: expectMode,
      });
    }
  });

  it("does not set mode when config defaults are absent", async () => {
    configMocks.loadConfig.mockReturnValue({ browser: {} });
    const params = await runSnapshot([]);
    expect((params?.query as { mode?: unknown } | undefined)?.mode).toBeUndefined();
  });

  it("applies explicit efficient mode without config defaults", async () => {
    configMocks.loadConfig.mockReturnValue({ browser: {} });
    const params = await runSnapshot(["--efficient"]);
    expect(params?.query).toMatchObject({
      format: "ai",
      mode: "efficient",
    });
  });

  it.each([
    {
      name: "screenshot without an explicit timeout",
      args: ["screenshot"],
      owner: "body" as const,
      ownerTimeoutMs: undefined,
      gatewayTimeoutMs: 20_000,
    },
    {
      name: "screenshot with a parent timeout",
      args: ["--timeout", "60000", "screenshot"],
      owner: "body" as const,
      ownerTimeoutMs: 60_000,
      gatewayTimeoutMs: 60_000,
    },
    {
      name: "screenshot with a subcommand timeout",
      args: ["screenshot", "tab-42", "--timeout", "60000"],
      owner: "body" as const,
      ownerTimeoutMs: 60_000,
      gatewayTimeoutMs: 60_000,
      targetId: "tab-42",
    },
    {
      name: "screenshot where the subcommand timeout wins",
      args: ["--timeout", "60000", "screenshot", "--timeout", "90000"],
      owner: "body" as const,
      ownerTimeoutMs: 90_000,
      gatewayTimeoutMs: 90_000,
    },
    {
      name: "snapshot without an explicit timeout",
      args: ["snapshot"],
      owner: "query" as const,
      ownerTimeoutMs: undefined,
      gatewayTimeoutMs: 20_000,
    },
    {
      name: "snapshot with a parent timeout",
      args: ["--timeout", "60000", "snapshot"],
      owner: "query" as const,
      ownerTimeoutMs: 60_000,
      gatewayTimeoutMs: 60_000,
    },
    {
      name: "snapshot with a subcommand timeout",
      args: ["snapshot", "--timeout", "60000"],
      owner: "query" as const,
      ownerTimeoutMs: 60_000,
      gatewayTimeoutMs: 60_000,
    },
    {
      name: "snapshot where the subcommand timeout wins",
      args: ["--timeout", "60000", "snapshot", "--timeout", "90000"],
      owner: "query" as const,
      ownerTimeoutMs: 90_000,
      gatewayTimeoutMs: 90_000,
    },
  ])("honors $name", async ({ args, owner, ownerTimeoutMs, gatewayTimeoutMs, targetId }) => {
    await runBrowserInspect(args, true);

    const [, request, extra] = lastInspectCall();
    expect(extra?.timeoutMs).toBe(gatewayTimeoutMs);
    const ownerPayload = owner === "query" ? request?.query : request?.body;
    if (ownerTimeoutMs === undefined) {
      expect(ownerPayload).not.toHaveProperty("timeoutMs");
    } else {
      expect(ownerPayload?.timeoutMs).toBe(ownerTimeoutMs);
    }
    if (targetId !== undefined) {
      expect(request?.body?.targetId).toBe(targetId);
    }
  });

  it.each([
    { name: "zero", timeout: "0" },
    { name: "negative", timeout: "-1" },
    { name: "non-numeric", timeout: "abc" },
    { name: "trailing unit", timeout: "12ms" },
    { name: "fractional", timeout: "1.5" },
    { name: "exponent notation", timeout: "1e3" },
  ])("rejects a $name --timeout without issuing a request", async ({ timeout }) => {
    // The CLI runtime's exit() throws, so the rejection is the exit path.
    await expect(runBrowserInspect(["snapshot", "--timeout", timeout], true)).rejects.toThrow(
      "__exit__:1",
    );

    expect(sharedMocks.callBrowserRequest).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("--timeout expects a positive integer");
  });

  it("sends screenshot request with trimmed target id and jpeg type", async () => {
    const params = await runBrowserInspect(["screenshot", " tab-1 ", "--type", "jpeg"], true);
    expect(params?.path).toBe("/screenshot");
    expect((params as { body?: Record<string, unknown> } | undefined)?.body).toMatchObject({
      targetId: "tab-1",
      type: "jpeg",
      fullPage: false,
    });
  });
});
