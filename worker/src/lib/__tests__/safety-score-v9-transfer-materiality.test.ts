import { describe, expect, expectTypeOf, it } from "vitest";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  resolveSafetyScoreV9ReviewedTransferFact,
  SAFETY_SCORE_V9_REVIEWED_TRANSFER_FACTS,
  type SafetyScoreV9TransferMaterialScope,
} from "../safety-score-v9-extension-transfer";
import { safetyScoreV9ChainSupplySourcePayload } from "../safety-score-v9-supply-attribution";
import {
  createSafetyScoreV9TransferMaterialityGeneration,
  SAFETY_SCORE_V9_TRANSFER_MATERIALITY_ASSET_IDS,
  transferMaterialScopeFromOnchainGeneration,
  type SafetyScoreV9TransferMaterialityObservation,
} from "../safety-score-v9-transfer-materiality";
import {
  observeSafetyScoreV9TransferMaterialityGeneration,
  transferMaterialityObserverResolvesRpc,
} from "../safety-score-v9-transfer-materiality-observer";

const ASSET_ID = "aa-falconx-mev-capital";
const DEPLOYMENT_KEY = "ethereum:0xc26a6fa2c37b38e549a4a1807543801db684f99c";
const CLOCK_SEC = Date.parse("2026-08-01T00:00:00Z") / 1_000;
const BASE_INPUT_GENERATION_ID = `report-cards-input:v1:${"a".repeat(64)}`;
const REGISTRY_FINGERPRINT = "b".repeat(64);
const BASE_SCOPE: SafetyScoreV9TransferMaterialScope = {
  authoritativeDeploymentKeys: [DEPLOYMENT_KEY],
  materialDeploymentKeys: [],
  materialDeploymentScopeComplete: false,
  deploymentModel: "contract-addressable",
};

function observation(overrides: Partial<SafetyScoreV9TransferMaterialityObservation> = {}): SafetyScoreV9TransferMaterialityObservation {
  return {
    deploymentKey: DEPLOYMENT_KEY,
    rawTokenUnits: "1000000000000000000",
    decimals: 18,
    blockNumber: "23000000",
    observedAtSec: CLOCK_SEC - 60,
    status: "accepted",
    ...overrides,
  };
}

function generation(rows = [observation()], capturedAtSec = CLOCK_SEC - 60) {
  return createSafetyScoreV9TransferMaterialityGeneration({
    schemaVersion: 1,
    kind: "safety-score-v9-transfer-materiality-generation",
    sourceBaseInputGenerationId: BASE_INPUT_GENERATION_ID,
    registryFingerprint: REGISTRY_FINGERPRINT,
    capturedAtSec,
    observationsByAssetId: { [ASSET_ID]: rows },
  });
}

function resolve(rows = [observation()], capturedAtSec = CLOCK_SEC - 60) {
  const meta = ACTIVE_META_BY_ID.get(ASSET_ID)!;
  const scope = transferMaterialScopeFromOnchainGeneration({
    assetId: ASSET_ID,
    meta,
    baseScope: BASE_SCOPE,
    generation: generation(rows, capturedAtSec),
    registryFingerprint: REGISTRY_FINGERPRINT,
    baseInputGenerationId: BASE_INPUT_GENERATION_ID,
    clockSec: CLOCK_SEC,
  });
  return resolveSafetyScoreV9ReviewedTransferFact(
    SAFETY_SCORE_V9_REVIEWED_TRANSFER_FACTS.get(ASSET_ID)!,
    CLOCK_SEC,
    scope,
  );
}

describe("Safety Score V9 transfer deployment materiality", () => {
  it("pins the approved cohort to exactly 40 assets", () => {
    expect(SAFETY_SCORE_V9_TRANSFER_MATERIALITY_ASSET_IDS).toHaveLength(40);
    expect(SAFETY_SCORE_V9_TRANSFER_MATERIALITY_ASSET_IDS).toContain("sfrxusd-frax");
  });

  it("resolves a cohort asset's reviewed transfer posture from a fresh raw-unit observation", () => {
    expect(resolve()).toEqual({ observationState: "known", posture: "restrictable" });
  });

  it.each([
    ["stale", [observation({ observedAtSec: CLOCK_SEC - 1_801 })], CLOCK_SEC - 1_801],
    ["RPC null", [{ ...observation(), rawTokenUnits: null, decimals: null, blockNumber: null, observedAtSec: null, status: "rejected" as const }], CLOCK_SEC - 60],
    ["identity mismatch", [observation({ deploymentKey: "ethereum:0x0000000000000000000000000000000000000001" })], CLOCK_SEC - 60],
  ])("fails closed for %s", (_label, rows, capturedAtSec) => {
    expect(resolve(rows, capturedAtSec)).toEqual({ observationState: "bounded-unknown", posture: null });
  });

  it.each([
    ["base-input generation", `report-cards-input:v1:${"c".repeat(64)}`, REGISTRY_FINGERPRINT],
    ["registry fingerprint", BASE_INPUT_GENERATION_ID, "d".repeat(64)],
  ])("fails closed for a mismatched %s", (_label, baseInputGenerationId, registryFingerprint) => {
    const meta = ACTIVE_META_BY_ID.get(ASSET_ID)!;
    const scope = transferMaterialScopeFromOnchainGeneration({
      assetId: ASSET_ID,
      meta,
      baseScope: BASE_SCOPE,
      generation: generation(),
      registryFingerprint,
      baseInputGenerationId,
      clockSec: CLOCK_SEC,
    });
    expect(resolveSafetyScoreV9ReviewedTransferFact(
      SAFETY_SCORE_V9_REVIEWED_TRANSFER_FACTS.get(ASSET_ID)!,
      CLOCK_SEC,
      scope,
    )).toEqual({ observationState: "bounded-unknown", posture: null });
  });

  it("treats every non-zero deployment of a bridged multi-chain asset as material", () => {
    // jpyt-dephaser is one liability reported by two deployments sharing an
    // address. Summing raw totalSupply() across them would overstate the total
    // and let the dust deployment fall under a share threshold, so it must not
    // be summed: both non-zero deployments stay material and require review.
    const multiAssetId = "jpyt-dephaser";
    const meta = ACTIVE_META_BY_ID.get(multiAssetId)!;
    const keys = (meta.contracts ?? []).map(
      (deployment) => `${deployment.chain}:${deployment.address.toLowerCase()}`,
    );
    expect(keys).toHaveLength(2);
    const rows = [
      observation({ deploymentKey: keys[0], rawTokenUnits: "1000000000000", decimals: 6 }),
      observation({ deploymentKey: keys[1], rawTokenUnits: "1", decimals: 6 }),
    ];
    const scope = transferMaterialScopeFromOnchainGeneration({
      assetId: multiAssetId,
      meta,
      baseScope: {
        authoritativeDeploymentKeys: [...keys].sort(),
        materialDeploymentKeys: [],
        materialDeploymentScopeComplete: false,
        deploymentModel: "contract-addressable",
      },
      generation: createSafetyScoreV9TransferMaterialityGeneration({
        schemaVersion: 1,
        kind: "safety-score-v9-transfer-materiality-generation",
        sourceBaseInputGenerationId: BASE_INPUT_GENERATION_ID,
        registryFingerprint: REGISTRY_FINGERPRINT,
        capturedAtSec: CLOCK_SEC - 60,
        observationsByAssetId: { [multiAssetId]: rows },
      }),
      registryFingerprint: REGISTRY_FINGERPRINT,
      baseInputGenerationId: BASE_INPUT_GENERATION_ID,
      clockSec: CLOCK_SEC,
    });
    expect(scope.materialDeploymentKeys).toEqual([...keys].sort());
    expect(scope.materialDeploymentScopeComplete).toBe(true);
  });

  it("excludes a zero-supply deployment from the material set", () => {
    const scope = transferMaterialScopeFromOnchainGeneration({
      assetId: ASSET_ID,
      meta: ACTIVE_META_BY_ID.get(ASSET_ID)!,
      baseScope: BASE_SCOPE,
      generation: generation([observation({ rawTokenUnits: "0" })]),
      registryFingerprint: REGISTRY_FINGERPRINT,
      baseInputGenerationId: BASE_INPUT_GENERATION_ID,
      clockSec: CLOCK_SEC,
    });
    expect(scope.materialDeploymentKeys).toEqual([]);
    expect(scope.materialDeploymentScopeComplete).toBe(false);
  });

  it("records an RPC-null deployment as rejected without affecting another asset", async () => {
    const observed = await observeSafetyScoreV9TransferMaterialityGeneration(
      {
        activeAssetIds: [ASSET_ID, "usdc-circle"],
        baseInputGenerationId: BASE_INPUT_GENERATION_ID,
        registryFingerprint: REGISTRY_FINGERPRINT,
        scoringClockSec: CLOCK_SEC,
        chainRpcs: new Map(),
      },
      {
        resolveClosestBlockAtOrBeforeTimestamp: async () => 23_000_000,
        fetchEvmBlockHeader: async () => ({ number: 23_000_000, timestamp: CLOCK_SEC - 60, hash: `0x${"1".repeat(64)}` }),
        fetchEvmMulticall3Aggregate3AtBlock: async () => null,
      },
    );
    expect(observed.observationsByAssetId[ASSET_ID]).toEqual([
      expect.objectContaining({ deploymentKey: DEPLOYMENT_KEY, status: "rejected", rawTokenUnits: null }),
    ]);
    expect(observed.observationsByAssetId).not.toHaveProperty("usdc-circle");
  });

  it("keeps the materiality type and generation out of circulating/market-cap supply", () => {
    expectTypeOf<SafetyScoreV9TransferMaterialityObservation>().not.toHaveProperty("currentSupplyUsd");
    expectTypeOf<SafetyScoreV9TransferMaterialityObservation>().not.toHaveProperty("priceUsd");
    const fixedInput = {
      chainCirculatingById: { [ASSET_ID]: {} },
      safetyScoreV9SupplyAttributionById: {},
      dexDeploymentSupplyCoverageById: {},
    } as unknown as Parameters<typeof safetyScoreV9ChainSupplySourcePayload>[0];
    const before = safetyScoreV9ChainSupplySourcePayload(fixedInput);
    const withMateriality = { ...fixedInput, transferMaterialityGeneration: generation() };
    expect(safetyScoreV9ChainSupplySourcePayload(withMateriality)).toEqual(before);
  });

  it("returns a non-cohort asset scope byte-identically", () => {
    const meta = ACTIVE_META_BY_ID.get("usdc-circle")!;
    const before = JSON.stringify(BASE_SCOPE);
    const after = transferMaterialScopeFromOnchainGeneration({
      assetId: "usdc-circle",
      meta,
      baseScope: BASE_SCOPE,
      generation: generation(),
      registryFingerprint: REGISTRY_FINGERPRINT,
      baseInputGenerationId: BASE_INPUT_GENERATION_ID,
      clockSec: CLOCK_SEC,
    });
    expect(after).toBe(BASE_SCOPE);
    expect(JSON.stringify(after)).toBe(before);
  });

  it("resolves observer-local RPCs for the sfrxUSD long-tail legs", () => {
    const emptyConfigured = new Map();
    for (const chainId of ["fraxtal", "sei", "mode", "xlayer", "katana", "sonic"]) {
      expect(transferMaterialityObserverResolvesRpc(chainId, emptyConfigured)).toBe(true);
    }
    expect(transferMaterialityObserverResolvesRpc("ethereum", emptyConfigured)).toBe(true);
    expect(transferMaterialityObserverResolvesRpc("secret", emptyConfigured)).toBe(false);
  });
});
