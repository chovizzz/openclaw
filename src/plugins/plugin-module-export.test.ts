import { describe, expect, it } from "vitest";
import {
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
