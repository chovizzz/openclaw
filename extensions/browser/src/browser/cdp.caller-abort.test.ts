import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fetchJson } from "./cdp.helpers.js";
import { createTargetViaCdp } from "./cdp.js";

describe("CDP caller-abort seam", () => {
  let httpServer: ReturnType<typeof createServer> | null = null;

  afterEach(async () => {
    const server = httpServer;
    httpServer = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  const startHangingServer = async () => {
    // Accept the request and never respond, so only an abort can end the wait.
    httpServer = createServer(() => {});
    await new Promise<void>((resolve) => {
      httpServer?.listen(0, "127.0.0.1", resolve);
    });
    return (httpServer.address() as AddressInfo).port;
  };

  it("cancels a pending fetchJson with the caller's abort reason", async () => {
    const port = await startHangingServer();
    const controller = new AbortController();
    const reason = new Error("caller went away");
    const pending = fetchJson(`http://127.0.0.1:${port}/json/version`, 60_000, {
      signal: controller.signal,
    });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it("still honors the request timeout when no caller signal is supplied", async () => {
    const port = await startHangingServer();
    // Byte-for-byte the pre-seam path: the timeout controller is the only signal.
    await expect(fetchJson(`http://127.0.0.1:${port}/json/version`, 25)).rejects.toThrow();
  });

  it("does not contact the endpoint when the caller is already aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("already canceled");
    controller.abort(reason);
    await expect(
      createTargetViaCdp({
        // An unroutable port: reaching the network at all would hang or error
        // differently than the pre-flight abort we expect here.
        cdpUrl: "http://127.0.0.1:1",
        url: "https://example.com",
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });
});
