import * as Lark from "@larksuiteoapi/node-sdk";
import { describe, expect, it } from "vitest";
import { FEISHU_WS_CONFIG } from "./client.js";

/**
 * These tests run against the *real* SDK (no module mocks) because the point is
 * to prove the installed SDK actually consumes our `wsConfig` keys.
 *
 * Historically this was silently broken: SDK 1.60's `WSClient` constructor never
 * destructured `wsConfig` at all, so the heartbeat settings we passed were
 * dropped on the floor. 1.73 added `wsConfig?: WSConfigOverrides`, but spells the
 * key `pingTimeout` rather than the `PingTimeout` we used to send. Both failure
 * modes are invisible to a mock-based test, hence this file.
 */
describe("FEISHU_WS_CONFIG against the installed SDK", () => {
  it("only uses keys the SDK's WSConfigOverrides actually exposes", () => {
    // Ping cadence / reconnect interval / reconnect count are server-authoritative
    // and deliberately not exposed as client overrides, so `pingTimeout` is the
    // only supported key. Guard against silently reintroducing ignored keys.
    expect(Object.keys(FEISHU_WS_CONFIG)).toEqual(["pingTimeout"]);
  });

  it("is received by the real WSClient constructor and stored as the liveness window", () => {
    const wsClient = new Lark.WSClient({
      appId: "cli_test_app_id",
      appSecret: "test-app-secret",
      wsConfig: FEISHU_WS_CONFIG,
    });

    // `pingTimeoutSec` is private in the type surface but is the runtime field the
    // SDK reads `wsConfig.pingTimeout` into. Reading it is the only direct proof
    // that our config crossed the constructor boundary rather than being ignored.
    const pingTimeoutSec = (wsClient as unknown as { pingTimeoutSec: number }).pingTimeoutSec;

    expect(pingTimeoutSec).toBe(FEISHU_WS_CONFIG.pingTimeout);
    expect(pingTimeoutSec).toBeGreaterThan(0);
  });

  it("leaves the liveness watchdog disabled when no wsConfig is supplied", () => {
    // Proves the assertion above is meaningful: absent config yields 0 (disabled),
    // so a passing test cannot be an artifact of some unrelated default.
    const wsClient = new Lark.WSClient({
      appId: "cli_test_app_id",
      appSecret: "test-app-secret",
    });

    expect((wsClient as unknown as { pingTimeoutSec: number }).pingTimeoutSec).toBe(0);
  });
});
