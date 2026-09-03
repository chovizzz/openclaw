import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createRemoteEmbeddingProvider } from "./embeddings-remote-provider.js";
import { buildRemoteBaseUrlPolicy } from "./remote-http.js";

// This suite deliberately avoids mocking `fetchWithSsrFGuard`: the point is to
// prove the caller signal survives the whole provider -> fetchRemoteEmbeddingVectors
// -> postJson -> withRemoteHttpResponse -> fetchWithSsrFGuard -> fetch chain and
// actually tears the socket down. `buildRemoteBaseUrlPolicy` puts the loopback
// host on `allowedHostnames`, which is what lets the real SSRF guard through.
describe("remote embedding provider caller-abort seam", () => {
  let httpServer: ReturnType<typeof createServer> | null = null;

  afterEach(async () => {
    const server = httpServer;
    httpServer = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  const startServer = async (handler: RequestListener) => {
    httpServer = createServer(handler);
    await new Promise<void>((resolve) => {
      httpServer?.listen(0, "127.0.0.1", resolve);
    });
    return (httpServer.address() as AddressInfo).port;
  };

  // Accept the request and never respond, so only an abort can end the wait.
  // `firstRequest` resolves once a request has actually reached the server, and
  // `requests` proves whether the endpoint was contacted at all.
  const startHangingServer = async () => {
    const requests: string[] = [];
    let signalReceived: (() => void) | undefined;
    const firstRequest = new Promise<void>((resolve) => {
      signalReceived = resolve;
    });
    const port = await startServer((req) => {
      requests.push(req.url ?? "");
      signalReceived?.();
    });
    return { port, requests, firstRequest };
  };

  const buildProvider = (port: number) => {
    const baseUrl = `http://127.0.0.1:${port}`;
    return createRemoteEmbeddingProvider({
      id: "openai",
      errorPrefix: "openai embeddings failed",
      client: {
        baseUrl,
        headers: { "Content-Type": "application/json" },
        ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl),
        model: "text-embedding-test",
      },
    });
  };

  it("rejects an in-flight embedQuery with the caller's abort reason", async () => {
    const { port, requests, firstRequest } = await startHangingServer();
    const provider = buildProvider(port);
    const controller = new AbortController();
    const reason = new Error("memory_search deadline elapsed");

    const pending = provider.embedQuery("hello", { signal: controller.signal });
    const settled = expect(pending).rejects.toBe(reason);
    // Abort only once the request is genuinely on the wire, so this proves a real
    // in-flight cancellation rather than a pre-flight bail-out.
    await firstRequest;
    expect(requests).toHaveLength(1);
    controller.abort(reason);
    await settled;
  });

  it("does not contact the endpoint when the caller is already aborted", async () => {
    const { port, requests } = await startHangingServer();
    const provider = buildProvider(port);
    const controller = new AbortController();
    const reason = new Error("already canceled");
    controller.abort(reason);

    await expect(provider.embedQuery("hello", { signal: controller.signal })).rejects.toBe(reason);
    expect(requests).toHaveLength(0);
  });

  it("is unchanged when no signal is supplied", async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ embedding: [0.25, 0.5, 0.75] }] }));
    });
    const provider = buildProvider(port);

    await expect(provider.embedQuery("hello")).resolves.toEqual([0.25, 0.5, 0.75]);
    await expect(provider.embedBatch(["hello"])).resolves.toEqual([[0.25, 0.5, 0.75]]);
  });
});
