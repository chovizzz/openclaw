import { describe, expect, it, vi } from "vitest";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

vi.mock("../chrome-mcp.js", () => ({
  getChromeMcpPid: vi.fn(() => 4321),
}));

const { BrowserProfileUnavailableError } = await import("../errors.js");
const { registerBrowserBasicRoutes } = await import("./basic.js");

function createExistingSessionProfileState(params?: {
  isHttpReachable?: (timeoutMs?: number) => Promise<boolean>;
  isTransportAvailable?: (timeoutMs?: number) => Promise<boolean>;
  isReachable?: (timeoutMs?: number, options?: { ephemeral?: boolean }) => Promise<boolean>;
}) {
  return {
    resolved: {
      enabled: true,
      headless: false,
      noSandbox: false,
      executablePath: undefined,
    },
    profiles: new Map(),
    forProfile: () =>
      ({
        profile: {
          name: "chrome-live",
          driver: "existing-session",
          cdpPort: 0,
          cdpUrl: "",
          userDataDir: "/tmp/brave-profile",
          color: "#00AA00",
          attachOnly: true,
        },
        isHttpReachable: params?.isHttpReachable ?? (async () => true),
        isTransportAvailable: params?.isTransportAvailable ?? (async () => true),
        isReachable: params?.isReachable ?? (async () => true),
      }) as never,
  };
}

async function callBasicRouteWithState(params: {
  query?: Record<string, string>;
  state: ReturnType<typeof createExistingSessionProfileState>;
}) {
  const { app, getHandlers } = createBrowserRouteApp();
  registerBrowserBasicRoutes(app, {
    state: () => params.state,
    forProfile: params.state.forProfile,
  } as never);

  const handler = getHandlers.get("/");
  expect(handler).toBeTypeOf("function");

  const response = createBrowserRouteResponse();
  await handler?.({ params: {}, query: params.query ?? { profile: "chrome-live" } }, response.res);
  return response;
}

describe("basic browser routes", () => {
  it("maps existing-session status failures to JSON browser errors", async () => {
    const response = await callBasicRouteWithState({
      state: createExistingSessionProfileState({
        isHttpReachable: async () => {
          throw new BrowserProfileUnavailableError("attach failed");
        },
      }),
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ error: "attach failed" });
  });

  it("reports Chrome MCP transport without fake CDP fields", async () => {
    const response = await callBasicRouteWithState({
      state: createExistingSessionProfileState(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      profile: "chrome-live",
      driver: "existing-session",
      transport: "chrome-mcp",
      running: true,
      cdpPort: null,
      cdpUrl: null,
      userDataDir: "/tmp/brave-profile",
      pid: 4321,
    });
  });

  it("reports pageReady=false when Chrome MCP transport is up but page tools are unreachable", async () => {
    const response = await callBasicRouteWithState({
      state: createExistingSessionProfileState({
        isTransportAvailable: async () => true,
        isReachable: async () => false,
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      profile: "chrome-live",
      driver: "existing-session",
      transport: "chrome-mcp",
      running: true,
      cdpReady: true,
      pageReady: false,
    });
  });

  it("reports pageReady=false when the page-reachability probe throws", async () => {
    const response = await callBasicRouteWithState({
      state: createExistingSessionProfileState({
        isTransportAvailable: async () => true,
        isReachable: async () => {
          throw new Error('Chrome MCP "list_pages" timed out after 5000ms.');
        },
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      cdpReady: true,
      pageReady: false,
    });
  });

  it("reports pageReady=true when both transport and page tools succeed", async () => {
    const isHttpReachable = vi.fn(async () => true);
    const isTransportAvailable = vi.fn(async () => true);
    const isReachable = vi.fn(async () => true);

    const response = await callBasicRouteWithState({
      state: createExistingSessionProfileState({
        isHttpReachable,
        isTransportAvailable,
        isReachable,
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(isTransportAvailable).toHaveBeenCalledTimes(1);
    expect(isTransportAvailable).toHaveBeenCalledWith(5_000);
    expect(isReachable).toHaveBeenCalledWith(5_000, { ephemeral: true });
    expect(isHttpReachable).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({
      cdpHttp: true,
      cdpReady: true,
      pageReady: true,
      running: true,
    });
  });

  it("page-readiness probe runs in ephemeral mode so status does not seed a cached session", async () => {
    const isReachable = vi.fn<
      (timeoutMs?: number, options?: { ephemeral?: boolean }) => Promise<boolean>
    >(async () => true);

    await callBasicRouteWithState({
      state: createExistingSessionProfileState({
        isTransportAvailable: async () => true,
        isReachable,
      }),
    });

    expect(isReachable).toHaveBeenCalledTimes(1);
    expect(isReachable.mock.calls[0]?.[1]).toEqual({ ephemeral: true });
  });

  it("skips the page-reachability probe when transport is unavailable", async () => {
    const isReachable = vi.fn(async () => true);

    const response = await callBasicRouteWithState({
      state: createExistingSessionProfileState({
        isTransportAvailable: async () => false,
        isReachable,
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(isReachable).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({
      cdpReady: false,
      pageReady: false,
      running: false,
    });
  });
});
