import { describe, expect, it } from "vitest";
import type { RedemptionBackstopEntry, RedemptionBusinessDayTerms } from "@shared/types/redemption";
import type { ReportCardsFixedInput } from "../report-cards-fixed-input";
import { buildSafetyScoreV9RouteReviews } from "../safety-score-v9/extension-routes";
import { makeSupplyFullRedemption } from "./redemption-backstops-store.test-support";
import { withRedemptionBackstopConfig } from "./safety-score-v9-extension-routes.test-support";
import { resolveReviewedRedemptionSettlementDelay } from "@shared/lib/redemption-backstop-configs/settlement";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import { ReserveBoundedFactSchema, type V9ReserveBoundedFact } from "@shared/types/reserve-bounded-facts";
import rawBounds from "@shared/data/safety-score-v9/reserve-bound-facts-v1.json";
import { resolveV9ReserveFactorBounds } from "@shared/lib/safety-score-v9/reserve-bound-facts";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { exposure, knownStatus } from "@shared/lib/__tests__/safety-score-v9-backing.test-support";
import { makeV9FixedInput } from "../../test-helpers/v9-fixed-input";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9/extension";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { evaluateV9ReserveExposures } from "@shared/lib/safety-score-v9/backing";
import type { ReserveSlice } from "@shared/types/reserves";

const clock = Date.parse("2026-10-05T12:00:00Z") / 1000;
const businessDayTerms: RedemptionBusinessDayTerms = {
  businessDays: 1, calendarId: "us-federal-reserve", cutoff: { time: "16:00", timezone: "America/New_York" },
  assurance: "binding-guarantee", conditional: false, conditions: [], startEvent: "Eligible received request",
};
const reviewed = { businessDayTerms, reviewedAt: "2026-10-05", docs: [{ label: "Binding settlement terms", url: "https://example.com/terms", supports: ["settlement" as const] }] };
function fixed(row: RedemptionBackstopEntry, clockSec = clock): ReportCardsFixedInput {
  return { clockSec, dexGenerationId: "dex-fixture", redemptionGenerationId: "redemption-fixture", dexLiqMap: {},
    redemptionBackstopMap: { [row.stablecoinId]: row }, pegDataById: {} } as unknown as ReportCardsFixedInput;
}

describe("business-calendar settlement consumers", () => {
  it.each(["route-only", "processing-gap", "future", "stale"] as const)(
    "does not let a %s scalar review reuse the producer's persisted favorable SLA", (scenario) => {
      const scalar = { settlementModel: "days" as const, settlementDelaySec: 86400,
        reviewedAt: scenario === "future" ? "2026-10-06" : scenario === "stale" ? "2025-01-01" : "2026-10-05",
        docs: [{ label: "Exact endpoint terms", url: "https://example.com/terms",
          supports: scenario === "route-only" ? ["route" as const] : ["settlement" as const] }],
        ...(scenario === "processing-gap" ? { scoringDisposition: "bounded-terms-gap" as const,
          missingScoringFields: ["settlement" as const], rationale: "Processing starts after unbounded checks; completion is not bounded." } : {}),
      };
      const row = makeSupplyFullRedemption({ stablecoinId: "usdc-circle", settlementModel: "days", settlementDelaySec: 86400 });
      withRedemptionBackstopConfig(row.stablecoinId, { settlementModel: "days", v9RouteReviewTerms: scalar }, () => {
        expect(resolveReviewedRedemptionSettlementDelay(scalar, clock)).toBeUndefined();
        expect(buildSafetyScoreV9RouteReviews(fixed(row), row.stablecoinId)[0]).toMatchObject({
          settlementModel: "bounded-delay", settlementSlaSec: null, settlementHorizonSec: 14 * 86400,
        });
      });
    },
  );
  it("admits a current scalar for a sourced completed exact endpoint", () => {
    expect(resolveReviewedRedemptionSettlementDelay({
      settlementDelaySec: 259200, reviewedAt: "2026-10-05",
      docs: [{ label: "Funded claim after maturity", url: "https://example.com/funded-claim", supports: ["settlement"] }],
    }, clock)).toBe(259200);
  });
  it.each(["eutbl-spiko", "ustbl-spiko", "safo-spiko-usd", "eursafo-spiko"])(
    "keeps %s issuer zero fee without inventing an unconditional cash-completion scalar", (assetId) => {
      const config = getRedemptionBackstopConfig(assetId)!;
      const row = makeSupplyFullRedemption({ stablecoinId: assetId, settlementModel: "same-day", settlementDelaySec: 86400, feeBps: 0 });
      const clockSec = Date.parse("2026-10-07T12:00:00Z") / 1000;
      expect(config.costModel).toMatchObject({ kind: "fee-bps", feeBps: 0 });
      expect(config.v9RouteReviewTerms!.missingScoringFields).toContain("settlement");
      expect(buildSafetyScoreV9RouteReviews(fixed(row, clockSec), assetId)[0]).toMatchObject({
        coverageClass: "diagnostic", settlementModel: "bounded-delay", settlementSlaSec: null,
      });
    },
  );
  it("retains APY's reviewed funded-claim maturity rather than treating every queue as unbounded", () => {
    const assetId = "apyusd-apyx";
    const row = makeSupplyFullRedemption({ stablecoinId: assetId, routeFamily: "queue-redeem", settlementModel: "queued" });
    const clockSec = Date.parse("2026-10-07T12:00:00Z") / 1000;
    expect(buildSafetyScoreV9RouteReviews(fixed(row, clockSec), assetId)[0])
      .toMatchObject({ settlementModel: "queued", settlementSlaSec: 259200 });
  });
  it.each(["hbd-hive", "syusd-aegis", "usp-pikudao", "avusd-avant", "savusd-avant", "hbusdt-hyperbeat", "usn-noon",
    "ustbl-spiko", "safo-spiko-usd", "uktbl-spiko", "gbpsafo-spiko", "eutbl-spiko", "eursafo-spiko", "spkcc-spiko", "eurspkcc-spiko"])(
    "does not promote %s processing/cooldown/conditional terms into completed settlement", (assetId) => {
      const config = getRedemptionBackstopConfig(assetId)!;
      const row = makeSupplyFullRedemption({ stablecoinId: assetId, routeFamily: config.routeFamily,
        settlementModel: config.settlementModel });
      expect(buildSafetyScoreV9RouteReviews(fixed(row, Date.parse("2026-10-07T12:00:00Z") / 1000), assetId)[0])
        .toMatchObject({ coverageClass: "diagnostic", settlementSlaSec: null });
    },
  );
  it("projects a current binding guarantee using its worst reviewed annual holiday walk", () => {
    const row = makeSupplyFullRedemption({ stablecoinId: "usdc-circle", settlementModel: "days", settlementDelaySec: undefined });
    withRedemptionBackstopConfig(row.stablecoinId, { settlementModel: "days", v9RouteReviewTerms: reviewed }, () => {
      expect(resolveReviewedRedemptionSettlementDelay(reviewed, clock)).toBe(5 * 86400 + 8 * 3600);
      expect(buildSafetyScoreV9RouteReviews(fixed(row), row.stablecoinId)[0]).toMatchObject({
        settlementModel: "bounded-delay", settlementSlaSec: 5 * 86400 + 8 * 3600, settlementHorizonSec: 5 * 86400 + 8 * 3600,
      });
      expect(row.settlementDelaySec).toBeUndefined();
    });
  });
  it.each(["target", "conditional", "coverage", "stale"] as const)("fails closed for %s terms without leaking a captured scalar SLA", (scenario) => {
    const row = makeSupplyFullRedemption({ stablecoinId: "usdc-circle", settlementModel: "days", settlementDelaySec: 86400 });
    const terms = { ...reviewed, businessDayTerms: {
      ...businessDayTerms,
      ...(scenario === "target" ? { assurance: "target" as const } : {}),
      ...(scenario === "conditional" ? { conditional: true, conditions: ["Bank/liquidation gate"] } : {}),
      ...(scenario === "coverage" ? { businessDays: 10 } : {}),
    } };
    const clockSec = scenario === "stale" ? Date.parse("2027-02-01T12:00:00Z") / 1000
      : scenario === "coverage" ? Date.parse("2026-12-30T12:00:00Z") / 1000 : clock;
    withRedemptionBackstopConfig(row.stablecoinId, { settlementModel: "days", v9RouteReviewTerms: terms }, () => {
      expect(buildSafetyScoreV9RouteReviews(fixed(row, clockSec), row.stablecoinId)[0]).toMatchObject({
        settlementModel: "bounded-delay", settlementSlaSec: null, settlementHorizonSec: 14 * 86400,
      });
    });
  });
  it("preserves BRLV's conservative fourteen-day horizon instead of substituting T+3", () => {
    const row = makeSupplyFullRedemption({ stablecoinId: "brlv-crown", settlementModel: "days", settlementDelaySec: undefined });
    expect(buildSafetyScoreV9RouteReviews(fixed(row), row.stablecoinId)[0]).toMatchObject({ settlementSlaSec: null, settlementHorizonSec: 14 * 86400 });
  });
  it("scores neither PATH's conditional treasury window nor its business-hours cash window", () => {
    for (const payload of rawBounds.assets["pathusd-bridge"]) {
      const fact = ReserveBoundedFactSchema.parse(payload);
      if (fact.scope.kind !== "exposure") throw new Error("Expected exposure scope");
      const row = { ...exposure({ key: fact.scope.exposureKey, weight: 1, assetClass: "treasury-bill" }), liquidityHorizon: "unknown" as const };
      const compiled: V9ReserveBoundedFact = { fact, status: knownStatus("evidence:conditional-terms"), sourceGenerationId: "fixture", freshnessMaxAgeSec: 86400, rejectionReason: null };
      const result = resolveV9ReserveFactorBounds(row, [compiled], V9_CANDIDATE_POLICY_V1.policy.semantic.backing, clock, { liquidity: 55, maturity: 48 });
      expect(result).toMatchObject({ liquidity: 55, liquidityCoveredShare: 0, liquidityCoveredQuality: null, evidenceRefIds: [], contradiction: false });
    }
  });
  it("compiles PATH's reviewed conditional windows without the prior cause/disposition quarantine or liquidity closure", () => {
    const assetId = "pathusd-bridge";
    const now = Date.parse("2026-10-06T12:00:00Z") / 1000;
    const rows: ReserveSlice[] = [
      { name: "Treasury", pct: 90, risk: "very-low", assetClass: "treasury-bill", liquidityHorizon: "unknown", sourceKey: "reserve:1c4dd3588a3d275a0d87b130" },
      { name: "Cash", pct: 10, risk: "very-low", assetClass: "cash", liquidityHorizon: "unknown", sourceKey: "reserve:ad8f3089c8d58cf408e0be9a" },
    ];
    const input = makeV9FixedInput({ assetId, clockSec: now, reserves: rows });
    const meta = { ...ACTIVE_META_BY_ID.get(assetId)!, mintAuthority: undefined };
    const extension = buildSafetyScoreV9BaselineExtension(input, { metaById: new Map([[assetId, meta]]) });
    const withBounds = compileSafetyScoreV9FactSetFromFixedInput(input, extension).assets[0]!;
    const withoutBounds = compileSafetyScoreV9FactSetFromFixedInput(input, {
      ...extension, assets: extension.assets.map((entry) => ({ ...entry, reserveBoundFacts: [] })),
    }).assets[0]!;
    expect(withBounds.gaps.some((gap) => gap.path.kind === "local-component" && gap.path.componentKey === "asset-compilation")).toBe(false);
    expect(withBounds.reserveBoundFacts).toHaveLength(2);
    expect(withBounds.reserveBoundFacts!.every((bound) => bound.status.observationState === "known" && bound.rejectionReason === null)).toBe(true);
    const liquidityGaps = withBounds.gaps.filter((gap) => gap.causeScope?.requiredDatum === "liquidityHorizon");
    expect(liquidityGaps).toHaveLength(2);
    expect(liquidityGaps.every((gap) => gap.causeProof?.cause === "U")).toBe(true);
    const before = evaluateV9ReserveExposures({ ...withoutBounds, resolvedUpstreamExposures: [], asOfSec: now }, V9_CANDIDATE_POLICY_V1);
    const after = evaluateV9ReserveExposures({ ...withBounds, resolvedUpstreamExposures: [], asOfSec: now }, V9_CANDIDATE_POLICY_V1);
    expect(after.score).toBe(before.score);
  });
  it("admits only a guaranteed calendar window in the reserve factor path, not a banking-hours target", () => {
    const payload = rawBounds.assets["pathusd-bridge"][0]!;
    const fact = ReserveBoundedFactSchema.parse({ ...payload, businessDayTerms });
    if (fact.scope.kind !== "exposure") throw new Error("Expected exposure scope");
    const row = { ...exposure({ key: fact.scope.exposureKey, weight: 1, assetClass: "treasury-bill" }), liquidityHorizon: "unknown" as const };
    const compiled: V9ReserveBoundedFact = { fact, status: knownStatus("evidence:guarantee"), sourceGenerationId: "fixture", freshnessMaxAgeSec: 86400, rejectionReason: null };
    const result = resolveV9ReserveFactorBounds(row, [compiled], V9_CANDIDATE_POLICY_V1.policy.semantic.backing, clock, { liquidity: 55, maturity: 48 });
    expect(result).toMatchObject({ liquidity: V9_CANDIDATE_POLICY_V1.policy.semantic.backing.reserve.liquidityQuality["seven-days"], liquidityCoveredShare: 1, evidenceRefIds: ["evidence:guarantee"] });
  });
});
