import { beforeEach, describe, expect, it, vi } from "vitest";

const gatewayClientState = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  requests: [] as string[],
  startMode: "hello" as "hello" | "close",
  close: { code: 1008, reason: "pairing required" },
  stopCalls: 0,
  stopAndWaitCalls: [] as Array<{ timeoutMs?: number } | undefined>,
  stopAndWaitMode: "resolve" as "resolve" | "reject" | "defer",
  resolveStopAndWait: null as (() => void) | null,
}));

const deviceIdentityState = vi.hoisted(() => ({
  value: { id: "test-device-identity" } as Record<string, unknown>,
  throwOnLoad: false,
}));

class MockGatewayClient {
  private readonly opts: Record<string, unknown>;

  constructor(opts: Record<string, unknown>) {
    this.opts = opts;
    gatewayClientState.options = opts;
    gatewayClientState.requests = [];
  }

  start(): void {
    void Promise.resolve()
      .then(async () => {
        if (gatewayClientState.startMode === "close") {
          const onClose = this.opts.onClose;
          if (typeof onClose === "function") {
            onClose(gatewayClientState.close.code, gatewayClientState.close.reason);
          }
          return;
        }
        const onHelloOk = this.opts.onHelloOk;
        if (typeof onHelloOk === "function") {
          await onHelloOk();
        }
      })
      .catch(() => {});
  }

  stop(): void {
    gatewayClientState.stopCalls += 1;
  }

  async stopAndWait(opts?: { timeoutMs?: number }): Promise<void> {
    gatewayClientState.stopAndWaitCalls.push(opts);
    if (gatewayClientState.stopAndWaitMode === "reject") {
      throw new Error("close drain failed");
    }
    if (gatewayClientState.stopAndWaitMode === "defer") {
      await new Promise<void>((resolve) => {
        gatewayClientState.resolveStopAndWait = resolve;
      });
    }
  }

  async request(method: string): Promise<unknown> {
    gatewayClientState.requests.push(method);
    if (method === "system-presence") {
      return [];
    }
    return {};
  }
}

vi.mock("./client.js", () => ({
  GatewayClient: MockGatewayClient,
}));

vi.mock("../infra/device-identity.js", () => ({
  loadOrCreateDeviceIdentity: () => {
    if (deviceIdentityState.throwOnLoad) {
      throw new Error("read-only identity dir");
    }
    return deviceIdentityState.value;
  },
}));

const { clampProbeTimeoutMs, probeGateway } = await import("./probe.js");

describe("probeGateway", () => {
  beforeEach(() => {
    deviceIdentityState.throwOnLoad = false;
    gatewayClientState.startMode = "hello";
    gatewayClientState.close = { code: 1008, reason: "pairing required" };
    gatewayClientState.stopCalls = 0;
    gatewayClientState.stopAndWaitCalls = [];
    gatewayClientState.stopAndWaitMode = "resolve";
    gatewayClientState.resolveStopAndWait = null;
  });

  it("clamps probe timeout to timer-safe bounds", () => {
    expect(clampProbeTimeoutMs(1)).toBe(250);
    expect(clampProbeTimeoutMs(2_000)).toBe(2_000);
    expect(clampProbeTimeoutMs(3_000_000_000)).toBe(2_147_483_647);
  });
  it("connects with operator.read scope", async () => {
    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 1_000,
    });

    expect(gatewayClientState.options?.scopes).toEqual(["operator.read"]);
    expect(gatewayClientState.options?.deviceIdentity).toEqual(deviceIdentityState.value);
    expect(gatewayClientState.requests).toEqual([
      "health",
      "status",
      "system-presence",
      "config.get",
    ]);
    expect(result.ok).toBe(true);
  });

  it("keeps device identity enabled for remote probes", async () => {
    await probeGateway({
      url: "wss://gateway.example/ws",
      auth: { token: "secret" },
      timeoutMs: 1_000,
    });

    expect(gatewayClientState.options?.deviceIdentity).toEqual(deviceIdentityState.value);
  });

  it("keeps device identity disabled for unauthenticated loopback probes", async () => {
    await probeGateway({
      url: "ws://127.0.0.1:18789",
      timeoutMs: 1_000,
    });

    expect(gatewayClientState.options?.deviceIdentity).toBeNull();
  });

  it("skips detail RPCs for lightweight reachability probes", async () => {
    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      timeoutMs: 1_000,
      includeDetails: false,
    });

    expect(result.ok).toBe(true);
    expect(gatewayClientState.options?.deviceIdentity).toBeNull();
    expect(gatewayClientState.requests).toEqual([]);
  });

  it("keeps device identity enabled for authenticated lightweight probes", async () => {
    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 1_000,
      includeDetails: false,
    });

    expect(result.ok).toBe(true);
    expect(gatewayClientState.options?.deviceIdentity).toEqual(deviceIdentityState.value);
    expect(gatewayClientState.requests).toEqual([]);
  });

  it("falls back to token/password auth when device identity cannot be persisted", async () => {
    deviceIdentityState.throwOnLoad = true;

    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 1_000,
    });

    expect(result.ok).toBe(true);
    expect(gatewayClientState.options?.deviceIdentity).toBeNull();
    expect(gatewayClientState.requests).toEqual([
      "health",
      "status",
      "system-presence",
      "config.get",
    ]);
  });

  it("fetches only presence for presence-only probes", async () => {
    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      timeoutMs: 1_000,
      detailLevel: "presence",
    });

    expect(result.ok).toBe(true);
    expect(gatewayClientState.requests).toEqual(["system-presence"]);
    expect(result.health).toBeNull();
    expect(result.status).toBeNull();
    expect(result.configSnapshot).toBeNull();
  });

  it("passes through tls fingerprints for secure daemon probes", async () => {
    await probeGateway({
      url: "wss://gateway.example/ws",
      auth: { token: "secret" },
      tlsFingerprint: "sha256:abc",
      timeoutMs: 1_000,
      includeDetails: false,
    });

    expect(gatewayClientState.options?.tlsFingerprint).toBe("sha256:abc");
  });

  it("surfaces immediate close failures before the probe timeout", async () => {
    gatewayClientState.startMode = "close";

    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 5_000,
      includeDetails: false,
    });

    expect(result).toMatchObject({
      ok: false,
      error: "gateway closed (1008): pairing required",
      close: { code: 1008, reason: "pairing required" },
    });
    expect(gatewayClientState.requests).toEqual([]);
  });

  it("waits for gateway client close drain before resolving", async () => {
    gatewayClientState.stopAndWaitMode = "defer";

    const probePromise = probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 1_000,
      includeDetails: false,
    });
    let resolved = false;
    void probePromise.then(() => {
      resolved = true;
    });

    await vi.waitFor(() => {
      expect(gatewayClientState.stopAndWaitCalls).toHaveLength(1);
    });
    expect(gatewayClientState.stopAndWaitCalls[0]).toEqual({ timeoutMs: 1_000 });
    await Promise.resolve();
    expect(resolved).toBe(false);

    gatewayClientState.resolveStopAndWait?.();
    const result = await probePromise;

    expect(result.ok).toBe(true);
    expect(resolved).toBe(true);
    expect(gatewayClientState.stopCalls).toBe(0);
  });

  it("falls back to stop when close drain fails", async () => {
    gatewayClientState.stopAndWaitMode = "reject";

    const result = await probeGateway({
      url: "ws://127.0.0.1:18789",
      auth: { token: "secret" },
      timeoutMs: 1_000,
      includeDetails: false,
    });

    expect(result.ok).toBe(true);
    expect(gatewayClientState.stopAndWaitCalls).toHaveLength(1);
    expect(gatewayClientState.stopCalls).toBe(1);
  });
});
