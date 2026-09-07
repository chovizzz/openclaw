import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createPreauthConnectionBudget } from "./preauth-connection-budget.js";
import { attachGatewayWsConnectionHandler } from "./ws-connection.js";
import type { GatewayWsClient } from "./ws-types.js";

const AUTH_NONE = {
  mode: "none" as const,
  token: undefined,
  password: undefined,
  allowTailscale: false,
};

/**
 * Minimal fake WebSocket: real `ws` sockets expose `send`/`close`/`terminate`
 * plus EventEmitter semantics (`once`, `emit`). We only need enough surface
 * for attachGatewayWsConnectionHandler's connection setup to run.
 */
function createFakeSocket() {
  const emitter = new EventEmitter();
  const socket = Object.assign(emitter, {
    readyState: 1, // OPEN
    send: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn(),
    _socket: { remoteAddress: "127.0.0.1" },
  });
  return socket;
}

function createFakeUpgradeReq(): IncomingMessage {
  return {
    headers: {
      host: "127.0.0.1:18789",
      origin: undefined,
      "user-agent": "vitest",
    },
    socket: { localAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
}

function startConnection(overrides?: { socket?: ReturnType<typeof createFakeSocket> }) {
  const wss = new EventEmitter();
  const clients = new Set<GatewayWsClient>();
  const socket = overrides?.socket ?? createFakeSocket();
  const upgradeReq = createFakeUpgradeReq();

  attachGatewayWsConnectionHandler({
    wss: wss as never,
    clients,
    preauthConnectionBudget: createPreauthConnectionBudget(1_000),
    port: 18789,
    gatewayHost: "127.0.0.1",
    canvasHostEnabled: false,
    resolvedAuth: AUTH_NONE,
    gatewayMethods: [],
    events: [],
    logGateway: createSubsystemLogger("test/gateway"),
    logHealth: createSubsystemLogger("test/health"),
    logWsControl: createSubsystemLogger("test/ws-control"),
    extraHandlers: {},
    broadcast: vi.fn(),
    buildRequestContext: () =>
      ({
        unsubscribeAllSessionEvents: vi.fn(),
        nodeRegistry: { unregister: vi.fn() },
        nodeUnsubscribeAll: vi.fn(),
      }) as never,
  });

  wss.emit("connection", socket, upgradeReq);
  return { socket, clients };
}

describe("attachGatewayWsConnectionHandler send() failure handling", () => {
  it("retires the transport (terminate + close) instead of leaving a dead client behind", () => {
    const socket = createFakeSocket();
    // Every send() call — including the initial connect.challenge — fails,
    // simulating a socket that is already broken/closing.
    socket.send.mockImplementation(() => {
      throw new Error("socket is not open");
    });

    startConnection({ socket });

    // The very first send() call happens synchronously inside the
    // "connection" handler (the connect.challenge event) and must not throw
    // a TDZ ReferenceError from referencing `close` before it is initialized.
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("does not touch the socket when send() succeeds", () => {
    const { socket } = startConnection();

    expect(socket.send).toHaveBeenCalledOnce();
    expect(socket.terminate).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("only retires the transport once even if send() keeps failing on later frames", () => {
    const socket = createFakeSocket();
    socket.send.mockImplementation(() => {
      throw new Error("socket is not open");
    });

    startConnection({ socket });
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();

    // A later send() attempt on the same (already-closed) socket must be a
    // no-op, not a second terminate()/close() pair.
    socket.emit("close", 1000, Buffer.from(""));
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
  });
});
