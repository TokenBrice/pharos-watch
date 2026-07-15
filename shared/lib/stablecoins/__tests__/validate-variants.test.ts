import { describe, expect, it } from "vitest";
import type { MechanismArchetype, StablecoinMeta, VariantKind } from "../../../types";
import { validateVariantRelationships } from "../validate-variants";

interface CoinOverrides extends Partial<StablecoinMeta> {
  id: string;
}

function makeCoin(overrides: CoinOverrides): StablecoinMeta {
  return {
    name: overrides.id,
    symbol: overrides.id.toUpperCase(),
    flags: {
      backing: "rwa-backed",
      pegCurrency: "USD",
      governance: "centralized",
      yieldBearing: false,
      rwa: false,
      navToken: false,
    },
    ...overrides,
  } as StablecoinMeta;
}

function makeParent(id: string, archetype: MechanismArchetype | null): StablecoinMeta {
  return makeCoin({
    id,
    flags: {
      backing: "rwa-backed",
      pegCurrency: "USD",
      governance: "centralized",
      yieldBearing: false,
      rwa: false,
      navToken: false,
    },
    ...(archetype != null ? { mechanismArchetype: archetype } : {}),
  });
}

function makeChild(id: string, variantOf: string, overrides: Partial<StablecoinMeta> = {}): StablecoinMeta {
  return makeCoin({
    id,
    variantOf,
    variantKind: "savings-passthrough" as VariantKind,
    pegReferenceId: variantOf,
    flags: {
      backing: "rwa-backed",
      pegCurrency: "USD",
      governance: "centralized",
      yieldBearing: true,
      rwa: false,
      navToken: true,
    },
    ...overrides,
  });
}

describe("validateVariantRelationships", () => {
  it("passes when a child shares the parent's archetype", () => {
    const parent = makeParent("parent-a", "fiat-cash");
    const child = makeChild("child-a", "parent-a", {
      mechanismArchetype: "fiat-cash",
    });
    expect(validateVariantRelationships([parent, child])).toEqual([]);
  });

  it("passes when a child has no declared archetype (inherits from parent)", () => {
    const parent = makeParent("parent-a", "cdp");
    const child = makeChild("child-a", "parent-a");
    expect(validateVariantRelationships([parent, child])).toEqual([]);
  });

  it("preserves variant metadata on quarantined historical records", () => {
    const parent = makeParent("parent-a", "fiat-cash");
    const child = makeChild("child-a", "parent-a", {
      status: "quarantined",
      listingStatusReview: {
        changedAt: "2026-07-15",
        reason: "Runtime coverage is under review.",
        reviewBy: "2026-08-15",
      },
    });

    expect(validateVariantRelationships([parent, child])).toEqual([]);
  });

  it("rejects variant metadata on pre-launch records", () => {
    const parent = makeParent("parent-a", "fiat-cash");
    const child = makeChild("child-a", "parent-a", { status: "pre-launch" });

    expect(validateVariantRelationships([parent, child])).toEqual([
      expect.stringContaining("only post-launch readable assets"),
    ]);
  });

  it("passes when a child diverges and sets archetypeOverride: true", () => {
    const parent = makeParent("parent-a", "fiat-cash");
    const child = makeChild("child-a", "parent-a", {
      mechanismArchetype: "synthetic-delta-neutral",
      archetypeOverride: true,
    });
    expect(validateVariantRelationships([parent, child])).toEqual([]);
  });

  it("rejects a redundant override when the child matches its parent", () => {
    const parent = makeParent("parent-a", "fiat-cash");
    const child = makeChild("child-a", "parent-a", {
      mechanismArchetype: "fiat-cash",
      archetypeOverride: true,
    });

    expect(validateVariantRelationships([parent, child])).toEqual([
      expect.stringContaining("archetypeOverride is only valid for an intentional departure"),
    ]);
  });

  it("fails when a child diverges from the parent's archetype without an override", () => {
    const parent = makeParent("parent-a", "fiat-cash");
    const child = makeChild("child-a", "parent-a", {
      mechanismArchetype: "synthetic-delta-neutral",
    });
    const errors = validateVariantRelationships([parent, child]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("child-a");
    expect(errors[0]).toContain("synthetic-delta-neutral");
    expect(errors[0]).toContain("fiat-cash");
    expect(errors[0]).toContain("archetypeOverride: true");
  });

  it("fails when a child declares an archetype but the parent's archetype is null (no override)", () => {
    // I7: matches the susn-noon / usn-noon situation pre-fix.
    const parent = makeParent("parent-a", null);
    const child = makeChild("child-a", "parent-a", {
      mechanismArchetype: "synthetic-delta-neutral",
    });
    const errors = validateVariantRelationships([parent, child]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("child-a");
    expect(errors[0]).toContain("parent-a");
    expect(errors[0]).toContain("no archetype");
    expect(errors[0]).toContain("archetypeOverride: true");
  });

  it("passes when a child declares an archetype against a null-parent with override set", () => {
    // I7 fix: susn-noon now adds archetypeOverride: true.
    const parent = makeParent("parent-a", null);
    const child = makeChild("child-a", "parent-a", {
      mechanismArchetype: "synthetic-delta-neutral",
      archetypeOverride: true,
    });
    expect(validateVariantRelationships([parent, child])).toEqual([]);
  });

  it("fails when variantOf points to an id that does not exist in the registry", () => {
    // N1: the resolver silently falls back; validator catches the data hole.
    const child = makeChild("child-a", "ghost-parent");
    const errors = validateVariantRelationships([child]);
    const missingParentError = errors.find((e) =>
      e.includes('variantOf "ghost-parent" does not match any tracked stablecoin id'),
    );
    expect(missingParentError).toBeDefined();
  });

  it("fails when variantOf references the coin itself (self-cycle)", () => {
    // I12: must not loop.
    const coin = makeChild("self-cycle", "self-cycle");
    const errors = validateVariantRelationships([coin]);
    const selfCycleError = errors.find((e) => e.includes("self-cycle"));
    expect(selfCycleError).toBeDefined();
    expect(selfCycleError).toContain("must not reference the asset itself");
  });

  it("fails when an active USD nav token has a direct wrapper parent but no variant metadata", () => {
    const parent = makeParent("parent-a", "fiat-cash");
    const child = makeCoin({
      id: "missing-variant",
      pegReferenceId: "parent-a",
      flags: {
        backing: "rwa-backed",
        pegCurrency: "USD",
        governance: "centralized",
        yieldBearing: true,
        rwa: false,
        navToken: true,
      },
      reserves: [
        {
          name: "Parent wrapper exposure",
          pct: 100,
          risk: "medium",
          coinId: "parent-a",
          depType: "wrapper",
        },
      ],
    });

    const errors = validateVariantRelationships([parent, child]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("missing-variant");
    expect(errors[0]).toContain("does not declare variantOf / variantKind");
  });

  it("does not infer a missing variant for mixed-strategy NAV tokens", () => {
    const parentA = makeParent("parent-a", "fiat-cash");
    const parentB = makeParent("parent-b", "fiat-cash");
    const child = makeCoin({
      id: "mixed-strategy",
      flags: {
        backing: "rwa-backed",
        pegCurrency: "USD",
        governance: "centralized",
        yieldBearing: true,
        rwa: false,
        navToken: true,
      },
      reserves: [
        {
          name: "First parent",
          pct: 50,
          risk: "medium",
          coinId: "parent-a",
          depType: "wrapper",
        },
        {
          name: "Second parent",
          pct: 50,
          risk: "medium",
          coinId: "parent-b",
          depType: "wrapper",
        },
      ],
    });

    expect(validateVariantRelationships([parentA, parentB, child])).toEqual([]);
  });

  it("does not infer a missing variant for basket NAV tokens with one wrapper parent and other tracked collateral", () => {
    const wrapperParent = makeParent("wrapper-parent", "fiat-cash");
    const collateralParent = makeChild("collateral-parent", "wrapper-parent");
    const child = makeCoin({
      id: "basket-nav-token",
      flags: {
        backing: "rwa-backed",
        pegCurrency: "USD",
        governance: "centralized",
        yieldBearing: true,
        rwa: false,
        navToken: true,
      },
      reserves: [
        {
          name: "Wrapper leg",
          pct: 75,
          risk: "medium",
          coinId: "wrapper-parent",
          depType: "wrapper",
        },
        {
          name: "Other tracked basket leg",
          pct: 25,
          risk: "low",
          coinId: "collateral-parent",
          depType: "collateral",
        },
      ],
    });

    expect(validateVariantRelationships([wrapperParent, collateralParent, child])).toEqual([]);
  });
});
