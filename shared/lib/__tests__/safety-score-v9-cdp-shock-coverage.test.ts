import { describe, expect, it } from "vitest";
import type { V9FactStatusV2 } from "../../types/safety-score-v9-facts";
import {
  V9CdpStressCoverageFactSchema,
  type V9CdpMechanismRiskReview,
  type V9CdpStressCoverageFact,
} from "../../types/safety-score-v9-backing";
import type { V9BackingAssetInput, V9MechanismFactV1 } from "../safety-score-v9/backing";
import { evaluateV9CdpBacking, selectV9CdpLiquidationCapacity } from "../safety-score-v9/archetypes/cdp";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

const AS_OF_SEC = 1_000_000;

function knownStatus(id: string): V9FactStatusV2 {
  return {
    applicability: { state: "required", policyRuleId: "mechanism.required", rationale: null, gapId: null },
    observationState: "known",
    evidenceRefIds: [`evidence:${id}`],
    gapIds: [],
  };
}

function mechanismFact(id: string): V9MechanismFactV1 {
  return { status: knownStatus(id), quality: "adequate", failureDomains: [] };
}

function review(
  args: { collateralizationRatio?: number; liquidationCapacityRatio?: number } = {},
): V9CdpMechanismRiskReview {
  return {
    archetype: "cdp",
    collateralizationRatio: args.collateralizationRatio ?? 1.5,
    liquidationCapacityRatio: args.liquidationCapacityRatio ?? 0.25,
    metricApplicability: {
      collateralizationRatio: { state: "measured" },
      liquidationCapacityRatio: { state: "measured" },
    },
    collateralizationParameters: mechanismFact("collateralization"),
    liquidationMechanics: mechanismFact("legacy-liquidation"),
    backstop: mechanismFact("backstop"),
    branchIsolation: mechanismFact("branch"),
    shutdownAndBadDebt: mechanismFact("shutdown"),
    structuralRedemption: mechanismFact("redemption"),
  };
}

function stressFact(ratio: number, observedAtSec = AS_OF_SEC): V9CdpStressCoverageFact {
  const liquidatable = "1000";
  const offset = String(Math.round(ratio * 1000));
  return V9CdpStressCoverageFactSchema.parse({
    family: "test-shock-v1",
    applicability: "measured",
    failureReason: null,
    complete: true,
    blockers: [],
    exactReplayPassed: true,
    replayVerification: {
      attestationPath: "shared/data/safety-score-v9/shock-coverage-replay-attestations-v1.json",
      attestedAt: "2026-07-17",
      toolPath: "scripts/maintenance/measure-cdp-shock-coverage.ts",
      toolVersion: "1",
      mode: "offline-byte-identical",
      callsConsumed: 1,
      codePinsConsumed: 1,
    },
    source: {
      journalPath: "shared/data/safety-score-v9/mechanism-measurements/test/shock-coverage.json",
      journalSha256: "1".repeat(64),
      block: {
        number: 1,
        hash: `0x${"2".repeat(64)}`,
        timestampUnix: observedAtSec,
        timestampIso: new Date(observedAtSec * 1_000).toISOString(),
      },
      sourcePin: {
        repository: "https://example.com/protocol",
        commit: "3".repeat(40),
        liquidationContractPath: "contracts/TroveManager.sol",
      },
    },
    shockPolicy: {
      scoreShockFractionPpm: 500_000,
      sensitivityShockFractionsPpm: [400_000, 500_000, 600_000, 750_000],
      debtReconciliationTolerancePpm: 1_000,
    },
    stressShockFraction: 0.5,
    stressLiquidatableDebt: liquidatable,
    stressPoolOffsetDebt: offset,
    stressLiquidationCoverageRatio: ratio,
    branchContributions: [
      {
        branchIndex: 0,
        stressLiquidatableDebt: liquidatable,
        stressPoolOffsetDebt: offset,
        stressLiquidationCoverageRatio: ratio,
      },
    ],
    codeHashPins: [
      {
        name: "trove-manager",
        address: `0x${"4".repeat(40)}`,
        role: "liquidation-state-machine",
        codeHash: `0x${"5".repeat(64)}`,
      },
    ],
    evidenceRefIds: ["evidence:stress"],
  });
}

function incompleteFact(): V9CdpStressCoverageFact {
  const complete = stressFact(0.9);
  return V9CdpStressCoverageFactSchema.parse({
    ...complete,
    complete: false,
    blockers: ["branch-enumeration-incomplete"],
    stressLiquidatableDebt: null,
    stressPoolOffsetDebt: null,
    stressLiquidationCoverageRatio: null,
    branchContributions: [],
    codeHashPins: [],
  });
}

function backingAsset(selection: ReturnType<typeof selectV9CdpLiquidationCapacity>): V9BackingAssetInput {
  return {
    assetId: "test-cdp",
    reserveStatus: knownStatus("reserves"),
    reserveExposures: [],
    resolvedUpstreamExposures: [],
    gaps: [],
    cdpLiquidationCapacitySelection: selection,
  };
}

describe("Safety Score v9 CDP shock-coverage selection", () => {
  it("uses only a complete current stress measurement and exposes its evidence path", () => {
    const selected = selectV9CdpLiquidationCapacity(
      "test-cdp",
      review(),
      stressFact(0.5),
      V9_CANDIDATE_POLICY_V1,
      AS_OF_SEC,
    );
    expect(selected).toMatchObject({
      selectedPath: "stress-measurement",
      coverageRatio: 0.5,
      fallbackReason: null,
      selectedEvidenceRefIds: ["evidence:stress"],
    });
  });

  it("applies the 0.499/0.5 boundary to the existing unsafe-backing high signal", () => {
    const below = selectV9CdpLiquidationCapacity(
      "test-cdp",
      review(),
      stressFact(0.499),
      V9_CANDIDATE_POLICY_V1,
      AS_OF_SEC,
    );
    const boundary = selectV9CdpLiquidationCapacity(
      "test-cdp",
      review(),
      stressFact(0.5),
      V9_CANDIDATE_POLICY_V1,
      AS_OF_SEC,
    );
    const belowResult = evaluateV9CdpBacking(backingAsset(below), review(), V9_CANDIDATE_POLICY_V1);
    const boundaryResult = evaluateV9CdpBacking(backingAsset(boundary), review(), V9_CANDIDATE_POLICY_V1);

    expect(belowResult.structuralReasons).toContainEqual(
      expect.objectContaining({
        kind: "unsafe-backing",
        severity: "high",
        pathKey: "mechanism:liquidation-mechanics:stress-measurement",
      }),
    );
    expect(boundaryResult.structuralReasons).not.toContainEqual(
      expect.objectContaining({ kind: "unsafe-backing", severity: "high" }),
    );
  });

  it("degrades incomplete and stale facts to visible legacyLCR fallback", () => {
    const legacyReview = review({ liquidationCapacityRatio: 0.25 });
    const maxAgeSec =
      V9_CANDIDATE_POLICY_V1.policy.semantic.backing.structural.cdp.stressMeasurementFreshness.maxAgeSec;
    const incomplete = selectV9CdpLiquidationCapacity(
      "test-cdp",
      legacyReview,
      incompleteFact(),
      V9_CANDIDATE_POLICY_V1,
      AS_OF_SEC,
    );
    const boundary = selectV9CdpLiquidationCapacity(
      "test-cdp",
      legacyReview,
      stressFact(0.9, AS_OF_SEC - maxAgeSec),
      V9_CANDIDATE_POLICY_V1,
      AS_OF_SEC,
    );
    const staleFact = stressFact(0.9, AS_OF_SEC - maxAgeSec - 1);
    const stale = selectV9CdpLiquidationCapacity(
      "test-cdp",
      legacyReview,
      staleFact,
      V9_CANDIDATE_POLICY_V1,
      AS_OF_SEC,
    );

    expect(incomplete).toMatchObject({
      selectedPath: "legacyLCR",
      coverageRatio: 0.25,
      reason: "Selected legacyLCR fallback: stress-measurement-incomplete.",
      fallbackReason: "stress-measurement-incomplete",
      selectedEvidenceRefIds: ["evidence:legacy-liquidation"],
    });
    expect(boundary).toMatchObject({
      selectedPath: "stress-measurement",
      coverageRatio: 0.9,
      measurementAgeSec: maxAgeSec,
    });
    expect(stale).toMatchObject({
      selectedPath: "legacyLCR",
      coverageRatio: 0.25,
      reason: "Selected legacyLCR fallback: stress-measurement-stale.",
      fallbackReason: "stress-measurement-stale",
      stressEvidenceRefIds: ["evidence:stress"],
    });
  });

  it("requires both replay success and the attestation independently", () => {
    for (const mutation of [{ exactReplayPassed: false }, { replayVerification: null }]) {
      const selection = selectV9CdpLiquidationCapacity(
        "test-cdp", review(), { ...stressFact(0.9), ...mutation }, V9_CANDIDATE_POLICY_V1, AS_OF_SEC,
      );
      expect(selection).toMatchObject({
        selectedPath: "legacyLCR",
        coverageRatio: 0.25,
        fallbackReason: "stress-measurement-exact-replay-not-passed",
        selectedEvidenceRefIds: ["evidence:legacy-liquidation"],
        stressEvidenceRefIds: ["evidence:stress"],
      });
    }
  });

  it("accepts the publication timestamp but rejects one second in the future", () => {
    for (const delta of [0, 1]) {
      const selection = selectV9CdpLiquidationCapacity(
        "test-cdp", review(), stressFact(0.9, AS_OF_SEC + delta), V9_CANDIDATE_POLICY_V1, AS_OF_SEC,
      );
      expect(selection).toMatchObject({
        selectedPath: delta === 0 ? "stress-measurement" : "legacyLCR",
        coverageRatio: delta === 0 ? 0.9 : 0.25,
        fallbackReason: delta === 0 ? null : "stress-measurement-future-dated",
        stressEvidenceRefIds: ["evidence:stress"],
      });
    }
  });

  it("rejects either inconsistent shock representation and an excessive reconciliation tolerance", () => {
    const mutations: [Partial<V9CdpStressCoverageFact>, string][] = [
      [{ stressShockFraction: 0.4 }, "stress-shock-fraction-mismatch"],
      [{ shockPolicy: { ...stressFact(0.9).shockPolicy, scoreShockFractionPpm: 400_000 } }, "stress-shock-fraction-mismatch"],
      [{ shockPolicy: { ...stressFact(0.9).shockPolicy, debtReconciliationTolerancePpm: 1_001 } }, "stress-measurement-reconciliation-bound-exceeded"],
    ];
    for (const [mutation, fallbackReason] of mutations) {
      expect(selectV9CdpLiquidationCapacity(
        "test-cdp", review(), { ...stressFact(0.9), ...mutation }, V9_CANDIDATE_POLICY_V1, AS_OF_SEC,
      )).toMatchObject({
        selectedPath: "legacyLCR", coverageRatio: 0.25, fallbackReason,
        stressEvidenceRefIds: ["evidence:stress"],
      });
    }
  });

  it("reconciles multiple branches and rejects independent debt and ratio mismatches", () => {
    const fact = stressFact(0.5);
    fact.branchContributions = [
      { branchIndex: 0, stressLiquidatableDebt: "400", stressPoolOffsetDebt: "100", stressLiquidationCoverageRatio: 0.25 },
      { branchIndex: 1, stressLiquidatableDebt: "600", stressPoolOffsetDebt: "400", stressLiquidationCoverageRatio: 0.666666666666 },
    ];
    expect(selectV9CdpLiquidationCapacity(
      "test-cdp", review(), fact, V9_CANDIDATE_POLICY_V1, AS_OF_SEC,
    )).toMatchObject({ selectedPath: "stress-measurement", coverageRatio: 0.5, fallbackReason: null });
    const mutations: ((value: V9CdpStressCoverageFact) => void)[] = [
      (value) => { value.stressLiquidatableDebt = "1001"; },
      (value) => { value.stressPoolOffsetDebt = "501"; },
      (value) => { value.stressLiquidationCoverageRatio = 0.51; },
      (value) => { value.branchContributions[0].stressLiquidationCoverageRatio = 0.26; },
    ];
    for (const mutate of mutations) {
      const inconsistent = structuredClone(fact);
      mutate(inconsistent);
      expect(selectV9CdpLiquidationCapacity(
        "test-cdp", review(), inconsistent, V9_CANDIDATE_POLICY_V1, AS_OF_SEC,
      )).toMatchObject({
        selectedPath: "legacyLCR", coverageRatio: 0.25,
        fallbackReason: "stress-measurement-incomplete-or-inconsistent",
        stressEvidenceRefIds: ["evidence:stress"],
      });
    }
  });

  it("accepts zero debt only with zero offset and full coverage", () => {
    for (const [offset, ratio] of [["0", 1], ["1", 1], ["0", 0]] as const) {
      const fact = stressFact(1);
      fact.stressLiquidatableDebt = "0";
      fact.stressPoolOffsetDebt = offset;
      fact.stressLiquidationCoverageRatio = ratio;
      fact.branchContributions = [{
        branchIndex: 0, stressLiquidatableDebt: "0",
        stressPoolOffsetDebt: offset, stressLiquidationCoverageRatio: ratio,
      }];
      const valid = offset === "0" && ratio === 1;
      expect(selectV9CdpLiquidationCapacity(
        "test-cdp", review(), fact, V9_CANDIDATE_POLICY_V1, AS_OF_SEC,
      )).toMatchObject({
        selectedPath: valid ? "stress-measurement" : "legacyLCR",
        coverageRatio: valid ? 1 : 0.25,
        fallbackReason: valid ? null : "stress-measurement-incomplete-or-inconsistent",
        stressEvidenceRefIds: ["evidence:stress"],
      });
    }
  });

  it("keeps the current-CR critical signal unchanged when stress coverage passes", () => {
    const criticalReview = review({ collateralizationRatio: 0.99, liquidationCapacityRatio: 0.1 });
    const selection = selectV9CdpLiquidationCapacity(
      "test-cdp",
      criticalReview,
      stressFact(1),
      V9_CANDIDATE_POLICY_V1,
      AS_OF_SEC,
    );
    const result = evaluateV9CdpBacking(backingAsset(selection), criticalReview, V9_CANDIDATE_POLICY_V1);
    expect(result.structuralReasons).toContainEqual(
      expect.objectContaining({
        kind: "unsafe-backing",
        severity: "critical",
        pathKey: "mechanism:collateralization-parameters",
      }),
    );
    expect(result.structuralReasons).not.toContainEqual(
      expect.objectContaining({ kind: "unsafe-backing", severity: "high" }),
    );
  });

  it("does not select stress coverage without the mechanism review needed to evaluate it", () => {
    expect(
      selectV9CdpLiquidationCapacity("unreviewed-cdp", null, stressFact(0.499), V9_CANDIDATE_POLICY_V1, AS_OF_SEC),
    ).toMatchObject({
      selectedPath: "legacyLCR",
      coverageRatio: null,
      fallbackReason: "mechanism-review-unavailable",
    });
  });

  it("forces MIM through the evaluator-visible legacy guard without adding evidence", () => {
    const selection = selectV9CdpLiquidationCapacity(
      "mim-abracadabra",
      null,
      undefined,
      V9_CANDIDATE_POLICY_V1,
      AS_OF_SEC,
    );
    expect(selection).toEqual({
      selectedPath: "legacyLCR",
      coverageRatio: null,
      reason: "Selected legacyLCR fallback: no-reconciled-committed-pool-and-no-complete-family-simulator.",
      fallbackReason: "no-reconciled-committed-pool-and-no-complete-family-simulator",
      measurementAgeSec: null,
      selectedEvidenceRefIds: [],
      stressEvidenceRefIds: [],
    });
  });
});
