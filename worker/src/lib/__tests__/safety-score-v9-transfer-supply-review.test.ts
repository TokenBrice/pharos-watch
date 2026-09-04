import { resolveChainId } from "@shared/lib/chains";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { BridgeRouteRiskProfile } from "@shared/types/core";
import { describe, expect, it } from "vitest";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9/extension";
import {
  compileSafetyScoreV9FactSetFromFixedInput,
  compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension,
  materializeSafetyScoreV9FactSetExtension,
} from "../safety-score-v9/fact-set";
import type { SafetyScoreV9CompilerInput } from "../safety-score-v9/native-input";
import {
  buildSafetyScoreV9SupplyReview,
  SAFETY_SCORE_V9_INDEPENDENT_LIABILITY_SUPPLY_ASSET_IDS,
} from "../safety-score-v9/extension-supply";
import { safetyScoreV9TransferDeploymentKey } from "../safety-score-v9/extension-transfer";
import {
  createSafetyScoreV9TransferMaterialityGeneration,
  type SafetyScoreV9TransferMaterialityGeneration,
  type SafetyScoreV9TransferMaterialityObservation,
} from "../safety-score-v9/transfer-materiality";
import { makeV9FixedInput } from "../../test-helpers/v9-fixed-input";

const CLOCK_SEC = Date.parse("2026-08-17T00:00:00Z") / 1_000;
const BASE_INPUT_GENERATION_ID = `report-cards-input:v1:${"a".repeat(64)}`;
const REGISTRY_FINGERPRINT = "b".repeat(64);
const AGGREGATE_SUPPLY_USD = 34_668_686.813536435;

function fixedInput(assetId: string, overrides: Partial<SafetyScoreV9CompilerInput> = {}): SafetyScoreV9CompilerInput {
  return {
    registryFingerprint: REGISTRY_FINGERPRINT,
    baseInputGenerationId: BASE_INPUT_GENERATION_ID,
    clockSec: CLOCK_SEC,
    chainCirculatingById: { [assetId]: {} },
    aggregateCirculatingById: {
      [assetId]: {
        circulating: { peggedUSD: AGGREGATE_SUPPLY_USD },
        observedAtSec: CLOCK_SEC - 60,
      },
    },
    safetyScoreV9SupplyAttributionById: {},
    ...overrides,
  } as SafetyScoreV9CompilerInput;
}

function observationsFor(
  assetId: string,
  mutate: (
    row: SafetyScoreV9TransferMaterialityObservation,
    index: number,
  ) => SafetyScoreV9TransferMaterialityObservation = (row) => row,
): SafetyScoreV9TransferMaterialityObservation[] {
  const meta = ACTIVE_META_BY_ID.get(assetId)!;
  return (meta.contracts ?? []).map((deployment, index) => {
    const chainId = resolveChainId(deployment.chain)!;
    return mutate({
      deploymentKey: safetyScoreV9TransferDeploymentKey(chainId, deployment.address),
      rawTokenUnits: `${index + 1}${"0".repeat(deployment.decimals)}`,
      decimals: deployment.decimals,
      blockNumber: String(1_000_000 + index),
      observedAtSec: CLOCK_SEC - 60,
      status: "accepted",
    }, index);
  });
}

function generation(
  assetId: string,
  rows = observationsFor(assetId),
  capturedAtSec = CLOCK_SEC - 60,
): SafetyScoreV9TransferMaterialityGeneration {
  return createSafetyScoreV9TransferMaterialityGeneration({
    schemaVersion: 1,
    kind: "safety-score-v9-transfer-materiality-generation",
    sourceBaseInputGenerationId: BASE_INPUT_GENERATION_ID,
    registryFingerprint: REGISTRY_FINGERPRINT,
    capturedAtSec,
    observationsByAssetId: { [assetId]: rows },
  });
}

function review(
  assetId: string,
  materialityGeneration: SafetyScoreV9TransferMaterialityGeneration | null,
  profileOverride?: BridgeRouteRiskProfile,
) {
  const meta = ACTIVE_META_BY_ID.get(assetId)!;
  return buildSafetyScoreV9SupplyReview(
    fixedInput(assetId),
    assetId,
    profileOverride ?? meta.bridgeRouteRisk,
    { meta, transferMaterialityGeneration: materialityGeneration },
  );
}

describe("Safety Score V9 transfer-materiality supply partition", () => {
  it("allowlists only the two reviewed independent-liability inventories", () => {
    expect(SAFETY_SCORE_V9_INDEPENDENT_LIABILITY_SUPPLY_ASSET_IDS).toEqual([
      "sfrxusd-frax",
      "wsrusd-reservoir",
    ]);
    expect(SAFETY_SCORE_V9_INDEPENDENT_LIABILITY_SUPPLY_ASSET_IDS).not.toContain("idrt-rupiah-token");
    expect(SAFETY_SCORE_V9_INDEPENDENT_LIABILITY_SUPPLY_ASSET_IDS).not.toContain("vusd-virtue");
  });

  it("allocates aggregate sfrxUSD USD across its exact thirty-route raw-unit packet", () => {
    const result = review("sfrxusd-frax", generation("sfrxusd-frax"));

    expect(result).not.toBeNull();
    expect(result!.selectedBridgeRoutes).toHaveLength(30);
    expect(result!.selectedBridgeRoutes.filter((row) => row.reviewedRouteKind === "native")).toHaveLength(2);
    expect(result!.selectedBridgeRoutes.filter((row) => row.reviewedRouteKind === "controlled")).toHaveLength(28);
    expect(result!.selectedBridgeRoutes.reduce((sum, row) => sum + row.supplyUsd, 0)).toBeCloseTo(
      AGGREGATE_SUPPLY_USD,
      6,
    );
    expect(result!.selectedBridgeRoutes.reduce((sum, row) => sum + row.supplyShare, 0)).toBeCloseTo(1, 12);
    expect(result).toMatchObject({
      selectedRouteSupplyShare: 1,
      unknownRouteSupplyShare: 0,
      unreviewedRouteSupplyShare: 0,
    });
  });

  it("clears exactly seven public materiality reasons and the source bridge gap on a production-shaped sfrxUSD replay", () => {
    const assetId = "sfrxusd-frax";
    const meta = ACTIVE_META_BY_ID.get(assetId)!;
    const replayInput = makeV9FixedInput({
      assetId,
      clockSec: CLOCK_SEC,
      chainSupplyByChain: {},
      aggregateCirculating: { peggedUSD: AGGREGATE_SUPPLY_USD },
      omitLiveReserve: true,
    });
    const exactGeneration = createSafetyScoreV9TransferMaterialityGeneration({
      schemaVersion: 1,
      kind: "safety-score-v9-transfer-materiality-generation",
      sourceBaseInputGenerationId: replayInput.baseInputGenerationId,
      registryFingerprint: replayInput.registryFingerprint,
      capturedAtSec: replayInput.clockSec - 60,
      observationsByAssetId: { [assetId]: observationsFor(assetId) },
    });
    const metaById = new Map([[assetId, meta]]);
    const beforeExtension = buildSafetyScoreV9BaselineExtension(replayInput, { metaById });
    const afterExtension = buildSafetyScoreV9BaselineExtension(replayInput, {
      metaById,
      transferMaterialityGeneration: exactGeneration,
    });
    const beforeFactSet = compileSafetyScoreV9FactSetFromFixedInput(replayInput, beforeExtension);
    const afterFactSet = compileSafetyScoreV9FactSetFromFixedInput(replayInput, afterExtension);
    const before = beforeFactSet.assets[0]!;
    const after = afterFactSet.assets[0]!;
    const beforeReasons = evaluateV9FactSet(beforeFactSet, V9_CANDIDATE_POLICY_V1)
      .assets[0]!.scoreInput.pillars.control.reasons;
    const afterReasons = evaluateV9FactSet(afterFactSet, V9_CANDIDATE_POLICY_V1)
      .assets[0]!.scoreInput.pillars.control.reasons;

    expect(beforeReasons.filter((reason) => reason.code === "runtime-bridge-materiality-unavailable")).toHaveLength(7);
    expect(afterReasons.filter((reason) => reason.code === "runtime-bridge-materiality-unavailable")).toHaveLength(0);
    expect(before.economicControlReview.bridge.status.gapIds).toContain(`${assetId}:gap:economic-control:bridge`);
    expect(after.economicControlReview.bridge.status.gapIds).toEqual([]);
    expect(before.gaps.filter((gap) => gap.reasonCode === "missing-bridge-routes")).toHaveLength(1);
    expect(after.gaps.filter((gap) => gap.reasonCode === "missing-bridge-routes")).toHaveLength(0);
    expect(after.supply.selectedBridgeRoutes).toHaveLength(30);
  });

  it.each([
    [
      "route USD totals",
      (supplyReview: NonNullable<ReturnType<typeof buildSafetyScoreV9SupplyReview>>) => {
        supplyReview.selectedBridgeRoutes[0]!.supplyUsd += 1;
      },
    ],
    [
      "aggregate shares",
      (supplyReview: NonNullable<ReturnType<typeof buildSafetyScoreV9SupplyReview>>) => {
        supplyReview.selectedRouteSupplyShare = 0.9;
      },
    ],
    [
      "route shares",
      (supplyReview: NonNullable<ReturnType<typeof buildSafetyScoreV9SupplyReview>>) => {
        supplyReview.selectedBridgeRoutes[0]!.supplyShare -= 0.01;
      },
    ],
    [
      "route review categories",
      (supplyReview: NonNullable<ReturnType<typeof buildSafetyScoreV9SupplyReview>>) => {
        supplyReview.selectedBridgeRoutes[0]!.reviewState = "selected-unresolved";
        delete supplyReview.selectedBridgeRoutes[0]!.reviewedRouteKind;
      },
    ],
  ])("quarantines malformed aggregate bridge %s", (_label, corrupt) => {
    const assetId = "sfrxusd-frax";
    const replayInput = makeV9FixedInput({
      assetId,
      clockSec: CLOCK_SEC,
      chainSupplyByChain: {},
      aggregateCirculating: { peggedUSD: AGGREGATE_SUPPLY_USD },
      omitLiveReserve: true,
    });
    const exactGeneration = createSafetyScoreV9TransferMaterialityGeneration({
      schemaVersion: 1,
      kind: "safety-score-v9-transfer-materiality-generation",
      sourceBaseInputGenerationId: replayInput.baseInputGenerationId,
      registryFingerprint: replayInput.registryFingerprint,
      capturedAtSec: replayInput.clockSec - 60,
      observationsByAssetId: { [assetId]: observationsFor(assetId) },
    });
    const extension = buildSafetyScoreV9BaselineExtension(replayInput, {
      metaById: new Map([[assetId, ACTIVE_META_BY_ID.get(assetId)!]]),
      transferMaterialityGeneration: exactGeneration,
    });
    const supplyReview = extension.assets[0]!.supplyReview!;
    corrupt(supplyReview);
    const materialized = materializeSafetyScoreV9FactSetExtension(replayInput, extension);
    const result = compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(replayInput, materialized);

    expect(result.quarantines).toEqual([{ assetId, code: "fact-build-failed" }]);
  });

  it.each([
    [
      "rejected observation",
      observationsFor("sfrxusd-frax", (row, index) => index === 0
        ? { ...row, rawTokenUnits: null, decimals: null, blockNumber: null, observedAtSec: null, status: "rejected" }
        : row),
      CLOCK_SEC - 60,
    ],
    ["partial inventory", observationsFor("sfrxusd-frax").slice(0, -1), CLOCK_SEC - 60],
    [
      "decimal mismatch",
      observationsFor("sfrxusd-frax", (row, index) => index === 0 ? { ...row, decimals: row.decimals! - 1 } : row),
      CLOCK_SEC - 60,
    ],
    ["zero normalized total", observationsFor("sfrxusd-frax", (row) => ({ ...row, rawTokenUnits: "0" })), CLOCK_SEC - 60],
    [
      "stale exact-input packet",
      observationsFor("sfrxusd-frax", (row) => ({ ...row, observedAtSec: CLOCK_SEC - 1_801 })),
      CLOCK_SEC - 1_801,
    ],
  ])("fails closed for a %s", (_label, rows, capturedAtSec) => {
    expect(review("sfrxusd-frax", generation("sfrxusd-frax", rows, capturedAtSec))).toBeNull();
  });

  it("fails closed when the generation belongs to another exact base input", () => {
    const assetId = "sfrxusd-frax";
    const meta = ACTIVE_META_BY_ID.get(assetId)!;
    const result = buildSafetyScoreV9SupplyReview(
      fixedInput(assetId, { baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}` }),
      assetId,
      meta.bridgeRouteRisk,
      { meta, transferMaterialityGeneration: generation(assetId) },
    );
    expect(result).toBeNull();
  });

  it("fails closed when any sfrxUSD route is not reviewed native-mint or burn-mint", () => {
    const profile = structuredClone(ACTIVE_META_BY_ID.get("sfrxusd-frax")!.bridgeRouteRisk)!;
    profile.routes![0] = {
      ...profile.routes![0]!,
      issuanceModel: "wrapped-representation",
      routeClass: "canonical",
      semantics: "lock-mint",
    };
    expect(review("sfrxusd-frax", generation("sfrxusd-frax"), profile)).toBeNull();
  });

  it("keeps wsrUSD aggregate-only when its authoritative Solana row is rejected", () => {
    const rows = observationsFor("wsrusd-reservoir", (row) =>
      row.deploymentKey.startsWith("solana:")
        ? { ...row, rawTokenUnits: null, decimals: null, blockNumber: null, observedAtSec: null, status: "rejected" }
        : row,
    );
    expect(review("wsrusd-reservoir", generation("wsrusd-reservoir", rows))).toBeNull();
  });

  it("leaves all twenty wsrUSD public materiality reasons and its bridge gap unresolved", () => {
    const assetId = "wsrusd-reservoir";
    const meta = ACTIVE_META_BY_ID.get(assetId)!;
    const replayInput = makeV9FixedInput({
      assetId,
      clockSec: CLOCK_SEC,
      chainSupplyByChain: {},
      aggregateCirculating: { peggedUSD: 55_109_491.490999065 },
      omitLiveReserve: true,
    });
    const rows = observationsFor(assetId, (row) =>
      row.deploymentKey.startsWith("solana:")
        ? { ...row, rawTokenUnits: null, decimals: null, blockNumber: null, observedAtSec: null, status: "rejected" }
        : row,
    );
    const exactGeneration = createSafetyScoreV9TransferMaterialityGeneration({
      schemaVersion: 1,
      kind: "safety-score-v9-transfer-materiality-generation",
      sourceBaseInputGenerationId: replayInput.baseInputGenerationId,
      registryFingerprint: replayInput.registryFingerprint,
      capturedAtSec: replayInput.clockSec - 60,
      observationsByAssetId: { [assetId]: rows },
    });
    const extension = buildSafetyScoreV9BaselineExtension(replayInput, {
      metaById: new Map([[assetId, meta]]),
      transferMaterialityGeneration: exactGeneration,
    });
    const factSet = compileSafetyScoreV9FactSetFromFixedInput(replayInput, extension);
    const compiled = factSet.assets[0]!;
    const reasons = evaluateV9FactSet(factSet, V9_CANDIDATE_POLICY_V1)
      .assets[0]!.scoreInput.pillars.control.reasons;

    expect(extension.assets[0]!.supplyReview).toBeNull();
    expect(reasons.filter((reason) => reason.code === "runtime-bridge-materiality-unavailable")).toHaveLength(20);
    expect(compiled.gaps.filter((gap) => gap.reasonCode === "missing-bridge-routes")).toHaveLength(1);
    expect(compiled.supply.selectedBridgeRoutes).toEqual([]);
  });

  it.each(["idrt-rupiah-token", "vusd-virtue"])(
    "does not sum the excluded %s representation inventory",
    (assetId) => {
      expect(review(assetId, generation(assetId))).toBeNull();
    },
  );
});
