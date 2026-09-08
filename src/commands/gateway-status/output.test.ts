import { describe, expect, it } from "vitest";
import type { GatewaySelfPresence } from "../gateway-presence.js";
import type { GatewayStatusTarget } from "./helpers.js";
import { buildGatewayStatusWarnings } from "./output.js";
import type { GatewayStatusProbedTarget } from "./probe-run.js";

function createProbe(ok: boolean): GatewayStatusProbedTarget["probe"] {
  return {
    ok,
    url: "ws://127.0.0.1:18789",
    connectLatencyMs: 20,
    error: null,
    close: null,
    health: null,
    status: null,
    presence: null,
    configSnapshot: null,
  };
}

function createReachableTarget(
  id: string,
  self: GatewaySelfPresence | null,
  targetOverrides?: Partial<GatewayStatusTarget>,
): GatewayStatusProbedTarget {
  const target: GatewayStatusTarget = {
    id,
    kind: "explicit",
    url: "ws://127.0.0.1:18789",
    active: true,
    ...targetOverrides,
  };
  return {
    target,
    probe: createProbe(true),
    configSummary: null,
    self,
    authDiagnostics: [],
  };
}

const GATEWAY_SELF: GatewaySelfPresence = {
  host: "gateway-host",
  ip: "192.0.2.10",
  version: "2026.5.22",
  platform: "linux",
  instanceId: "gateway-instance-1",
};

const GATEWAY_SELF_NO_PROCESS_ID: GatewaySelfPresence = {
  host: "gateway-host",
  ip: "192.0.2.10",
  version: "2026.5.22",
  platform: "linux",
};

const MULTIPLE_GATEWAYS_WARNING = {
  code: "multiple_gateways",
  message:
    "Unconventional setup: multiple reachable gateway identities detected. Usually one gateway per network is recommended unless you intentionally run isolated profiles, like a rescue bot (see docs: /gateway#multiple-gateways-same-host).",
};

describe("buildGatewayStatusWarnings multiple_gateways dedupe", () => {
  it.each([
    {
      name: "suppresses warning for SSH tunnel and configured remote with the same self identity",
      probed: [
        createReachableTarget("sshTunnel", GATEWAY_SELF, {
          kind: "sshTunnel",
          url: "ws://127.0.0.1:18789",
          tunnel: {
            kind: "ssh",
            target: "user@gateway-host",
            localPort: 18789,
            remotePort: 18789,
            pid: 1234,
          },
        }),
        createReachableTarget(
          "configRemote",
          {
            ...GATEWAY_SELF,
            host: GATEWAY_SELF.host?.toUpperCase(),
          },
          { kind: "configRemote", url: "ws://gateway-host:18789" },
        ),
      ],
      sshTarget: "user@gateway-host" as string | null,
      expectedTargetIds: null as string[] | null,
    },
    {
      name: "suppresses warning for the same self identity on different transport ports",
      probed: [
        createReachableTarget("localLoopback", GATEWAY_SELF, {
          kind: "localLoopback",
          url: "ws://127.0.0.1:18789",
        }),
        createReachableTarget("explicit", GATEWAY_SELF, {
          kind: "explicit",
          url: "ws://gateway-host:28789",
        }),
      ],
      sshTarget: null as string | null,
      expectedTargetIds: null as string[] | null,
    },
    {
      name: "warns when same-host probes do not report process identity",
      probed: [
        createReachableTarget("localLoopback", GATEWAY_SELF_NO_PROCESS_ID, {
          kind: "localLoopback",
          url: "ws://127.0.0.1:18789",
        }),
        createReachableTarget("explicit", GATEWAY_SELF_NO_PROCESS_ID, {
          kind: "explicit",
          url: "ws://gateway-host:28789",
        }),
      ],
      sshTarget: null as string | null,
      expectedTargetIds: ["localLoopback", "explicit"] as string[] | null,
    },
    {
      name: "warns when probes report distinct identities",
      probed: [
        createReachableTarget("sshTunnel", {
          host: "gateway-a",
          ip: "192.0.2.10",
          version: "2026.5.22",
          platform: "linux",
          instanceId: "gateway-instance-a",
        }),
        createReachableTarget("configRemote", {
          host: "gateway-b",
          ip: "192.0.2.11",
          version: "2026.5.22",
          platform: "linux",
          instanceId: "gateway-instance-b",
        }),
      ],
      sshTarget: "user@gateway-a" as string | null,
      expectedTargetIds: ["sshTunnel", "configRemote"] as string[] | null,
    },
    {
      name: "warns when probe identity is unknown",
      probed: [
        createReachableTarget("sshTunnel", null),
        createReachableTarget("configRemote", null),
      ],
      sshTarget: "user@gateway-host" as string | null,
      expectedTargetIds: ["sshTunnel", "configRemote"] as string[] | null,
    },
    {
      name: "does not warn for a single reachable target",
      probed: [createReachableTarget("localLoopback", GATEWAY_SELF)],
      sshTarget: null as string | null,
      expectedTargetIds: null as string[] | null,
    },
  ])("$name", ({ probed, sshTarget, expectedTargetIds }) => {
    const warnings = buildGatewayStatusWarnings({
      probed,
      sshTarget,
      sshTunnelStarted: sshTarget !== null,
      sshTunnelError: null,
    });
    const warning = warnings.find((entry) => entry.code === "multiple_gateways");

    if (expectedTargetIds === null) {
      expect(warning).toBeUndefined();
    } else {
      expect(warning).toStrictEqual({
        ...MULTIPLE_GATEWAYS_WARNING,
        targetIds: expectedTargetIds,
      });
    }
  });
});
