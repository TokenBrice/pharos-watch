import { describe, it, expect } from "vitest";
import type { StablecoinMeta } from "../../../types";
import { makeStablecoinMeta as makeCoin } from "../../../test-utils/stablecoin";
import { resolveMechanismArchetype } from "../resolve-mechanism-archetype";

function makeRegistry(coins: StablecoinMeta[]): ReadonlyMap<string, StablecoinMeta> {
  return new Map(coins.map((c) => [c.id, c]));
}

describe("resolveMechanismArchetype", () => {
  it("returns own archetype for a parentless coin", () => {
    const coin = makeCoin({ mechanismArchetype: "fiat-cash" });
    const result = resolveMechanismArchetype(coin, makeRegistry([]));
    expect(result).toBe("fiat-cash");
  });

  it("returns null for a parentless coin with no archetype", () => {
    const coin = makeCoin({});
    const result = resolveMechanismArchetype(coin, makeRegistry([]));
    expect(result).toBeNull();
  });

  it("returns parent archetype for a variant without override", () => {
    const parent = makeCoin({ id: "parent-coin", mechanismArchetype: "cdp" });
    const child = makeCoin({
      id: "child-coin",
      variantOf: "parent-coin",
      variantKind: "savings-passthrough",
    });
    const result = resolveMechanismArchetype(child, makeRegistry([parent]));
    expect(result).toBe("cdp");
  });

  it("returns own archetype for a variant with archetypeOverride: true", () => {
    const parent = makeCoin({ id: "parent-coin", mechanismArchetype: "fiat-cash" });
    const child = makeCoin({
      id: "child-coin",
      variantOf: "parent-coin",
      variantKind: "strategy-vault",
      mechanismArchetype: "synthetic-delta-neutral",
      archetypeOverride: true,
    });
    const result = resolveMechanismArchetype(child, makeRegistry([parent]));
    expect(result).toBe("synthetic-delta-neutral");
  });

  it("returns null when parent has no archetype", () => {
    const parent = makeCoin({ id: "parent-coin" });
    const child = makeCoin({
      id: "child-coin",
      variantOf: "parent-coin",
      variantKind: "savings-passthrough",
    });
    const result = resolveMechanismArchetype(child, makeRegistry([parent]));
    expect(result).toBeNull();
  });

  it("falls back to own archetype when parent is missing from registry", () => {
    const child = makeCoin({
      id: "child-coin",
      variantOf: "missing-parent",
      variantKind: "strategy-vault",
      mechanismArchetype: "tbill",
    });
    const result = resolveMechanismArchetype(child, makeRegistry([]));
    expect(result).toBe("tbill");
  });

  it("returns null when parent is missing from registry and child has no archetype", () => {
    const child = makeCoin({
      id: "child-coin",
      variantOf: "missing-parent",
      variantKind: "strategy-vault",
    });
    const result = resolveMechanismArchetype(child, makeRegistry([]));
    expect(result).toBeNull();
  });

  it("returns own archetype without recursing on a self-cycle (variantOf === id)", () => {
    // Data-quality regression guard: validator should reject this, but if it
    // slips through, the resolver must not loop or throw — it returns the
    // coin's own archetype because the "parent" lookup yields the coin itself.
    const coin = makeCoin({
      id: "self-cycle-coin",
      variantOf: "self-cycle-coin",
      variantKind: "savings-passthrough",
      mechanismArchetype: "fiat-cash",
    });
    const result = resolveMechanismArchetype(coin, makeRegistry([coin]));
    expect(result).toBe("fiat-cash");
  });
});
