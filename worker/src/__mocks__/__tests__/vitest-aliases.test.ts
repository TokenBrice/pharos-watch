import { describe, it, expect } from "vitest";

// Regression test for vitest.config.ts WASM alias contract. If any of the
// upstream package paths change (e.g., `@cf-wasm/resvg/workerd` is renamed),
// the alias silently stops resolving to the local stub and tests start
// pulling in the real WASM-dependent module. This test asserts that each
// aliased import lands on the stub by checking for the `__stub` marker.

describe("vitest WASM alias contract", () => {
  it("resolves satori/standalone to stub", async () => {
    const mod = await import("satori/standalone");
    expect((mod as { __stub?: true }).__stub).toBe(true);
  });

  it("resolves satori/yoga.wasm to stub", async () => {
    const mod = await import("satori/yoga.wasm");
    expect((mod as { __stub?: true }).__stub).toBe(true);
  });

  it("resolves @cf-wasm/resvg/workerd to stub", async () => {
    const mod = await import("@cf-wasm/resvg/workerd");
    expect((mod as { __stub?: true }).__stub).toBe(true);
  });

  it("resolves @resvg/resvg-wasm to stub", async () => {
    const mod = await import("@resvg/resvg-wasm");
    expect((mod as { __stub?: true }).__stub).toBe(true);
  });
});
