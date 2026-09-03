import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as chromeModule from "./chrome.js";
import {
  closePlaywrightBrowserConnection,
  getPageForTargetId,
  listPagesViaPlaywright,
} from "./pw-session.js";

const connectOverCdpSpy = vi.spyOn(chromium, "connectOverCDP");
const getChromeWebSocketUrlSpy = vi.spyOn(chromeModule, "getChromeWebSocketUrl");

type MockPageSpec = { targetId?: string; url?: string };

type BrowserMockBundle = {
  browser: import("playwright-core").Browser;
  browserClose: ReturnType<typeof vi.fn>;
  pages: import("playwright-core").Page[];
};

function makeBrowser(pages: MockPageSpec[]): BrowserMockBundle {
  let context: import("playwright-core").BrowserContext;
  const browserClose = vi.fn(async () => {});
  const targetIdByPage = new Map<import("playwright-core").Page, string | undefined>();

  const pageObjects = pages.map((spec, index) => {
    const page = {
      on: vi.fn(),
      context: () => context,
      title: vi.fn(async () => spec.targetId ?? `page-${index + 1}`),
      url: vi.fn(() => spec.url ?? `https://page-${index + 1}.example`),
    } as unknown as import("playwright-core").Page;
    targetIdByPage.set(page, spec.targetId);
    return page;
  });

  context = {
    pages: () => pageObjects,
    on: vi.fn(),
    newCDPSession: vi.fn(async (page: import("playwright-core").Page) => ({
      send: vi.fn(async (method: string) =>
        method === "Target.getTargetInfo"
          ? { targetInfo: { targetId: targetIdByPage.get(page) } }
          : {},
      ),
      detach: vi.fn(async () => {}),
    })),
  } as unknown as import("playwright-core").BrowserContext;

  const browser = {
    contexts: () => [context],
    on: vi.fn(),
    off: vi.fn(),
    close: browserClose,
  } as unknown as import("playwright-core").Browser;

  return { browser, browserClose, pages: pageObjects };
}

afterEach(async () => {
  connectOverCdpSpy.mockReset();
  getChromeWebSocketUrlSpy.mockReset();
  await closePlaywrightBrowserConnection().catch(() => {});
});

describe("pw-session stale cached attach retry", () => {
  it("evicts a stale cached page-less browser once and succeeds on a fresh reconnect", async () => {
    const stale = makeBrowser([]);
    const fresh = makeBrowser([{ targetId: "TARGET_OK", url: "https://fresh.example" }]);
    connectOverCdpSpy.mockResolvedValueOnce(stale.browser).mockResolvedValueOnce(fresh.browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    // Prime the cache so the next resolve reuses a (now stale) connection.
    await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" });

    const resolved = await getPageForTargetId({ cdpUrl: "http://127.0.0.1:9222" });

    expect(resolved).toBe(fresh.pages[0]);
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
    expect(stale.browserClose).toHaveBeenCalledTimes(1);
    expect(fresh.browserClose).not.toHaveBeenCalled();
  });

  it("evicts a stale cached tab-selection miss once and succeeds on a fresh reconnect", async () => {
    const stale = makeBrowser([
      { targetId: "TARGET_A", url: "https://alpha.example" },
      { targetId: "TARGET_C", url: "https://charlie.example" },
    ]);
    const fresh = makeBrowser([
      { targetId: "TARGET_A", url: "https://alpha.example" },
      { targetId: "TARGET_B", url: "https://beta.example" },
    ]);
    connectOverCdpSpy.mockResolvedValueOnce(stale.browser).mockResolvedValueOnce(fresh.browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    await getPageForTargetId({ cdpUrl: "http://127.0.0.1:9333" });

    const resolved = await getPageForTargetId({
      cdpUrl: "http://127.0.0.1:9333",
      targetId: "TARGET_B",
    });

    expect(resolved).toBe(fresh.pages[1]);
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
    expect(stale.browserClose).toHaveBeenCalledTimes(1);
  });

  it("retries at most once when the refreshed browser is still page-less", async () => {
    const stale = makeBrowser([]);
    const stillBroken = makeBrowser([]);
    connectOverCdpSpy
      .mockResolvedValueOnce(stale.browser)
      .mockResolvedValueOnce(stillBroken.browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9444" });

    await expect(getPageForTargetId({ cdpUrl: "http://127.0.0.1:9444" })).rejects.toThrow(
      "No pages available in the connected browser.",
    );
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
    expect(stale.browserClose).toHaveBeenCalledTimes(1);
  });

  it("does not retry a page-selection miss on a freshly created connection", async () => {
    const fresh = makeBrowser([]);
    connectOverCdpSpy.mockResolvedValue(fresh.browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    // No prior listPages call, so nothing is cached and the miss is real.
    await expect(getPageForTargetId({ cdpUrl: "http://127.0.0.1:9555" })).rejects.toThrow(
      "No pages available in the connected browser.",
    );
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(1);
    expect(fresh.browserClose).not.toHaveBeenCalled();
  });

  it("does not evict a replacement connection installed by a concurrent caller", async () => {
    const stale = makeBrowser([]);
    const replacement = makeBrowser([
      { targetId: "TARGET_OK", url: "https://replacement.example" },
    ]);
    connectOverCdpSpy
      .mockResolvedValueOnce(stale.browser)
      .mockResolvedValueOnce(replacement.browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9666" });

    // The first resolve reuses the stale attach, fails, sees the cache entry is
    // still the same one it started with, evicts it and reconnects.
    const resolved = await getPageForTargetId({ cdpUrl: "http://127.0.0.1:9666" });
    expect(resolved).toBe(replacement.pages[0]);

    // The replacement is now cached; a later successful resolve must not close it.
    const again = await getPageForTargetId({ cdpUrl: "http://127.0.0.1:9666" });
    expect(again).toBe(replacement.pages[0]);
    expect(replacement.browserClose).not.toHaveBeenCalled();
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
  });

  it("evicts only the stale cdpUrl and leaves other cached connections alone", async () => {
    const staleA = makeBrowser([]);
    const refreshedA = makeBrowser([{ targetId: "A", url: "https://a.example/recovered" }]);
    const browserB = makeBrowser([{ targetId: "B", url: "https://b.example" }]);
    let callsForA = 0;

    connectOverCdpSpy.mockImplementation((async (...args: unknown[]) => {
      const endpointText = String(args[0]);
      if (endpointText === "http://127.0.0.1:9222") {
        callsForA += 1;
        return callsForA === 1 ? staleA.browser : refreshedA.browser;
      }
      if (endpointText === "http://127.0.0.1:9333") {
        return browserB.browser;
      }
      throw new Error(`unexpected endpoint: ${endpointText}`);
    }) as never);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" });
    await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9333" });

    const recoveredA = await getPageForTargetId({ cdpUrl: "http://127.0.0.1:9222" });
    const stillCachedB = await getPageForTargetId({ cdpUrl: "http://127.0.0.1:9333" });

    expect(recoveredA.url()).toBe("https://a.example/recovered");
    expect(stillCachedB.url()).toBe("https://b.example");
    expect(staleA.browserClose).toHaveBeenCalledTimes(1);
    expect(refreshedA.browserClose).not.toHaveBeenCalled();
    expect(browserB.browserClose).not.toHaveBeenCalled();
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(3);
  });
});
