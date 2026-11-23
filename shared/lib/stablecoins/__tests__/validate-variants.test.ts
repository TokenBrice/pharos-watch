import { describe, expect, it } from "vitest";
import type { MechanismArchetype, VariantKind } from "../../../types/stablecoin-taxonomy";
import type { StablecoinMeta } from "../../../types/stablecoin-meta-schemas";
import { validateVariantRelationships as val } from "../validate-variants";
import { makeCatalogCoin as mkCoin, NON_RWA_STABLECOIN_FLAGS as NON_RWA, YIELD_BEARING_NAV_STABLECOIN_FLAGS as NAV_FLAGS } from "./test-support";

const mkWrapRev = (expRole: boolean): NonNullable<StablecoinMeta["dependencyReview"]> => ({
  reviewedAt: "2026-07-21", reviewer: "test", confidence: "verified", sources: [{ label: "Wrapper evidence", url: "https://example.com/wrapper" }],
  rationale: "The reviewed relationship is a direct 1:1 wrapper claim.",
  relationships: [{ id: "parent-a", weight: 1, type: "wrapper", ...(expRole ? { economicRole: "serial-claim" as const } : {}), reason: "Every child unit is a direct claim on one parent unit." }],
});
const mkParent = (id: string, arch: MechanismArchetype | null): StablecoinMeta => mkCoin({ id, flags: NON_RWA, ...(arch != null ? { mechanismArchetype: arch } : {}) });
const mkChild = (id: string, variantOf: string, ov: Partial<StablecoinMeta> = {}): StablecoinMeta => mkCoin({ id, variantOf, variantKind: "savings-passthrough" as VariantKind, pegReferenceId: variantOf, flags: NAV_FLAGS, ...ov });
const pA = (arch: MechanismArchetype | null = "fiat-cash") => mkParent("parent-a", arch);

describe("validateVariantRelationships", () => {
  it("requires both halves of the variant relationship", () => {
    const p = pA(); expect(val([p, mkChild("child-a", p.id)])).toEqual([]);
    for (const ov of [{ variantOf: undefined }, { variantKind: undefined }]) expect(val([p, mkChild("child-a", p.id, ov)])).toEqual([expect.stringContaining("variantOf and variantKind must both be set")]);
  });

  it("requires active parents only for active children, not quarantined children", () => {
    const p = pA(); p.status = "quarantined"; const c = mkChild("child-a", p.id);
    expect(val([p, c])).toEqual([expect.stringContaining("variantOf must point to an active tracked stablecoin")]);
    c.status = "quarantined"; expect(val([p, c])).toEqual([]);
  });

  it("independently rejects variant and NAV parents", () => {
    const root = mkParent("root", "fiat-cash"), p = pA(), c = mkChild("child-a", p.id);
    expect(val([root, p, c])).toEqual([]);
    expect(val([root, mkChild(p.id, root.id, { variantKind: "pure-wrapper", flags: NON_RWA }), c])).toEqual([expect.stringContaining("variant parent parent-a must not itself declare variantOf")]);
    expect(val([{ ...p, flags: NAV_FLAGS }, c])).toEqual([expect.stringContaining("variant parent parent-a must not be a navToken")]);
  });

  it("requires the validator's peg reference even when the schema permits its absence", () => {
    const p = pA();
    for (const pegReferenceId of [undefined, "other-parent"]) expect(val([p, mkChild("child-a", p.id, { pegReferenceId })])).toEqual([expect.stringContaining("pegReferenceId must equal variantOf")]);
  });

  it("rejects a non-pure variant without NAV accrual", () => {
    expect(val([pA(), mkChild("child-a", "parent-a", { flags: NON_RWA })])).toEqual([expect.stringContaining("non-pure tracked variants must keep flags.navToken === true")]);
  });

  it("passes when a child shares the parent's archetype", () => {
    expect(val([pA(), mkChild("child-a", "parent-a", { mechanismArchetype: "fiat-cash" })])).toEqual([]);
  });

  it("accepts a non-NAV pure 1:1 wrapper", () => {
    expect(val([pA("tbill"), mkChild("child-a", "parent-a", { mechanismArchetype: "tbill", variantKind: "pure-wrapper", flags: { backing: "rwa-backed", pegCurrency: "USD", governance: "centralized", yieldBearing: false, rwa: true, navToken: false } })])).toEqual([]);
  });

  it("rejects a NAV-accreting asset labeled as a pure wrapper", () => {
    expect(val([pA("tbill"), mkChild("child-a", "parent-a", { variantKind: "pure-wrapper" })])).toEqual([expect.stringContaining("pure-wrapper variants must keep flags.navToken === false")]);
  });

  it("passes when a child has no declared archetype (inherits from parent)", () => {
    expect(val([pA("cdp"), mkChild("child-a", "parent-a")])).toEqual([]);
  });

  it("preserves variant metadata on quarantined historical records", () => {
    expect(val([pA(), mkChild("child-a", "parent-a", { status: "quarantined", listingStatusReview: { changedAt: "2026-07-15", reason: "Runtime coverage is under review.", reviewBy: "2026-08-15" } })])).toEqual([]);
  });

  it("rejects variant metadata on pre-launch records", () => {
    expect(val([pA(), mkChild("child-a", "parent-a", { status: "pre-launch" })])).toEqual([expect.stringContaining("only post-launch readable assets")]);
  });

  it("passes when a child diverges and sets archetypeOverride: true", () => {
    expect(val([pA(), mkChild("child-a", "parent-a", { mechanismArchetype: "synthetic-delta-neutral", archetypeOverride: true })])).toEqual([]);
  });

  it("rejects a redundant override when the child matches its parent", () => {
    expect(val([pA(), mkChild("child-a", "parent-a", { mechanismArchetype: "fiat-cash", archetypeOverride: true })])).toEqual([expect.stringContaining("archetypeOverride is only valid for an intentional departure")]);
  });

  it("fails when a child diverges from the parent's archetype without an override", () => {
    const errs = val([pA(), mkChild("child-a", "parent-a", { mechanismArchetype: "synthetic-delta-neutral" })]);
    expect(errs).toHaveLength(1);
    for (const s of ["child-a", "synthetic-delta-neutral", "fiat-cash", "archetypeOverride: true"]) expect(errs[0]).toContain(s);
  });

  it("fails when a child declares an archetype but the parent's archetype is null (no override)", () => {
    const errs = val([pA(null), mkChild("child-a", "parent-a", { mechanismArchetype: "synthetic-delta-neutral" })]);
    expect(errs).toHaveLength(1);
    for (const s of ["child-a", "parent-a", "no archetype", "archetypeOverride: true"]) expect(errs[0]).toContain(s);
  });

  it("passes when a child declares an archetype against a null-parent with override set", () => {
    expect(val([pA(null), mkChild("child-a", "parent-a", { mechanismArchetype: "synthetic-delta-neutral", archetypeOverride: true })])).toEqual([]);
  });

  it("fails when variantOf points to an id that does not exist in the registry", () => {
    expect(val([mkChild("child-a", "ghost-parent")]).find((e) => e.includes('variantOf "ghost-parent" does not match any tracked stablecoin id'))).toBeDefined();
  });

  it("fails when variantOf references the coin itself (self-cycle)", () => {
    const err = val([mkChild("self-cycle", "self-cycle")]).find((e) => e.includes("self-cycle"));
    expect(err).toContain("must not reference the asset itself");
  });

  it("fails when an active USD nav token has a direct wrapper parent but no variant metadata", () => {
    const errs = val([pA(), mkCoin({ id: "missing-variant", pegReferenceId: "parent-a", flags: NAV_FLAGS, reserves: [{ name: "Parent wrapper exposure", pct: 100, risk: "medium", coinId: "parent-a", depType: "wrapper" }] })]);
    expect(errs).toHaveLength(1); expect(errs[0]).toContain("missing-variant"); expect(errs[0]).toContain("does not declare variantOf / variantKind");
  });

  it("fails when a non-NAV asset has a reviewed serial wrapper parent but no variant metadata", () => {
    const errs = val([pA(), mkCoin({ id: "missing-pure-wrapper-variant", reserves: [{ name: "Parent wrapper exposure", pct: 100, risk: "low", coinId: "parent-a", depType: "wrapper" }], dependencyReview: mkWrapRev(true) })]);
    expect(errs).toHaveLength(1); expect(errs[0]).toContain("active USD asset with a reviewed serial wrapper"); expect(errs[0]).toContain("does not declare variantOf / variantKind");
  });

  it("applies the default serial-claim role to reviewed wrapper relationships", () => {
    const errs = val([pA(), mkCoin({ id: "missing-default-role-variant", dependencyReview: mkWrapRev(false) })]);
    expect(errs).toHaveLength(1); expect(errs[0]).toContain("active USD asset with a reviewed serial wrapper"); expect(errs[0]).toContain("does not declare variantOf / variantKind");
  });

  it("does not infer a missing variant for mixed-strategy NAV tokens", () => {
    expect(val([pA(), mkParent("parent-b", "fiat-cash"), mkCoin({ id: "mixed-strategy", flags: NAV_FLAGS, reserves: [{ name: "First parent", pct: 50, risk: "medium", coinId: "parent-a", depType: "wrapper" }, { name: "Second parent", pct: 50, risk: "medium", coinId: "parent-b", depType: "wrapper" }] })])).toEqual([]);
  });

  it("does not infer a missing variant for basket NAV tokens with one wrapper parent and other tracked collateral", () => {
    const wp = mkParent("wrapper-parent", "fiat-cash"), cp = mkChild("collateral-parent", "wrapper-parent");
    expect(val([wp, cp, mkCoin({ id: "basket-nav-token", flags: NAV_FLAGS, reserves: [{ name: "Wrapper leg", pct: 75, risk: "medium", coinId: "wrapper-parent", depType: "wrapper" }, { name: "Other tracked basket leg", pct: 25, risk: "low", coinId: "collateral-parent", depType: "collateral" }] })])).toEqual([]);
  });
});
