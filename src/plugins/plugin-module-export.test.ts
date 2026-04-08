import { describe, expect, it } from "vitest";
import {
  resolveBundledChannelEntryContract,
  resolveBundledChannelSetupEntryContract,
  resolvePluginModuleExport,
  unwrapPluginModuleDefaultExport,
} from "./plugin-module-export.js";

describe("unwrapPluginModuleDefaultExport", () => {
  it("returns function exports as-is", () => {
    const fn = () => {};
    expect(unwrapPluginModuleDefaultExport(fn)).toBe(fn);
  });

  it("unwraps one level of default", () => {
    const inner = { register: () => {} };
    expect(unwrapPluginModuleDefaultExport({ default: inner })).toBe(inner);
  });

  it("unwraps nested default until register is visible", () => {
    const plugin = { id: "x", register: () => {} };
    const wrapped = { default: { default: { default: plugin } } };
    expect(unwrapPluginModuleDefaultExport(wrapped)).toBe(plugin);
  });

  it("stops at self-referential default", () => {
    const self = { default: undefined as unknown };
    self.default = self;
    expect(unwrapPluginModuleDefaultExport(self)).toBe(self);
  });
});

describe("resolvePluginModuleExport", () => {
  it("resolves direct function export", () => {
    const fn = () => {};
    const r = resolvePluginModuleExport(fn);
    expect(r.register).toBe(fn);
    expect(r.definition).toBeUndefined();
  });

  it("resolves default export object with register", () => {
    const register = () => {};
    const r = resolvePluginModuleExport({ default: { register } });
    expect(r.register).toBe(register);
    expect(r.definition?.register).toBe(register);
  });

  it("resolves double-wrapped default export (ESM/CJS interop)", () => {
    const register = () => {};
    const def = { id: "feishu", register };
    const r = resolvePluginModuleExport({ default: { default: def } });
    expect(r.register).toBe(register);
    expect(r.definition).toBe(def);
  });

  it("resolves activate when register is absent", () => {
    const activate = () => {};
    const r = resolvePluginModuleExport({ default: { activate } });
    expect(r.register).toBe(activate);
  });

  it("returns empty when no register/activate", () => {
    const r = resolvePluginModuleExport({});
    expect(r.register).toBeUndefined();
    expect(r.definition).toEqual({});
  });
});

describe("resolveBundledChannelEntryContract", () => {
  const makeContract = () => ({
    kind: "bundled-channel-entry" as const,
    id: "feishu",
    name: "Feishu",
    description: "d",
    configSchema: {},
    register: () => {},
    loadChannelPlugin: () => ({}),
  });

  it("resolves nested default exports", () => {
    const inner = makeContract();
    const entry = resolveBundledChannelEntryContract({ default: { default: inner } });
    expect(entry?.id).toBe("feishu");
    expect(typeof entry?.register).toBe("function");
  });

  it("returns null when contract is missing fields", () => {
    expect(
      resolveBundledChannelEntryContract({
        default: { kind: "bundled-channel-entry", id: "x" },
      }),
    ).toBeNull();
  });
});

describe("resolveBundledChannelSetupEntryContract", () => {
  it("resolves nested default exports", () => {
    const inner = {
      kind: "bundled-channel-setup-entry" as const,
      loadSetupPlugin: () => ({}) as object,
    };
    const entry = resolveBundledChannelSetupEntryContract({ default: { default: inner } });
    expect(entry?.kind).toBe("bundled-channel-setup-entry");
    expect(typeof entry?.loadSetupPlugin).toBe("function");
  });
});
