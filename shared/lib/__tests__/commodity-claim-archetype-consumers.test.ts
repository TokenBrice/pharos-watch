import { describe, expect, it } from "vitest";
import { ACTIVE_META_BY_ID } from "../stablecoins/registry";
import { structuralClass } from "../depeg-resolver/strata";
import { deriveStablecoinVerdict } from "../stablecoin-verdict";

/**
 * `mechanismArchetype` is read by more than the Safety Score backing evaluator,
 * and the v9.14 migration proved it the hard way: adding the enum value in
 * phase 1 was guarded by a zero-coin assertion, so no consumer set was ever
 * exercised with a real `commodity-claim` asset. Moving 15 coins onto it
 * surfaced two consumers that had been silently excluding them —
 * `ORACLE_FREE_ARCHETYPES` (which demanded an oracle profile no metal claim can
 * have) and `ROBUST_ARCHETYPES` (which would have flipped every gold and silver
 * token to a fragile depeg stratum on a rename).
 *
 * This suite pins the membership DECISION for each consumer, including the
 * deliberate exclusions, so the next archetype addition has a checklist instead
 * of a discovery process.
 */
describe("commodity-claim archetype consumers", () => {
  const migrated = [...ACTIVE_META_BY_ID.values()].filter(
    (meta) => meta.mechanismArchetype === "commodity-claim",
  );

  it("covers the migrated set", () => {
    expect(migrated.length).toBe(13);
    expect(migrated.every((meta) => meta.flags?.pegCurrency === "GOLD" || meta.flags?.pegCurrency === "SILVER")).toBe(
      true,
    );
  });

  it("is a robust depeg stratum: allocated metal is real collateral", () => {
    for (const meta of migrated) {
      expect(
        structuralClass({
          id: meta.id,
          symbol: meta.symbol,
          name: meta.name,
          pegCurrency: meta.flags?.pegCurrency ?? "GOLD",
          governance: meta.flags?.governance ?? "centralized",
          mechanismArchetype: meta.mechanismArchetype,
        }),
        meta.id,
      ).toBe("robust");
    }
  });

  it("is deliberately NOT an institutional-default verdict", () => {
    // "Institutional Default" describes the default institutional *dollar*.
    // A metal claim at investment grade renders no derived label, which is the
    // same treatment tbill, cdp, and rwa-credit-fund assets already get — the
    // pill's own contract calls that honest emptiness. Recorded as a decision,
    // not an oversight.
    expect(
      deriveStablecoinVerdict({
        status: "active",
        reportCardGrade: "A",
        pegScore: 99,
        dewsBand: "CALM",
        mechanismArchetype: "commodity-claim",
        governance: "centralized",
        yieldBearing: false,
        activeDepeg: false,
      }).archetype,
    ).toBe("uncategorized");
    // Same inputs on fiat-cash still resolve, so the exclusion is the archetype
    // and not a broken fixture.
    expect(
      deriveStablecoinVerdict({
        status: "active",
        reportCardGrade: "A",
        pegScore: 99,
        dewsBand: "CALM",
        mechanismArchetype: "fiat-cash",
        governance: "centralized",
        yieldBearing: false,
        activeDepeg: false,
      }).archetype,
    ).toBe("institutional-default");
  });
});
