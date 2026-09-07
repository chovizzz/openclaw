import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  AUTH_NONE,
  createRequest,
  dispatchRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";

/**
 * Regression coverage for finishing a failed gateway HTTP response without hanging or
 * crashing. Before this fix, a route that committed headers and then threw would hit the
 * top-level error handler, which unconditionally reset `res.statusCode`/`res.setHeader`.
 * On a real `http.ServerResponse` that throws `ERR_HTTP_HEADERS_SENT`, and — because the
 * server request callback never wrapped its async handler in `.catch()` — that second
 * throw became an unhandled promise rejection instead of a finished response.
 */
function createHeadersCommittedResponse(): {
  res: ServerResponse;
  end: ReturnType<typeof vi.fn>;
  socketEnd: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
} {
  const end = vi.fn();
  const socketEnd = vi.fn();
  const setHeader = vi.fn((..._args: unknown[]) => {
    if (res.headersSent) {
      // Mirrors Node's real http.ServerResponse: setHeader after headers are sent throws.
      throw new Error(
        "ERR_HTTP_HEADERS_SENT: Cannot set headers after they are sent to the client",
      );
    }
  });
  const res = {
    statusCode: 200,
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    setHeader,
    end,
    // Real http.ServerResponse instances always have `destroy` (inherited from
    // stream.Writable); the request-callback's safety-net `.catch()` calls it.
    destroy: vi.fn(),
    socket: { end: socketEnd },
  } as unknown as ServerResponse;
  return { res, end, socketEnd, setHeader };
}

describe("gateway HTTP request error cleanup", () => {
  it("finishes (does not hang or crash) when a route commits headers and then throws", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { res, end, socketEnd } = createHeadersCommittedResponse();

    await withGatewayServer({
      prefix: "request-error-headers-committed",
      resolvedAuth: AUTH_NONE,
      overrides: {
        handleHooksRequest: async (_req, hookRes) => {
          // Simulate a route that already started streaming a response before failing.
          (hookRes as unknown as { headersSent: boolean }).headersSent = true;
          throw new Error("route failed after committing headers");
        },
      },
      run: async (server) => {
        const req = createRequest({ path: "/hooks/boom" });

        // Must resolve (not hang) and must not throw (no unhandled rejection/crash).
        await expect(dispatchRequest(server, req, res)).resolves.toBeUndefined();

        // The response must still be finished — flushed and its socket torn down —
        // rather than left dangling forever.
        expect(end).toHaveBeenCalledWith();
        expect(socketEnd).toHaveBeenCalledOnce();
      },
    });

    errorLog.mockRestore();
  });
});
