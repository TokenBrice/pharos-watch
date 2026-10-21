import { describe, expect, it } from "vitest";
import registryJson from "../../data/safety-score-v9/lender-collateral-classes-v1.json";
import policyJson from "../../data/safety-score-v9/methodology-policy-candidate-v1.json";
import { LenderCollateralClassesRegistrySchema } from "../../types/safety-score-v9-lender-book";
import { getLenderCollateralClassesRegistry } from "../safety-score-v9/lender-collateral-classes";
import { reviewedRegistryEnvelopeDigest } from "../safety-score-v9/reviewed-registry";
import legacyPolicy from "./fixtures/lender-collateral-classes-policy-v10.28.json";

const legacyRows = legacyPolicy.semantic.backing.lenderCollateralBook.collateralClasses;

function classMapping(rows: readonly { chain: string; address: string; class: string }[]) {
  return Object.fromEntries(rows.map((row) => [`${row.chain}:${row.address}`, row.class]));
}

describe("reviewed lender collateral class registry", () => {
  it("preserves the pre-extraction mapping and original evidence", () => {
    const admitted = getLenderCollateralClassesRegistry();
    expect(classMapping(admitted.registry.reviews)).toEqual(classMapping(legacyRows));
    expect(admitted.registry.reviews.map(({ reviewer: _reviewer, ...row }) => row)).toEqual(legacyRows);
    for (const row of legacyRows) {
      expect(admitted.get(`${row.chain}:${row.address}`)?.class).toBe(row.class);
    }
    expect(policyJson.semantic.backing.lenderCollateralBook).not.toHaveProperty("collateralClasses");
  });

  it("retains exact-chain lookup, receipt identity and explicit bounded-unknown classifications", () => {
    const admitted = getLenderCollateralClassesRegistry();
    expect(admitted.get("ethereum:0x232128844e5af56fd4b3f8bf97e08ab477282ab5")?.class).toBe("yield-bearing-stable");
    expect(admitted.get("ethereum:0x7f47c3e6b2c00fc4eb4d5ae50d0ab0ab6888eb4d")?.class).toBe("principal-token");
    expect(admitted.get("monad:0xee8c0e9f1bffb4eb878d8f15f368a02a35481242")?.class).toBe("other-unknown");
    expect(admitted.get("base:0x232128844e5af56fd4b3f8bf97e08ab477282ab5")).toBeUndefined();
    expect(admitted.get("Ethereum:0x232128844e5af56fd4b3f8bf97e08ab477282ab5")).toBeUndefined();
    expect(admitted.get("ethereum:0x232128844E5AF56FD4B3F8BF97E08AB477282AB5")).toBeUndefined();
    expect(admitted.get("ethereum:0x0000000000000000000000000000000000000001")).toBeUndefined();
    expect(admitted.get("toString")).toBeUndefined();
  });

  it("admits once, freezes evidence and binds registry identity separately from methodology policy", () => {
    const admitted = getLenderCollateralClassesRegistry();
    expect(getLenderCollateralClassesRegistry()).toBe(admitted);
    expect(Object.isFrozen(admitted.registry)).toBe(true);
    expect(Object.isFrozen(admitted.registry.reviews)).toBe(true);
    expect(Object.isFrozen(admitted.registry.reviews[0]!.sources)).toBe(true);
    expect(admitted.digest).toBe(reviewedRegistryEnvelopeDigest(
      "safety-score-v9.lender-collateral-classes.v1", "payload", admitted.registry,
    ));
    const changed = structuredClone(registryJson);
    changed.reviews[0]!.reviewer = "Different documented reviewer";
    expect(reviewedRegistryEnvelopeDigest(
      "safety-score-v9.lender-collateral-classes.v1", "payload", changed,
    )).not.toBe(admitted.digest);
  });

  it.each([
    { label: "missing reviewer", update: { reviewer: undefined } },
    { label: "blank reviewer", update: { reviewer: "" } },
    { label: "missing sources", update: { sources: [] } },
    { label: "invalid source URL", update: { sources: [{ label: "Primary source", url: "not-a-url" }] } },
    { label: "invalid evidence date", update: { reviewedAt: "2026-02-30" } },
    { label: "noncanonical address", update: { address: "0x2F2A2543B76A4166549F7AAB2E75BEF0AEFC5B0F" } },
    { label: "noncanonical chain", update: { chain: "Arbitrum" } },
    { label: "unknown class", update: { class: "unreviewed-equity" } },
    { label: "unrecognized row field", update: { fallbackQuality: 100 } },
  ])("rejects $label instead of granting fallback credit", ({ update }) => {
    const changed = { ...registryJson, reviews: [{ ...registryJson.reviews[0]!, ...update }, ...registryJson.reviews.slice(1)] };
    expect(LenderCollateralClassesRegistrySchema.safeParse(changed).success).toBe(false);
  });

  it("rejects duplicate, unordered, empty and unversioned registry envelopes", () => {
    expect(LenderCollateralClassesRegistrySchema.safeParse({
      ...registryJson, reviews: [registryJson.reviews[0]!, ...registryJson.reviews],
    }).success).toBe(false);
    expect(LenderCollateralClassesRegistrySchema.safeParse({
      ...registryJson, reviews: [...registryJson.reviews].reverse(),
    }).success).toBe(false);
    expect(LenderCollateralClassesRegistrySchema.safeParse({ ...registryJson, reviews: [] }).success).toBe(false);
    expect(LenderCollateralClassesRegistrySchema.safeParse({ ...registryJson, schemaVersion: 2 }).success).toBe(false);
    expect(LenderCollateralClassesRegistrySchema.safeParse({ ...registryJson, registryId: "other-registry" }).success).toBe(false);
    expect(LenderCollateralClassesRegistrySchema.safeParse({ ...registryJson, fallbackQuality: 100 }).success).toBe(false);
  });
});
