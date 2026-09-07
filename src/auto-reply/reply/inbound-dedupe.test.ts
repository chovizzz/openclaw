import { afterEach, describe, expect, it } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.js";
import type { MsgContext } from "../templating.js";
import {
  claimInboundDedupe,
  commitInboundDedupe,
  releaseInboundDedupe,
  resetInboundDedupe,
} from "./inbound-dedupe.js";

const sharedInboundContext: MsgContext = {
  Provider: "discord",
  Surface: "discord",
  From: "discord:user-1",
  To: "channel:c1",
  OriginatingChannel: "discord",
  OriginatingTo: "channel:c1",
  SessionKey: "agent:main:discord:channel:c1",
  MessageSid: "msg-1",
};

describe("inbound dedupe", () => {
  afterEach(() => {
    resetInboundDedupe();
  });

  it("shares dedupe state across distinct module instances", async () => {
    const inboundA = await importFreshModule<typeof import("./inbound-dedupe.js")>(
      import.meta.url,
      "./inbound-dedupe.js?scope=shared-a",
    );
    const inboundB = await importFreshModule<typeof import("./inbound-dedupe.js")>(
      import.meta.url,
      "./inbound-dedupe.js?scope=shared-b",
    );

    inboundA.resetInboundDedupe();
    inboundB.resetInboundDedupe();

    try {
      expect(inboundA.shouldSkipDuplicateInbound(sharedInboundContext)).toBe(false);
      expect(inboundB.shouldSkipDuplicateInbound(sharedInboundContext)).toBe(true);
    } finally {
      inboundA.resetInboundDedupe();
      inboundB.resetInboundDedupe();
    }
  });

  it("shares claim/release state across distinct module instances", async () => {
    const inboundA = await importFreshModule<typeof import("./inbound-dedupe.js")>(
      import.meta.url,
      "./inbound-dedupe.js?scope=claim-a",
    );
    const inboundB = await importFreshModule<typeof import("./inbound-dedupe.js")>(
      import.meta.url,
      "./inbound-dedupe.js?scope=claim-b",
    );

    inboundA.resetInboundDedupe();
    inboundB.resetInboundDedupe();

    try {
      const firstClaim = inboundA.claimInboundDedupe(sharedInboundContext);
      expect(firstClaim).toMatchObject({ status: "claimed" });
      expect(inboundB.claimInboundDedupe(sharedInboundContext)).toMatchObject({
        status: "inflight",
      });
      if (firstClaim.status !== "claimed") {
        throw new Error("expected claimed inbound dedupe result");
      }
      inboundB.releaseInboundDedupe(firstClaim.key);
      expect(inboundA.claimInboundDedupe(sharedInboundContext)).toMatchObject({
        status: "claimed",
      });
    } finally {
      inboundA.resetInboundDedupe();
      inboundB.resetInboundDedupe();
    }
  });

  it("shares claim/commit state across distinct module instances", async () => {
    const inboundA = await importFreshModule<typeof import("./inbound-dedupe.js")>(
      import.meta.url,
      "./inbound-dedupe.js?scope=commit-a",
    );
    const inboundB = await importFreshModule<typeof import("./inbound-dedupe.js")>(
      import.meta.url,
      "./inbound-dedupe.js?scope=commit-b",
    );

    inboundA.resetInboundDedupe();
    inboundB.resetInboundDedupe();

    try {
      const firstClaim = inboundA.claimInboundDedupe(sharedInboundContext);
      expect(firstClaim).toMatchObject({ status: "claimed" });
      if (firstClaim.status !== "claimed") {
        throw new Error("expected claimed inbound dedupe result");
      }
      inboundA.commitInboundDedupe(firstClaim.key);
      expect(inboundB.claimInboundDedupe(sharedInboundContext)).toMatchObject({
        status: "duplicate",
      });
    } finally {
      inboundA.resetInboundDedupe();
      inboundB.resetInboundDedupe();
    }
  });

  it("releases an in-flight claim so the same message can be retried", () => {
    const claim = claimInboundDedupe(sharedInboundContext);
    expect(claim).toMatchObject({ status: "claimed" });
    if (claim.status !== "claimed") {
      throw new Error("expected claimed inbound dedupe result");
    }
    // A turn that produced nothing must hand the key back, otherwise the provider
    // redelivery is dropped forever.
    releaseInboundDedupe(claim.key);
    expect(claimInboundDedupe(sharedInboundContext)).toMatchObject({ status: "claimed" });
  });

  it("lets a redelivery win once an in-flight claim has outlived the dedupe TTL", () => {
    // A dispatch whose promise never settles runs neither the catch nor the
    // finally, so its claim is never released. Without ageing, every later
    // redelivery of that message would be dropped as "inflight" for the life of
    // the process. Past the TTL even a committed key would have expired, so the
    // stranded claim must not outrank a retry.
    const start = 1_700_000_000_000;
    const ttlMs = 20 * 60_000;
    const inFlight = new Map<string, number>();

    const first = claimInboundDedupe(sharedInboundContext, { now: start, inFlight });
    expect(first).toMatchObject({ status: "claimed" });

    // Still within the window: the live dispatch keeps the claim.
    expect(
      claimInboundDedupe(sharedInboundContext, { now: start + ttlMs - 1, inFlight }),
    ).toMatchObject({ status: "inflight" });

    // Past the window: treat the claim as abandoned.
    expect(
      claimInboundDedupe(sharedInboundContext, { now: start + ttlMs, inFlight }),
    ).toMatchObject({ status: "claimed" });
  });

  it("keeps a committed key from blocking a different inbound message", async () => {
    const claim = claimInboundDedupe(sharedInboundContext);
    expect(claim).toMatchObject({ status: "claimed" });
    if (claim.status !== "claimed") {
      throw new Error("expected claimed inbound dedupe result");
    }
    commitInboundDedupe(claim.key);
    // Same peer/session, different provider message id: must not be swallowed.
    expect(claimInboundDedupe({ ...sharedInboundContext, MessageSid: "msg-2" })).toMatchObject({
      status: "claimed",
    });
  });
});
