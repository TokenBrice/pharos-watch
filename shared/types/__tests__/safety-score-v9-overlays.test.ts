import { describe, expect, it } from "vitest";
import mechanismOverlays from "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
import operationalResilienceOverlays from "@shared/data/safety-score-v9/operational-resilience-overlays-v1.json";
import transferOverlays from "@shared/data/safety-score-v9/transfer-review-overlays-v1.json";
import stablecoinsGenerated from "@shared/data/stablecoins/coins.generated.json";
import type { StablecoinMeta } from "../core";
import { SafetyScoreV9MechanismReviewOverlayFileSchema } from "../safety-score-v9-mechanism-overlays";
import { SafetyScoreV9OperationalResilienceOverlayFileSchema } from "../safety-score-v9-operational-resilience-overlays";
import { SafetyScoreV9ReviewedTransferFileSchema } from "../safety-score-v9-transfer-overlays";
import { V1005CompiledVotingControlSchema, V1005IssuanceProcessSchema } from "../safety-score-v9-facts";
import { makeCompiledVotingControl, makeOperationalIssuanceProcess } from "../../lib/__tests__/safety-score-v9-fixtures.test-support";

// The one compiler fallback able to grade a fiat-cash/commodity-claim
// assuranceAndReconciliation or tbill lossRecoveryDesign component `known`
// rather than bounded-unknown is `assuranceFact()`
// (worker/src/lib/safety-score-v9/extension-mechanism.ts), driven solely by
// complete, date-qualified `proofOfReserves.latestReport` observations. `expandOverlayReview` gives any curated
// component entry priority over that fallback, so a curated `unavailable`
// row on that exact field silently demotes a known fact to bounded-unknown
// (ODR-C2). This mirrors the guard documented in
// docs/process/mechanism-overlay-evidence-standard.md.
const ASSURANCE_COMPONENT_BY_ARCHETYPE: Readonly<Record<string, string>> = {
  "fiat-cash": "assuranceAndReconciliation",
  "commodity-claim": "assuranceAndReconciliation",
  tbill: "lossRecoveryDesign",
};

const mechanismFixture = { schemaVersion: 1, note: "Fixture", overlays: [mechanismOverlays.overlays[0]] };
const transferFixture = { schemaVersion: 1, note: "Fixture", reviews: [transferOverlays.reviews[0]] };
const operationalFixture = { schemaVersion: 1, note: "Fixture", overlays: [operationalResilienceOverlays.overlays[0]] };

describe("shared Safety Score V9 overlay boundaries", () => {
  it("requires conserved source measurements rather than trusting complete compiled process labels", () => {
    const positive = makeOperationalIssuanceProcess();
    expect(V1005IssuanceProcessSchema.safeParse(positive).success).toBe(true);
    for (const changed of [
      { unknownMemberCount: 1 },
      { formulaPathCount: 2 },
      { fundedKeeperRecurringPathCount: 2 },
      { fundedKeeperRecurringPathCount: 0, minKeeperRecurringIntervalSec: null },
      { maxKeeperRepeatRewardSupplyPpmPer86400Sec: 0 },
      { minOperationalExerciseDelaySec: null },
      { votingControl: makeCompiledVotingControl({ qualified: false }) },
    ]) expect(V1005IssuanceProcessSchema.safeParse({ ...positive, ...changed }).success).toBe(false);
    const zero = makeOperationalIssuanceProcess({ fundedKeeperRecurringPathCount: 0, minKeeperRecurringIntervalSec: null,
      maxKeeperRepeatRewardSupplyPpmPer86400Sec: 0, keeperSupplyScreenBasis: { nativeSupplyRaw: "1000000", maxFixedRewardRaw: "10", maxRepeatRewardRawPer86400Sec: "0", nativeUnits: "native" } });
    expect(V1005IssuanceProcessSchema.safeParse(zero).success).toBe(true);
  });

  it("rejects unreconciled voting power even when the compiled label claims qualification", () => {
    const positive = makeCompiledVotingControl();
    expect(V1005CompiledVotingControlSchema.safeParse(positive).success).toBe(true);
    const changed = structuredClone(positive);
    changed.censusReconciliations[0]!.accountedPowerRaw = "99";
    expect(V1005CompiledVotingControlSchema.safeParse(changed).success).toBe(false);
    expect(V1005CompiledVotingControlSchema.safeParse({ ...positive, otherHolderVoteOperatorControllerIds: ["caster"] }).success).toBe(false);
  });

  it.each(["ucits-trs-fund", "shared-reserve", "protocol-position"] as const)(
    "requires charged unknowns rather than applicability or synthetic-metric relief for %s",
    (archetype) => {
      const sourceUrl = "https://example.com/current-disclosure";
      const row = {
        assetId: "fixture-family", archetype, reviewedAt: "2026-10-01",
        sources: [{ label: "Current exact-token disclosures", url: sourceUrl }],
        notes: "Exact current identity; complete recovery information not published.", metrics: {},
        components: { defaultRecovery: { applicability: "unavailable", rationale: "Default priority and funded recovery not disclosed in searched terms.", sourceUrl } },
      };
      const fixture = { schemaVersion: 1, note: "Native-family boundary fixture", overlays: [row] };
      expect(SafetyScoreV9MechanismReviewOverlayFileSchema.safeParse(fixture).success).toBe(true);
      for (const invalid of [
        { ...row, components: { defaultRecovery: { ...row.components.defaultRecovery, applicability: "not-applicable" } } },
        { ...row, metrics: { exogenousBackingShare: 1 } },
        { ...row, analogousMetrics: { reserveSurplusPct: 100 } },
        { ...row, components: { defaultRecovery: { ...row.components.defaultRecovery, sourceUrl: "https://example.com/unlisted" } } },
      ]) {
        expect(SafetyScoreV9MechanismReviewOverlayFileSchema.safeParse({ ...fixture, overlays: [invalid] }).success).toBe(false);
      }
    },
  );

  it("validates every checked-in overlay asset through the shared schemas", () => {
    expect(() => SafetyScoreV9MechanismReviewOverlayFileSchema.parse(mechanismOverlays)).not.toThrow();
    expect(() => SafetyScoreV9ReviewedTransferFileSchema.parse(transferOverlays)).not.toThrow();
    expect(() =>
      SafetyScoreV9OperationalResilienceOverlayFileSchema.parse(operationalResilienceOverlays),
    ).not.toThrow();
  });

  it("rejects a malformed mechanism row instead of allowing a frontend cast", () => {
    expect(SafetyScoreV9MechanismReviewOverlayFileSchema.safeParse(mechanismFixture).success).toBe(true);
    const malformed = { ...mechanismFixture, overlays: [{ ...mechanismFixture.overlays[0], unexpectedPublishedField: true }] };
    expect(SafetyScoreV9MechanismReviewOverlayFileSchema.safeParse(malformed).success).toBe(false);
    expect(SafetyScoreV9MechanismReviewOverlayFileSchema.safeParse({ ...malformed, overlays: [{ ...mechanismOverlays.overlays[0], reviewedAt: "2026-02-31" }] }).success).toBe(false);
  });

  it("rejects transfer rows without a canonical deployment", () => {
    expect(SafetyScoreV9ReviewedTransferFileSchema.safeParse(transferFixture).success).toBe(true);
    const malformed = structuredClone(transferFixture) as Record<string, unknown> & {
      reviews: Array<{ deployments: Array<{ scope: string }> }>;
    };
    malformed.reviews[0]!.deployments.forEach((deployment) => {
      deployment.scope = "additional";
    });
    expect(SafetyScoreV9ReviewedTransferFileSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects operational-resilience evidence references absent from sources", () => {
    expect(SafetyScoreV9OperationalResilienceOverlayFileSchema.safeParse(operationalFixture).success).toBe(true);
    const malformed = structuredClone(operationalFixture) as Record<string, unknown> & {
      overlays: Array<{ eligibility: { liveHistory: { sourceIds: string[] } } }>;
    };
    malformed.overlays[0]!.eligibility.liveHistory.sourceIds = ["missing-source"];
    expect(SafetyScoreV9OperationalResilienceOverlayFileSchema.safeParse(malformed).success).toBe(false);
  });

  it.each([
    [SafetyScoreV9MechanismReviewOverlayFileSchema, { ...mechanismFixture, overlays: [mechanismFixture.overlays[0], mechanismFixture.overlays[0]] }, "overlays"],
    [SafetyScoreV9OperationalResilienceOverlayFileSchema, { ...operationalFixture, overlays: [operationalFixture.overlays[0], operationalFixture.overlays[0]] }, "overlays"],
    [SafetyScoreV9ReviewedTransferFileSchema, { ...transferFixture, reviews: [transferFixture.reviews[0], transferFixture.reviews[0]] }, "reviews"],
  ])("rejects duplicate asset identities at the collection path", (schema, input, path) => {
    const result = schema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(expect.objectContaining({ code: "custom", path: [path] }));
    }
  });

  it("never shadows a complete canonical assurance report with unavailable curation", () => {
    const assetIdsWithAssuranceReport = new Set(
      (stablecoinsGenerated as Array<Pick<StablecoinMeta, "id" | "proofOfReserves">>)
        .filter((coin) => {
          const report = coin.proofOfReserves?.latestReport;
          return report?.periodEnd != null &&
            report.publishedAt != null &&
            report.assuranceMethod !== "unknown" &&
            report.scope !== "unknown";
        })
        .map((coin) => coin.id),
    );

    const overlays = (mechanismOverlays as { overlays: Array<Record<string, unknown>> }).overlays;
    const violations = overlays.flatMap((overlay) => {
      const archetype = overlay.archetype as string;
      const assuranceField = ASSURANCE_COMPONENT_BY_ARCHETYPE[archetype];
      if (!assuranceField) return [];
      const components = overlay.components as Record<string, { applicability?: string }> | undefined;
      const component = components?.[assuranceField];
      if (component?.applicability !== "unavailable") return [];
      if (!assetIdsWithAssuranceReport.has(overlay.assetId as string)) return [];
      return [`${overlay.assetId}.${assuranceField}`];
    });

    expect(violations).toEqual([]);
  });
});
