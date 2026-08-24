import { describe, expect, it } from "vitest";
import type { V9EconomicControlReviewV2 } from "@shared/types/safety-score-v9-facts";
import type { V9ApplicableWrapperLocalFacts } from "@shared/types/safety-score-v9-wrapper";
import { resolveV9WrapperParentLimit } from "@shared/lib/safety-score-v9/wrapper-risk";
import {
  getSafetyScoreV9ReviewedIncidents,
  routeSafetyScoreV9ControlIncidents,
  routeSafetyScoreV9WrapperIncidents,
} from "../safety-score-v9-extension-incidents";
import type { ControlOverlay } from "../safety-score-v9-extension-shared";

const CLOCK_SEC = Date.parse("2026-08-24T23:59:59.000Z") / 1_000;

function mintReview(controlKey: string | null): V9EconomicControlReviewV2["mint"] {
  return {
    status: {
      applicability: { state: "required", policyRuleId: "fixture", rationale: null, gapId: null },
      observationState: "known",
      evidenceRefIds: ["fixture-evidence"],
      gapIds: [],
    },
    controlKey,
    reconciliation: "not-applicable",
    supervision: "none",
    latestResolvedIncidentAtSec: null,
    upgrade: { state: "immutable", controlKey: null },
  };
}

function control(controlKey: string): ControlOverlay {
  return {
    controlKey,
    deploymentKey: "asset:fixture",
    controlKind: "mint",
    scope: "global",
    capabilities: ["mint"],
    capSemantics: { kind: "bounded", bound: { amount: 1, unit: "supply-fraction" } },
    claimImpairment: "bounded",
    economicLossScope: "global-claim",
    authority: { authorityKey: "authority:fixture", model: "contract", threshold: null },
    delaySec: null,
    materialSupplyShare: null,
    keyCustody: "unknown",
    modulesOrGuards: "not-applicable",
    incidentState: "none",
    failureDomains: [{ kind: "mint-control", key: "fixture" }],
  };
}

function wrapperFacts(): V9ApplicableWrapperLocalFacts {
  const dimension = (assessment: "none" | "moderate") => ({
    disposition: "reviewed" as const,
    assessment,
    signals: ["fixture-review"],
    evidenceRefIds: ["fixture-evidence"],
  });
  return {
    schemaVersion: 1,
    applicability: "wrapper",
    form: "native-staked",
    formDisposition: "reviewed",
    formSignals: ["wrapper-form:native-staked"],
    formEvidenceRefIds: ["fixture-evidence"],
    facts: {
      contractMutability: dimension("none"),
      custodyEscrow: dimension("none"),
      strategyComplexity: dimension("none"),
      leverage: dimension("none"),
      rehypothecationCorrelation: dimension("none"),
      shareAccountingNavOracle: dimension("moderate"),
      withdrawalTerms: dimension("none"),
      measuredUnwind: dimension("none"),
      lossAbsorptionEmergencyControls: dimension("none"),
    },
    riskTransfer: {
      disposition: "not-applicable",
      mechanism: "none",
      maximumParentLossAbsorptionPoints: 0,
      signals: ["no-risk-transfer"],
      evidenceRefIds: [],
    },
  };
}

describe("Safety Score v9 domain-routed incident adapter", () => {
  it("curates only the three owner-approved assets", () => {
    expect(getSafetyScoreV9ReviewedIncidents("usdp-parallel", CLOCK_SEC)).toHaveLength(1);
    expect(getSafetyScoreV9ReviewedIncidents("zsd-zephyr-protocol", CLOCK_SEC)).toHaveLength(1);
    expect(getSafetyScoreV9ReviewedIncidents("sdola-inverse-finance", CLOCK_SEC)).toHaveLength(1);
    expect(getSafetyScoreV9ReviewedIncidents("usx-solstice", CLOCK_SEC)).toEqual([]);
    expect(getSafetyScoreV9ReviewedIncidents("usdf-falcon", CLOCK_SEC)).toEqual([]);
  });

  it("routes USDp and ZSD into resolved control history without an active blocker", () => {
    const usdp = routeSafetyScoreV9ControlIncidents(
      [control("mint:usdp")],
      mintReview("mint:usdp"),
      getSafetyScoreV9ReviewedIncidents("usdp-parallel", CLOCK_SEC),
    );
    expect(usdp.controls[0]!.incidentState).toBe("resolved");
    expect(usdp.mintReview.latestResolvedIncidentAtSec).toBe(
      Date.parse("2026-07-02T00:00:00.000Z") / 1_000,
    );

    const zsd = routeSafetyScoreV9ControlIncidents(
      [control("mint:zsd-consensus")],
      mintReview(null),
      getSafetyScoreV9ReviewedIncidents("zsd-zephyr-protocol", CLOCK_SEC),
    );
    expect(zsd.controls[0]!.incidentState).toBe("resolved");
    expect(zsd.mintReview.latestResolvedIncidentAtSec).toBe(
      Date.parse("2025-08-27T00:00:00.000Z") / 1_000,
    );
  });

  it("routes sDOLA once into wrapper facts and preserves integration-only scope", () => {
    const incidents = getSafetyScoreV9ReviewedIncidents("sdola-inverse-finance", CLOCK_SEC);
    const routed = routeSafetyScoreV9WrapperIncidents(wrapperFacts(), incidents, {
      shareAccountingNavOracle: ["incident-source"],
      measuredUnwind: ["incident-source"],
    });
    if (routed.applicability !== "wrapper") throw new Error("Expected wrapper facts");
    expect(routed.facts.shareAccountingNavOracle.incidentPostures).toMatchObject([
      {
        incidentId: "sdola-2026-llamalend-donation-oracle",
        scope: { kind: "integration-only", integrationKey: "llamalend-sdola-long2" },
        assessment: "high",
      },
    ]);
    expect(routed.facts.measuredUnwind.incidentPostures?.[0]).toMatchObject({
      scope: { kind: "integration-only" },
      assessment: "high",
    });

    const routedTwice = routeSafetyScoreV9WrapperIncidents(routed, incidents, {
      shareAccountingNavOracle: ["incident-source"],
      measuredUnwind: ["incident-source"],
    });
    expect(routedTwice).toEqual(routed);

    const result = resolveV9WrapperParentLimit({
      parentScore: 55.8,
      localFacts: routed,
      fallbackDiscounts: { pure: 3, "native-staked": 5, "strategy-vault": 10 },
    });
    expect(result.adjustments.find((fact) => fact.factKey === "shareAccountingNavOracle")).toMatchObject({
      assessment: "high",
      discountPoints: 1.4,
    });
    expect(result.adjustments.find((fact) => fact.factKey === "measuredUnwind")).toMatchObject({
      assessment: "none",
      discountPoints: 0,
    });
    expect(result.limit).toBe(54.4);
  });

  it("does not route a wrapper-local incident through control", () => {
    const baselineControl = control("mint:fixture");
    const routed = routeSafetyScoreV9ControlIncidents(
      [baselineControl],
      mintReview(baselineControl.controlKey),
      getSafetyScoreV9ReviewedIncidents("sdola-inverse-finance", CLOCK_SEC),
    );
    expect(routed.controls).toEqual([baselineControl]);
    expect(routed.mintReview.latestResolvedIncidentAtSec).toBeNull();
  });
});
