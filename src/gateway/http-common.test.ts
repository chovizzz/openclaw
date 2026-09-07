import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { finishFailedGatewayHttpResponse, setDefaultSecurityHeaders } from "./http-common.js";
import { makeMockHttpResponse } from "./test-http-response.js";

function makeFinishFailedResponseMock(
  overrides: Partial<{
    destroyed: boolean;
    writableEnded: boolean;
    headersSent: boolean;
    socket: { end: ReturnType<typeof vi.fn> } | undefined;
  }> = {},
) {
  const setHeader = vi.fn();
  const end = vi.fn();
  const socketEnd = overrides.socket === undefined ? vi.fn() : overrides.socket.end;
  const res = {
    destroyed: overrides.destroyed ?? false,
    writableEnded: overrides.writableEnded ?? false,
    headersSent: overrides.headersSent ?? false,
    statusCode: 200,
    setHeader,
    end,
    socket: "socket" in overrides ? overrides.socket : { end: socketEnd },
  } as unknown as ServerResponse;
  return { res, setHeader, end, socketEnd };
}

describe("setDefaultSecurityHeaders", () => {
  it("sets X-Content-Type-Options", () => {
    const { res, setHeader } = makeMockHttpResponse();
    setDefaultSecurityHeaders(res);
    expect(setHeader).toHaveBeenCalledWith("X-Content-Type-Options", "nosniff");
  });

  it("sets Referrer-Policy", () => {
    const { res, setHeader } = makeMockHttpResponse();
    setDefaultSecurityHeaders(res);
    expect(setHeader).toHaveBeenCalledWith("Referrer-Policy", "no-referrer");
  });

  it("sets Permissions-Policy", () => {
    const { res, setHeader } = makeMockHttpResponse();
    setDefaultSecurityHeaders(res);
    expect(setHeader).toHaveBeenCalledWith(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
  });

  it("sets Strict-Transport-Security when provided", () => {
    const { res, setHeader } = makeMockHttpResponse();
    setDefaultSecurityHeaders(res, {
      strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
    });
    expect(setHeader).toHaveBeenCalledWith(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains; preload",
    );
  });

  it("does not set Strict-Transport-Security when not provided", () => {
    const { res, setHeader } = makeMockHttpResponse();
    setDefaultSecurityHeaders(res);
    expect(setHeader).not.toHaveBeenCalledWith("Strict-Transport-Security", expect.anything());
  });

  it("does not set Strict-Transport-Security for empty string", () => {
    const { res, setHeader } = makeMockHttpResponse();
    setDefaultSecurityHeaders(res, { strictTransportSecurity: "" });
    expect(setHeader).not.toHaveBeenCalledWith("Strict-Transport-Security", expect.anything());
  });
});

describe("finishFailedGatewayHttpResponse", () => {
  it("sends a generic 500 when headers were never sent", () => {
    const { res, setHeader, end } = makeFinishFailedResponseMock();
    finishFailedGatewayHttpResponse(res);
    expect(res.statusCode).toBe(500);
    expect(setHeader).toHaveBeenCalledWith("Content-Type", "text/plain; charset=utf-8");
    expect(end).toHaveBeenCalledWith("Internal Server Error");
  });

  it("never leaks the underlying error message into the response body", () => {
    const { res, end } = makeFinishFailedResponseMock();
    finishFailedGatewayHttpResponse(res);
    for (const call of end.mock.calls) {
      for (const arg of call) {
        if (typeof arg === "string") {
          expect(arg).not.toContain("secret");
        }
      }
    }
  });

  it("flushes and tears down the socket when headers were already sent", () => {
    const { res, end, socketEnd } = makeFinishFailedResponseMock({ headersSent: true });
    finishFailedGatewayHttpResponse(res);
    expect(end).toHaveBeenCalledWith();
    expect(socketEnd).toHaveBeenCalledOnce();
  });

  it("is a no-op once the response is already destroyed", () => {
    const { res, end, setHeader } = makeFinishFailedResponseMock({ destroyed: true });
    finishFailedGatewayHttpResponse(res);
    expect(end).not.toHaveBeenCalled();
    expect(setHeader).not.toHaveBeenCalled();
  });

  it("is a no-op once the response has already ended", () => {
    const { res, end, setHeader } = makeFinishFailedResponseMock({ writableEnded: true });
    finishFailedGatewayHttpResponse(res);
    expect(end).not.toHaveBeenCalled();
    expect(setHeader).not.toHaveBeenCalled();
  });

  it("does not throw when headers were sent and the socket is already gone", () => {
    const { res, end } = makeFinishFailedResponseMock({
      headersSent: true,
      socket: undefined,
    });
    expect(() => finishFailedGatewayHttpResponse(res)).not.toThrow();
    expect(end).toHaveBeenCalledWith();
  });
});
