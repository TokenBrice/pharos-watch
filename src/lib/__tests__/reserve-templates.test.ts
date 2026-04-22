import { describe, it, expect } from "vitest";
import { deriveDependencies } from "@shared/lib/dependency-derivation";
import type { StablecoinMeta, DependencyWeight } from "@shared/types";

// Minimal helper — only fields deriveDependencies reads
function makeMeta(overrides: Partial<StablecoinMeta> = {}): StablecoinMeta {
  return {
    id: "test",
    name: "Test",
    symbol: "TST",
    flags: { governance: "centralized", backing: "rwa-backed", pegCurrency: "USD", yieldBearing: false, rwa: true, navToken: false },
    ...overrides,
  } as StablecoinMeta;
}

describe("deriveDependencies", () => {
  it("returns empty array when no reserves and no dependencies", () => {
    const meta = makeMeta();
    expect(deriveDependencies(meta)).toEqual([]);
  });

  it("falls back to manual dependencies when reserves is empty", () => {
    const deps: DependencyWeight[] = [{ id: "usdc-circle", weight: 0.5 }];
    const meta = makeMeta({ dependencies: deps, reserves: [] });
    expect(deriveDependencies(meta)).toEqual(deps);
  });

  it("falls back to manual dependencies when no reserve has coinId", () => {
    const deps: DependencyWeight[] = [{ id: "usdt-tether", weight: 0.3 }];
    const meta = makeMeta({
      dependencies: deps,
      reserves: [
        { name: "U.S. Treasuries", pct: 80, risk: "very-low" },
        { name: "Cash", pct: 20, risk: "very-low" },
      ],
    });
    expect(deriveDependencies(meta)).toEqual(deps);
  });

  it("derives dependencies from reserve coinId, ignoring manual dependencies", () => {
    const meta = makeMeta({
      dependencies: [{ id: "usdc-circle", weight: 0.1 }], // stale manual entry
      reserves: [
        { name: "USDtb", pct: 90, risk: "low", coinId: "usdtb-ethena" },
        { name: "USDC buffer", pct: 10, risk: "low", coinId: "usdc-circle" },
      ],
    });
    const result = deriveDependencies(meta);
    expect(result).toEqual([
      { id: "usdtb-ethena", weight: 0.9, type: "collateral" },
      { id: "usdc-circle", weight: 0.1, type: "collateral" },
    ]);
  });

  it("only includes slices with coinId, skips non-linked slices", () => {
    const meta = makeMeta({
      reserves: [
        { name: "ETH / stETH", pct: 45, risk: "low" },
        { name: "BTC", pct: 25, risk: "very-low" },
        { name: "SOL", pct: 10, risk: "high" },
        { name: "USDC", pct: 15, risk: "low", coinId: "usdc-circle" },
        { name: "USDT", pct: 5, risk: "low", coinId: "usdt-tether" },
      ],
    });
    const result = deriveDependencies(meta);
    expect(result).toEqual([
      { id: "usdc-circle", weight: 0.15, type: "collateral" },
      { id: "usdt-tether", weight: 0.05, type: "collateral" },
    ]);
  });

  it("preserves depType when set (wrapper)", () => {
    const meta = makeMeta({
      reserves: [
        { name: "USDe", pct: 100, risk: "low", coinId: "usde-ethena", depType: "wrapper" },
      ],
    });
    const result = deriveDependencies(meta);
    expect(result).toEqual([
      { id: "usde-ethena", weight: 1.0, type: "wrapper" },
    ]);
  });

  it("preserves depType when set (mechanism)", () => {
    const meta = makeMeta({
      reserves: [
        { name: "USDC PSM", pct: 30, risk: "low", coinId: "usdc-circle", depType: "mechanism" },
        { name: "ETH / LSTs", pct: 70, risk: "low" },
      ],
    });
    const result = deriveDependencies(meta);
    expect(result).toEqual([
      { id: "usdc-circle", weight: 0.3, type: "mechanism" },
    ]);
  });

  it("returns empty array when no reserves and no dependencies (undefined)", () => {
    const meta = makeMeta({ reserves: undefined, dependencies: undefined });
    expect(deriveDependencies(meta)).toEqual([]);
  });
});
