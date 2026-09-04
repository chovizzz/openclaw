import { describe, expect, it, vi } from "vitest";
import {
  createPinnedLookup,
  type LookupFn,
  resolvePinnedHostname,
  resolvePinnedHostnameWithPolicy,
  SsrFBlockedError,
} from "./ssrf.js";

function createPublicLookupMock(): LookupFn {
  return vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupFn;
}

describe("ssrf pinning", () => {
  it("pins resolved addresses for the target hostname", async () => {
    const lookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "93.184.216.35", family: 4 },
    ]) as unknown as LookupFn;

    const pinned = await resolvePinnedHostname("Example.com.", lookup);
    expect(pinned.hostname).toBe("example.com");
    expect(pinned.addresses).toEqual(["93.184.216.34", "93.184.216.35"]);

    const first = await new Promise<{ address: string; family?: number }>((resolve, reject) => {
      pinned.lookup("example.com", (err, address, family) => {
        if (err) {
          reject(err);
        } else {
          resolve({ address: address, family });
        }
      });
    });
    expect(first.address).toBe("93.184.216.34");
    expect(first.family).toBe(4);

    const all = await new Promise<unknown>((resolve, reject) => {
      pinned.lookup("example.com", { all: true }, (err, addresses) => {
        if (err) {
          reject(err);
        } else {
          resolve(addresses);
        }
      });
    });
    expect(Array.isArray(all)).toBe(true);
    expect((all as Array<{ address: string }>).map((entry) => entry.address)).toEqual(
      pinned.addresses,
    );
  });

  it("keeps automatic pinned lookups on IPv4 when both address families are available", async () => {
    const lookup = createPinnedLookup({
      hostname: "api.anthropic.com",
      addresses: ["160.79.104.10", "2607:6bc0::10"],
    });
    const lookupDefault = () =>
      new Promise<{ address: string; family?: number }>((resolve, reject) => {
        lookup("api.anthropic.com", (err, address, family) => {
          if (err) {
            reject(err);
          } else {
            resolve({ address: address, family });
          }
        });
      });
    const lookupWithOptions = (options: { family?: number }) =>
      new Promise<{ address: string; family?: number }>((resolve, reject) => {
        lookup("api.anthropic.com", options, (err, address, family) => {
          if (err) {
            reject(err);
          } else {
            resolve({ address: address, family });
          }
        });
      });

    await expect(lookupDefault()).resolves.toEqual({ address: "160.79.104.10", family: 4 });
    await expect(lookupDefault()).resolves.toEqual({ address: "160.79.104.10", family: 4 });

    const all = await new Promise<unknown>((resolve, reject) => {
      lookup("api.anthropic.com", { all: true }, (err, addresses) => {
        if (err) {
          reject(err);
        } else {
          resolve(addresses);
        }
      });
    });
    expect(all).toEqual([{ address: "160.79.104.10", family: 4 }]);

    // Reverse check: an explicit family=6 request must still receive the IPv6 record.
    await expect(lookupWithOptions({ family: 6 })).resolves.toEqual({
      address: "2607:6bc0::10",
      family: 6,
    });
  });

  it("falls back to IPv6 records when the pin has no IPv4 address", async () => {
    const lookup = createPinnedLookup({
      hostname: "v6only.example",
      addresses: ["2607:6bc0::10", "2607:6bc0::11"],
    });
    const all = await new Promise<unknown>((resolve, reject) => {
      lookup("v6only.example", { all: true }, (err, addresses) => {
        if (err) {
          reject(err);
        } else {
          resolve(addresses);
        }
      });
    });
    expect(all).toEqual([
      { address: "2607:6bc0::10", family: 6 },
      { address: "2607:6bc0::11", family: 6 },
    ]);
  });

  it("still resolves trusted hostnames that map to non-loopback private addresses", async () => {
    const lookup = vi.fn(async () => [{ address: "10.1.2.3", family: 4 }]) as unknown as LookupFn;
    const pinned = await resolvePinnedHostnameWithPolicy("nas.corp.example", {
      lookupFn: lookup,
      policy: { allowedHostnames: ["nas.corp.example"] },
    });
    expect(pinned.addresses).toEqual(["10.1.2.3"]);
  });

  it("still resolves explicitly trusted loopback hostnames to loopback", async () => {
    const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as LookupFn;
    for (const host of ["localhost", "127.0.0.1", "gateway.localhost"]) {
      const pinned = await resolvePinnedHostnameWithPolicy(host, {
        lookupFn: lookup,
        policy: { allowedHostnames: [host] },
      });
      expect(pinned.addresses).toEqual(["127.0.0.1"]);
    }
  });

  it("blocks loopback rebinding for a trusted non-loopback hostname", async () => {
    const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as LookupFn;
    await expect(
      resolvePinnedHostnameWithPolicy("rebind.example", {
        lookupFn: lookup,
        policy: { allowedHostnames: ["rebind.example"] },
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
  });

  it("keeps loopback allowed for trusted hostnames when private network is allowed", async () => {
    const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as LookupFn;
    const pinned = await resolvePinnedHostnameWithPolicy("chrome.example", {
      lookupFn: lookup,
      policy: {
        allowedHostnames: ["chrome.example"],
        dangerouslyAllowPrivateNetwork: true,
      },
    });
    expect(pinned.addresses).toEqual(["127.0.0.1"]);
  });

  it.each([
    { name: "RFC1918 private address", address: "10.0.0.8" },
    { name: "RFC2544 benchmarking range", address: "198.18.0.1" },
    { name: "TEST-NET-2 reserved range", address: "198.51.100.1" },
  ])("rejects blocked DNS results: $name", async ({ address }) => {
    const lookup = vi.fn(async () => [{ address, family: 4 }]) as unknown as LookupFn;
    await expect(resolvePinnedHostname("example.com", lookup)).rejects.toThrow(/private|internal/i);
  });

  it("allows RFC2544 benchmark range addresses only when policy explicitly opts in", async () => {
    const lookup = vi.fn(async () => [
      { address: "198.18.0.153", family: 4 },
    ]) as unknown as LookupFn;

    await expect(resolvePinnedHostname("api.telegram.org", lookup)).rejects.toThrow(
      /private|internal/i,
    );

    const pinned = await resolvePinnedHostnameWithPolicy("api.telegram.org", {
      lookupFn: lookup,
      policy: { allowRfc2544BenchmarkRange: true },
    });
    expect(pinned.addresses).toContain("198.18.0.153");
  });

  it("falls back for non-matching hostnames", async () => {
    const fallback = vi.fn((host: string, options?: unknown, callback?: unknown) => {
      const cb = typeof options === "function" ? options : (callback as () => void);
      (cb as (err: null, address: string, family: number) => void)(null, "1.2.3.4", 4);
    }) as unknown as Parameters<typeof createPinnedLookup>[0]["fallback"];
    const lookup = createPinnedLookup({
      hostname: "example.com",
      addresses: ["93.184.216.34"],
      fallback,
    });

    const result = await new Promise<{ address: string }>((resolve, reject) => {
      lookup("other.test", (err, address) => {
        if (err) {
          reject(err);
        } else {
          resolve({ address: address });
        }
      });
    });

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(result.address).toBe("1.2.3.4");
  });

  it("fails loud when a pinned lookup is created without any addresses", () => {
    expect(() =>
      createPinnedLookup({
        hostname: "example.com",
        addresses: [],
      }),
    ).toThrow("Pinned lookup requires at least one address for example.com");
  });

  it("enforces hostname allowlist when configured", async () => {
    const lookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ]) as unknown as LookupFn;

    await expect(
      resolvePinnedHostnameWithPolicy("api.example.com", {
        lookupFn: lookup,
        policy: { hostnameAllowlist: ["cdn.example.com", "*.trusted.example"] },
      }),
    ).rejects.toThrow(/allowlist/i);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("supports wildcard hostname allowlist patterns", async () => {
    const lookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ]) as unknown as LookupFn;

    await expect(
      resolvePinnedHostnameWithPolicy("assets.example.com", {
        lookupFn: lookup,
        policy: { hostnameAllowlist: ["*.example.com"] },
      }),
    ).resolves.toMatchObject({ hostname: "assets.example.com" });

    await expect(
      resolvePinnedHostnameWithPolicy("example.com", {
        lookupFn: lookup,
        policy: { hostnameAllowlist: ["*.example.com"] },
      }),
    ).rejects.toThrow(/allowlist/i);
  });

  it.each([
    {
      name: "ISATAP embedded private IPv4",
      hostname: "2001:db8:1234::5efe:127.0.0.1",
    },
    {
      name: "legacy loopback IPv4 literal",
      hostname: "0177.0.0.1",
    },
    {
      name: "unsupported short-form IPv4 literal",
      hostname: "8.8.2056",
    },
  ])("blocks $name before DNS lookup", async ({ hostname }) => {
    const lookup = createPublicLookupMock();

    await expect(resolvePinnedHostnameWithPolicy(hostname, { lookupFn: lookup })).rejects.toThrow(
      SsrFBlockedError,
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it("sorts IPv4 addresses before IPv6 in pinned results", async () => {
    const lookup = vi.fn(async () => [
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700:4700::1001", family: 6 },
      { address: "93.184.216.35", family: 4 },
    ]) as unknown as LookupFn;

    const pinned = await resolvePinnedHostname("example.com", lookup);
    expect(pinned.addresses).toEqual([
      "93.184.216.34",
      "93.184.216.35",
      "2606:4700:4700::1111",
      "2606:4700:4700::1001",
    ]);
  });

  it("uses DNS family metadata for ordering (not address string heuristics)", async () => {
    const lookup = vi.fn(async () => [
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 4 },
      { address: "93.184.216.34", family: 6 },
    ]) as unknown as LookupFn;

    const pinned = await resolvePinnedHostname("example.com", lookup);
    expect(pinned.addresses).toEqual(["2606:2800:220:1:248:1893:25c8:1946", "93.184.216.34"]);
  });

  it("allows ISATAP embedded private IPv4 when private network is explicitly enabled", async () => {
    const lookup = vi.fn(async () => [
      { address: "2001:db8:1234::5efe:127.0.0.1", family: 6 },
    ]) as unknown as LookupFn;

    await expect(
      resolvePinnedHostnameWithPolicy("2001:db8:1234::5efe:127.0.0.1", {
        lookupFn: lookup,
        policy: { allowPrivateNetwork: true },
      }),
    ).resolves.toMatchObject({
      hostname: "2001:db8:1234::5efe:127.0.0.1",
      addresses: ["2001:db8:1234::5efe:127.0.0.1"],
    });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("accepts dangerouslyAllowPrivateNetwork as an allowPrivateNetwork alias", async () => {
    const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as LookupFn;

    await expect(
      resolvePinnedHostnameWithPolicy("localhost", {
        lookupFn: lookup,
        policy: { dangerouslyAllowPrivateNetwork: true },
      }),
    ).resolves.toMatchObject({
      hostname: "localhost",
      addresses: ["127.0.0.1"],
    });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  describe("asynchronous delivery contract", () => {
    function createLookup() {
      return createPinnedLookup({
        hostname: "api.telegram.org",
        addresses: ["149.154.167.220", "2001:67c:4e8:f004::9"],
      });
    }

    async function flushLookupCallback(): Promise<void> {
      await new Promise<void>((resolve) => {
        process.nextTick(resolve);
      });
    }

    it("defers callbacks without lookup options", async () => {
      const callback = vi.fn();
      createLookup()("api.telegram.org", callback);

      expect(callback).not.toHaveBeenCalled();
      await flushLookupCallback();
      expect(callback).toHaveBeenCalledWith(null, "149.154.167.220", 4);
    });

    it("defers callbacks for all-address lookups", async () => {
      const callback = vi.fn();
      createLookup()("api.telegram.org", { all: true }, callback);

      expect(callback).not.toHaveBeenCalled();
      await flushLookupCallback();
      // Automatic (no explicit family) lookups prefer IPv4 records when any exist,
      // so dual-stack pins do not drift onto IPv6 on later attempts.
      expect(callback).toHaveBeenCalledWith(null, [{ address: "149.154.167.220", family: 4 }]);
    });

    it("defers callbacks for explicit address families", async () => {
      const callback = vi.fn();
      createLookup()("api.telegram.org", { family: 6 }, callback);

      expect(callback).not.toHaveBeenCalled();
      await flushLookupCallback();
      expect(callback).toHaveBeenCalledWith(null, "2001:67c:4e8:f004::9", 6);
    });
  });
});
