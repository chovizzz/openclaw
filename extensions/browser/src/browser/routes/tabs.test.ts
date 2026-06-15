import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const { registerBrowserTabRoutes } = await import("./tabs.js");

type ProfileContext = ReturnType<typeof createProfileContext>;

function baseProfileContext() {
  return {
    profile: {
      name: "openclaw",
    },
    ensureBrowserAvailable: vi.fn(async () => {}),
    ensureTabAvailable: vi.fn(async () => ({
      targetId: "T1",
      title: "Tab 1",
      url: "https://example.com",
      type: "page" as const,
    })),
    isHttpReachable: vi.fn(async () => true),
    isReachable: vi.fn(async () => true),
    listTabs: vi.fn(async () => [
      {
        targetId: "T1",
        title: "Tab 1",
        url: "https://example.com",
        type: "page" as const,
      },
    ]),
    openTab: vi.fn(async () => ({
      targetId: "T1",
      title: "Tab 1",
      url: "https://example.com",
      type: "page" as const,
    })),
    focusTab: vi.fn(async () => {}),
    closeTab: vi.fn(async () => {}),
    stopRunningBrowser: vi.fn(async () => ({ stopped: false })),
    resetProfile: vi.fn(async () => ({ moved: false, from: "" })),
  };
}

function createProfileContext(overrides?: Partial<ReturnType<typeof baseProfileContext>>) {
  return {
    ...baseProfileContext(),
    ...overrides,
  };
}

function createRouteContext(
  profileCtx: ProfileContext,
  options?: { requestTimeoutMs?: number },
) {
  return {
    state: () => ({
      resolved: {
        requestTimeoutMs: options?.requestTimeoutMs ?? 45_000,
        ssrfPolicy: undefined,
      },
    }),
    forProfile: () => profileCtx,
    listProfiles: vi.fn(async () => []),
    mapTabError: vi.fn((err: unknown) => {
      if (!(err instanceof Error)) {
        return null;
      }
      const status = "status" in err && typeof err.status === "number" ? err.status : 400;
      return { status, message: err.message };
    }),
    ensureBrowserAvailable: profileCtx.ensureBrowserAvailable,
    ensureTabAvailable: profileCtx.ensureTabAvailable,
    isHttpReachable: profileCtx.isHttpReachable,
    isReachable: profileCtx.isReachable,
    listTabs: profileCtx.listTabs,
    openTab: profileCtx.openTab,
    focusTab: profileCtx.focusTab,
    closeTab: profileCtx.closeTab,
    stopRunningBrowser: profileCtx.stopRunningBrowser,
    resetProfile: profileCtx.resetProfile,
  };
}

async function callTabsRoute(params: {
  method: "get" | "post";
  path: "/tabs" | "/tabs/action";
  body?: Record<string, unknown>;
  profileCtx: ProfileContext;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}) {
  const { app, getHandlers, postHandlers } = createBrowserRouteApp();
  registerBrowserTabRoutes(
    app,
    createRouteContext(params.profileCtx, {
      requestTimeoutMs: params.requestTimeoutMs,
    }) as never,
  );
  const handler =
    params.method === "get" ? getHandlers.get(params.path) : postHandlers.get(params.path);
  expect(handler).toBeTypeOf("function");

  const response = createBrowserRouteResponse();
  await handler?.(
    {
      params: {},
      query: {},
      body: params.body ?? {},
      ...(params.signal ? { signal: params.signal } : {}),
    },
    response.res,
  );
  return response;
}

describe("browser tab routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the configured action timeout for existing-session tab reachability", async () => {
    const isReachable = vi.fn(async () => true);
    const abort = new AbortController();
    const profileCtx = createProfileContext({
      profile: {
        ...baseProfileContext().profile,
        driver: "existing-session",
      } as never,
      isReachable,
    });

    const listResponse = await callTabsRoute({
      method: "get",
      path: "/tabs",
      profileCtx,
      signal: abort.signal,
    });
    const actionResponse = await callTabsRoute({
      method: "post",
      path: "/tabs/action",
      body: { action: "list" },
      profileCtx,
      signal: abort.signal,
    });

    expect(listResponse.statusCode).toBe(200);
    expect(actionResponse.statusCode).toBe(200);
    expect(isReachable).toHaveBeenNthCalledWith(1, 45_000, { signal: abort.signal });
    expect(isReachable).toHaveBeenNthCalledWith(2, 45_000, { signal: abort.signal });
  });

  it("keeps the short reachability probe for non-Chrome-MCP tab routes", async () => {
    const isReachable = vi.fn(async () => true);
    const profileCtx = createProfileContext({ isReachable });

    const response = await callTabsRoute({
      method: "get",
      path: "/tabs",
      profileCtx,
    });

    expect(response.statusCode).toBe(200);
    expect(isReachable).toHaveBeenCalledWith(300);
  });

  it("normalizes configured existing-session tab reachability timeouts", async () => {
    const isReachable = vi.fn(async () => true);
    const profileCtx = createProfileContext({
      profile: {
        ...baseProfileContext().profile,
        driver: "existing-session",
      } as never,
      isReachable,
    });

    const zeroResponse = await callTabsRoute({
      method: "get",
      path: "/tabs",
      profileCtx,
      requestTimeoutMs: 0,
    });
    expect(zeroResponse.statusCode).toBe(200);
    expect(isReachable).toHaveBeenLastCalledWith(300);

    const hugeResponse = await callTabsRoute({
      method: "get",
      path: "/tabs",
      profileCtx,
      requestTimeoutMs: Number.MAX_SAFE_INTEGER,
    });
    expect(hugeResponse.statusCode).toBe(200);
    expect(isReachable).toHaveBeenLastCalledWith(2_147_483_647);
  });
});
