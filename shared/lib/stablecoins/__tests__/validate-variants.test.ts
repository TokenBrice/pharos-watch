import { describe, expect, it } from "vitest";
import type { MechanismArchetype, StablecoinMeta, VariantKind } from "../../../types";
import { validateVariantRelationships } from "../validate-variants";
import {
  makeCatalogCoin as makeCoin,
  NON_RWA_STABLECOIN_FLAGS,
  YIELD_BEARING_NAV_STABLECOIN_FLAGS,
} from "./test-support";
import { makeWrapperReview } from "./validate-variants.test-support";

function makeParent(id: string, archetype: MechanismArchetype | null): StablecoinMeta {
  return makeCoin({
    id,
    flags: NON_RWA_STABLECOIN_FLAGS,
    ...(archetype != null ? { mechanismArchetype: archetype } : {}),
  });
}

function makeChild(id: string, variantOf: string, overrides: Partial<StablecoinMeta> = {}): StablecoinMeta {
  return makeCoin({
    id,
    variantOf,
    variantKind: "savings-passthrough" as VariantKind,
    pegReferenceId: variantOf,
    flags: YIELD_BEARING_NAV_STABLECOIN_FLAGS,
    ...overrides,
  });
}

describe("validateVariantRelationships", () => {
  it("requires both halves of the variant relationship", () => {
    const parent = makeParent("parent-a", "fiat-cash");
    expect(validateVariantRelationships([parent, makeChild("child-a", parent.id)])).toEqual([]);
    for (const overrides of [{ variantOf: undefined }, { variantKind: undefined }]) {
      expect(validateVariantRelationships([parent, makeChild("child-a", parent.id, overrides)])).toEqual([
        expect.stringContaining("variantOf and variantKind must both be set"),
      ]);
    }
  });

  it("requires active parents only for active children, not quarantined children", () => {
    const parent = makeParent("parent-a", "fiat-cash");
    parent.status = "quarantined";
    const child = makeChild("child-a", parent.id);
    expect(validateVariantRelationships([parent, child])).toEqual([
      expect.stringContaining("variantOf must point to an active tracked stablecoin"),
    ]);
    child.status = "quarantined";
    expect(validateVariantRelationships([parent, child])).toEqual([]);
  });

  it("independently rejects variant and NAV parents", () => {
    const root = makeParent("root", "fiat-cash");
    const parent = makeParent("parent-a", "fiat-cash");
    const child = makeChild("child-a", parent.id);
    expect(validateVariantRelationships([root, parent, child])).toEqual([]);
    const wrappedParent = makeChild(parent.id, root.id, {
      variantKind: "pure-wrapper", flags: NON_RWA_STABLECOIN_FLAGS,
    });
    expect(validateVariantRelationships([root, wrappedParent, child])).toEqual([
      expect.stringContaining("variant parent parent-a must not itself declare variantOf"),
    ]);
    expect(validateVariantRelationships([
      { ...parent, flags: YIELD_BEARING_NAV_STABLECOIN_FLAGS }, child,
    ])).toEqual([expect.stringContaining("variant parent parent-a must not be a navToken")]);
  });

  it("requires the validator's peg reference even when the schema permits its absence", () => {
    const parent = makeParent("parent-a", "fiat-cash");
    for (const pegReferenceId of [undefined, "other-parent"]) {
      expect(validateVariantRelationships([
        parent, makeChild("child-a", parent.id, { pegReferenceId }),
      ])).toEqual([expect.stringContaining("pegReferenceId must equal variantOf")]);
    }
  });

  it("rejects a non-pure variant without NAV accrual", () => {
    const parent = makeParent("parent-a", "fiat-cash");
    expect(validateVariantRelationships([
      parent, makeChild("child-a", parent.id, { flags: NON_RWA_STABLECOIN_FLAGS }),
    ])).toEqual([expect.stringContaining("non-pure tracked variants must keep flags.navToken === true")]);
  });

  it("passes when a child shares the parent's archetype", () => {
    const parent = makeParent("parent-a", "fiat-cash");
    const child = makeChild("child-a", "parent-a", {
      mechanismArchetype: "fiat-cash",
    });
    expect(validateVariantRelationships([parent, child])).toEqual([]);
  });

  it("accepts a non-NAV pure 1:1 wrapper", () => {
    const parent = makeParent("parent-a", "tbill");
    const child = makeChild("child-a", "parent-a", {
      mechanismArchetype: "tbill",
      variantKind: "pure-wrapper",
      flags: {
        backing: "rwa-backed",
        pegCurrency: "USD",
        governance: "centralized",
        yieldBearing: false,
        rwa: true,
        navToken: false,
      },
    });

    expect(validateVariantRelationships([parent, child])).toEqual([]);
  });

  it("rejects a NAV-accreting asset labeled as a pure wrapper", () => {
    const parent = makeParent("parent-a", "tbill");
    const child = makeChild("child-a", "parent-a", {
      variantKind: "pure-wrapper",
    });

    expect(validateVariantRelationships([parent, child])).toEqual([
      expect.stringContaining("pure-wrapper variants must keep flags.navToken === false"),
    ]);
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
      flags: YIELD_BEARING_NAV_STABLECOIN_FLAGS,
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

  it("fails when a non-NAV asset has a reviewed serial wrapper parent but no variant metadata", () => {
    const parent = makeParent("parent-a", "fiat-cash");
    const child = makeCoin({
      id: "missing-pure-wrapper-variant",
      reserves: [
        {
          name: "Parent wrapper exposure",
          pct: 100,
          risk: "low",
          coinId: "parent-a",
          depType: "wrapper",
        },
      ],
      dependencyReview: makeWrapperReview(true),
    });

    const errors = validateVariantRelationships([parent, child]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("active USD asset with a reviewed serial wrapper");
    expect(errors[0]).toContain("does not declare variantOf / variantKind");
  });

  it("applies the default serial-claim role to reviewed wrapper relationships", () => {
    const parent = makeParent("parent-a", "fiat-cash");
    const child = makeCoin({
      id: "missing-default-role-variant",
      dependencyReview: makeWrapperReview(false),
    });

    const errors = validateVariantRelationships([parent, child]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("active USD asset with a reviewed serial wrapper");
    expect(errors[0]).toContain("does not declare variantOf / variantKind");
  });

  it("does not infer a missing variant for mixed-strategy NAV tokens", () => {
    const parentA = makeParent("parent-a", "fiat-cash");
    const parentB = makeParent("parent-b", "fiat-cash");
    const child = makeCoin({
      id: "mixed-strategy",
      flags: YIELD_BEARING_NAV_STABLECOIN_FLAGS,
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
      flags: YIELD_BEARING_NAV_STABLECOIN_FLAGS,
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
