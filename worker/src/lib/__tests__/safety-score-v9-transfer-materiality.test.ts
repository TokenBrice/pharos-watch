import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { V9_ACCESS_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/access-posture";
import { sha256Hex } from "@shared/lib/sha256";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import type { SafetyScoreV9ReviewedTransferFact } from "@shared/types/safety-score-v9-transfer-overlays";
import type * as SupplyAttributionContract from "../safety-score-v9/supply-attribution-contract";
import {
  resolveSafetyScoreV9ReviewedTransferFact,
  getSafetyScoreV9ReviewedTransferFact,
  safetyScoreV9TransferDeploymentKey,
  type SafetyScoreV9TransferMaterialScope,
} from "../safety-score-v9/extension-transfer";
import { safetyScoreV9ChainSupplySourcePayload } from "../safety-score-v9/supply-attribution";
import {
  createSafetyScoreV9TransferMaterialityGeneration,
  parseSafetyScoreV9TransferMaterialityGeneration,
  serializeSafetyScoreV9TransferMaterialityGeneration,
  SAFETY_SCORE_V9_TRANSFER_MATERIALITY_ASSET_IDS,
  transferMaterialScopeFromOnchainGeneration,
  transferMaterialScopeFromSingleDeploymentAttribution,
  type SafetyScoreV9TransferMaterialityObservation,
} from "../safety-score-v9/transfer-materiality";
import {
  observeSafetyScoreV9TransferMaterialityGeneration,
  transferMaterialityObserverResolvesRpc,
} from "../safety-score-v9/transfer-materiality-observer";

vi.mock("../safety-score-v9/supply-attribution-contract", async (importOriginal) => {
  const actual = await importOriginal<typeof SupplyAttributionContract>();
  return { ...actual, REVIEWED_SUPPLY_ATTRIBUTION_ENVELOPE: {
    ...actual.REVIEWED_SUPPLY_ATTRIBUTION_ENVELOPE,
    independentLiabilityAssetIds: ["fixture-independent", "fixture-shared", "fixture-independent"],
    providerChainPartitionReviews: [
      ...(actual.REVIEWED_SUPPLY_ATTRIBUTION_ENVELOPE.providerChainPartitionReviews ?? []),
      { assetId: "fixture-provider" }, { assetId: "fixture-shared" },
    ],
  } };
});

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

describe("single-deployment transfer attribution", () => {
  function fixture() {
    const review = structuredClone(getSafetyScoreV9ReviewedTransferFact(ASSET_ID)!);
    review.transferScopeAttestation = {
      kind: "single-deployment-attribution", version: 1,
      reviewedAt: "2026-07-31", expiresAt: "2027-07-31",
      reviewer: "Test reviewer", deploymentKey: DEPLOYMENT_KEY,
      exhaustiveLiability: true,
      sources: [{ label: "Contract", url: "https://etherscan.io/address/0xc26a6fa2c37b38e549a4a1807543801db684f99c" }],
    };
    return {
      meta: structuredClone(ACTIVE_META_BY_ID.get(ASSET_ID)!),
      review, aggregateCirculating: { circulating: { peggedUSD: 100 } },
      baseScope: BASE_SCOPE, clockSec: CLOCK_SEC,
    };
  }

  it("completes only attributed scope for a reviewed singleton share liability", () => {
    const input = fixture();
    const scope = transferMaterialScopeFromSingleDeploymentAttribution(input);
    expect(scope.scopeBasis).toBe("attributed");
    expect(scope.materialDeploymentKeys).toEqual([DEPLOYMENT_KEY]);
    expect(resolveSafetyScoreV9ReviewedTransferFact(input.review, CLOCK_SEC, scope).observationState).toBe("known");
    expect(input.aggregateCirculating).toEqual({ circulating: { peggedUSD: 100 } });
  });

  it.each<[string, (input: { meta: StablecoinMeta; review: SafetyScoreV9ReviewedTransferFact }) => void]>([
    ["a second deployment", input => { input.meta.contracts!.push({ ...input.meta.contracts![0]!, chain: "base" }); }],
    ["a wrapper liability", input => { input.meta.variantKind = "pure-wrapper"; }],
    ["a bridge representation route", input => {
      input.meta.bridgeRouteRisk = structuredClone(ACTIVE_META_BY_ID.get("xdai-gnosis")!.bridgeRouteRisk);
    }],
    ["a missing attestation", input => { delete input.review.transferScopeAttestation; }],
    ["an expired attestation", input => { input.review.transferScopeAttestation!.expiresAt = "2026-08-01"; }],
    ["a mismatched attestation", input => { input.review.transferScopeAttestation!.deploymentKey = "base:0x123"; }],
    ["a future attestation", input => { input.review.transferScopeAttestation!.reviewedAt = "2026-08-02"; }],
  ])("rejects %s", (_label, mutate) => {
    const input = fixture();
    mutate(input);
    expect(transferMaterialScopeFromSingleDeploymentAttribution(input)).toBe(BASE_SCOPE);
  });

  it("rejects absent admitted aggregate and preserves observed scope", () => {
    const input = fixture();
    input.aggregateCirculating.circulating.peggedUSD = 0;
    expect(transferMaterialScopeFromSingleDeploymentAttribution(input)).toBe(BASE_SCOPE);
    const observed = { ...BASE_SCOPE, materialDeploymentKeys: [DEPLOYMENT_KEY], materialDeploymentScopeComplete: true };
    expect(transferMaterialScopeFromSingleDeploymentAttribution({ ...fixture(), baseScope: observed })).toBe(observed);
  });
});

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
    getSafetyScoreV9ReviewedTransferFact(ASSET_ID)!,
    CLOCK_SEC,
    scope,
  );
}

describe("Safety Score V9 transfer deployment materiality", () => {
  it("pins the canonical generation envelope and native malformed-JSON error", () => {
    const value = generation();
    const serialized = serializeSafetyScoreV9TransferMaterialityGeneration(value);
    expect([value.generationId, new TextEncoder().encode(serialized).byteLength, sha256Hex(serialized)]).toEqual([
      "safety-score-v9-transfer-materiality:v1:60edd6c103e8a7e46e75d787959a8145a1e6c4643be6062cdc752ccda702c219",
      682,
      "053585e6e69835afbc80b9d070c568918c9646818688f881346cd804eff43c43",
    ]);
    expect(() => parseSafetyScoreV9TransferMaterialityGeneration("{")).toThrow(SyntaxError);
  });
  it("collects every reviewed census asset exactly once", () => {
    expect(new Set(SAFETY_SCORE_V9_TRANSFER_MATERIALITY_ASSET_IDS).size).toBe(SAFETY_SCORE_V9_TRANSFER_MATERIALITY_ASSET_IDS.length);
    for (const assetId of ["fixture-independent", "fixture-provider", "fixture-shared"]) {
      expect(SAFETY_SCORE_V9_TRANSFER_MATERIALITY_ASSET_IDS.filter(id => id === assetId)).toHaveLength(1);
    }
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
      getSafetyScoreV9ReviewedTransferFact(ASSET_ID)!,
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
    // This capture predates the XLayer accounting review, so no chain-local
    // reads are admitted; an empty roster cannot complete transfer scope.
    expect(observed.observationsByAssetId["usdc-circle"]).toEqual([]);
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

  it("returns an incomplete census asset scope byte-identically", () => {
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

const NON_CONTRACT_CLOCK_SEC = Date.parse("2026-08-10T00:00:00.000Z") / 1_000;

function review(
  deployments: { chainId: string; contractOrTokenId: string; posture: "permissionless" | "restrictable" | "permissioned" }[],
  reviewedAt = "2026-08-08",
): SafetyScoreV9ReviewedTransferFact {
  return {
    assetId: "alpha",
    reviewedAt,
    reviewer: "test",
    deployments: deployments.map((deployment) => ({
      ...deployment,
      scope: "canonical" as const,
      evidence: "Reviewed against the chain's primary asset documentation.",
      sources: [{ label: "Docs", url: "https://example.test/asset" }],
    })),
  };
}

function scope(overrides: Partial<SafetyScoreV9TransferMaterialScope> = {}): SafetyScoreV9TransferMaterialScope {
  return {
    authoritativeDeploymentKeys: [],
    materialDeploymentKeys: [],
    materialDeploymentScopeComplete: false,
    deploymentModel: "non-contract-native",
    ...overrides,
  };
}

describe("resolveSafetyScoreV9ReviewedTransferFact — non-contract-native applicability", () => {
  // Owner ruling 2026-08-10. The scope test proves a review covers every
  // material *contract* deployment, so a chain-native asset that can never have
  // `contracts[]` rows stayed bounded-unknown forever and published as
  // `missing-access-review` — "we never looked" — with a complete current
  // primary-sourced review on file.
  it("publishes the curated posture with an explicit applicability basis", () => {
    const resolved = resolveSafetyScoreV9ReviewedTransferFact(
      review([{ chainId: "zano", contractOrTokenId: "86143388bd05", posture: "permissionless" }]),
      NON_CONTRACT_CLOCK_SEC,
      scope(),
    );
    expect(resolved).toEqual({
      observationState: "known",
      posture: "permissionless",
      structuralDisposition: "non-contract-native",
    });
  });

  it("still reduces to the most restrictive reviewed deployment", () => {
    const resolved = resolveSafetyScoreV9ReviewedTransferFact(
      review([
        { chainId: "zephyr", contractOrTokenId: "ZEPHUSD", posture: "permissionless" },
        { chainId: "zephyr", contractOrTokenId: "ZEPHRSV", posture: "restrictable" },
      ]),
      NON_CONTRACT_CLOCK_SEC,
      scope(),
    );
    expect(resolved.posture).toBe("restrictable");
  });

  it("refuses a review that touches a contract-addressable chain", () => {
    // A supported-chain deployment is measurable by the scope machinery, so an
    // incomplete scope there is a curation gap, never a structural fact.
    const resolved = resolveSafetyScoreV9ReviewedTransferFact(
      review([{ chainId: "gnosis", contractOrTokenId: "0xabc", posture: "permissionless" }]),
      NON_CONTRACT_CLOCK_SEC,
      scope(),
    );
    expect(resolved).toEqual({ observationState: "bounded-unknown", posture: null });
  });

  it("refuses an asset whose supply or contracts remain contract-addressable", () => {
    const resolved = resolveSafetyScoreV9ReviewedTransferFact(
      review([{ chainId: "zano", contractOrTokenId: "86143388bd05", posture: "permissionless" }]),
      NON_CONTRACT_CLOCK_SEC,
      scope({ deploymentModel: "contract-addressable" }),
    );
    expect(resolved).toEqual({ observationState: "bounded-unknown", posture: null });
  });

  it("refuses unreviewed material chains outside the supported chain registry", () => {
    const current = review([{ chainId: "zano", contractOrTokenId: "native", posture: "permissionless" }]);
    expect(resolveSafetyScoreV9ReviewedTransferFact(current, NON_CONTRACT_CLOCK_SEC, scope({
      unresolvedMaterialChainIds: ["zano", "unreviewed-chain"],
    }))).toEqual({ observationState: "bounded-unknown", posture: null });
    expect(resolveSafetyScoreV9ReviewedTransferFact(current, NON_CONTRACT_CLOCK_SEC, scope({
      unresolvedMaterialChainIds: ["zano"],
    }))).toMatchObject({ observationState: "known", posture: "permissionless" });
  });

  it("requires exact declared token coverage even on an unsupported chain", () => {
    const current = review([{ chainId: "zano", contractOrTokenId: "token-A", posture: "permissionless" }]);
    expect(resolveSafetyScoreV9ReviewedTransferFact(current, NON_CONTRACT_CLOCK_SEC, scope({
      unresolvedMaterialChainIds: ["zano"],
      unresolvedDeclaredDeploymentKeys: ["token-A", "token-B"].map((id) => safetyScoreV9TransferDeploymentKey("zano", id)),
    }))).toEqual({ observationState: "bounded-unknown", posture: null });
  });

  it("excludes additional-only material coverage and non-authoritative extras", () => {
    const key = safetyScoreV9TransferDeploymentKey("ethereum", "0xABC");
    const materialScope = scope({
      authoritativeDeploymentKeys: [key], materialDeploymentKeys: [key],
      materialDeploymentScopeComplete: true, deploymentModel: "contract-addressable",
    });
    const current = review([{ chainId: "ethereum", contractOrTokenId: "0xABC", posture: "permissionless" }]);
    expect(resolveSafetyScoreV9ReviewedTransferFact(current, NON_CONTRACT_CLOCK_SEC, materialScope)).toEqual({
      observationState: "known", posture: "permissionless",
    });
    const additional = structuredClone(current);
    additional.deployments[0]!.scope = "additional";
    expect(resolveSafetyScoreV9ReviewedTransferFact(additional, NON_CONTRACT_CLOCK_SEC, materialScope)).toEqual({
      observationState: "bounded-unknown", posture: null,
    });
    const extra = structuredClone(current);
    extra.deployments.push({ ...current.deployments[0]!, contractOrTokenId: "0xDEF", scope: "additional" });
    expect(resolveSafetyScoreV9ReviewedTransferFact(extra, NON_CONTRACT_CLOCK_SEC, materialScope)).toEqual({
      observationState: "bounded-unknown", posture: null,
    });
  });

  it("reduces mixed postures to permissioned independently of deployment order", () => {
    const current = review([
      { chainId: "ethereum", contractOrTokenId: "0xA", posture: "permissionless" },
      { chainId: "ethereum", contractOrTokenId: "0xB", posture: "permissioned" },
      { chainId: "ethereum", contractOrTokenId: "0xC", posture: "restrictable" },
    ]);
    const keys = ["0xA", "0xB", "0xC"].map((id) => safetyScoreV9TransferDeploymentKey("ethereum", id));
    const materialScope = scope({
      authoritativeDeploymentKeys: keys, materialDeploymentKeys: keys,
      materialDeploymentScopeComplete: true, deploymentModel: "contract-addressable",
    });
    for (let index = 0; index < 3; index++) {
      expect(resolveSafetyScoreV9ReviewedTransferFact(current, NON_CONTRACT_CLOCK_SEC, materialScope)).toEqual({
        observationState: "known", posture: "permissioned",
      });
      current.deployments.push(current.deployments.shift()!);
    }
  });

  it.each([
    ["contract-addressable", true],
    ["non-contract-native", true],
    ["mixed-economic", false],
  ] as const)("rejects native identities for %s scope with attestation=%s", (deploymentModel, attested) => {
    const current = review([{ chainId: "ethereum", contractOrTokenId: "native:alpha", posture: "permissionless" }]);
    const key = safetyScoreV9TransferDeploymentKey("ethereum", "native:alpha");
    expect(resolveSafetyScoreV9ReviewedTransferFact(current, NON_CONTRACT_CLOCK_SEC, scope({
      deploymentModel,
      authoritativeDeploymentKeys: [key],
      materialDeploymentKeys: [key],
      materialDeploymentScopeComplete: true,
      reviewedNativeDeploymentKeys: attested ? [key] : [],
    }))).toEqual({ observationState: "bounded-unknown", posture: null });
  });

  it("admits a mixed economic native identity only with its exact reviewed deployment key", () => {
    const current = review([{ chainId: "ethereum", contractOrTokenId: "native:alpha", posture: "restrictable" }]);
    const key = safetyScoreV9TransferDeploymentKey("ethereum", "native:alpha");
    const materialScope = scope({
      deploymentModel: "mixed-economic",
      authoritativeDeploymentKeys: [key],
      materialDeploymentKeys: [key],
      materialDeploymentScopeComplete: true,
      reviewedNativeDeploymentKeys: [safetyScoreV9TransferDeploymentKey("ethereum", "native:beta")],
    });
    expect(resolveSafetyScoreV9ReviewedTransferFact(current, NON_CONTRACT_CLOCK_SEC, materialScope)).toEqual({
      observationState: "bounded-unknown", posture: null,
    });
    materialScope.reviewedNativeDeploymentKeys = [key];
    expect(resolveSafetyScoreV9ReviewedTransferFact(current, NON_CONTRACT_CLOCK_SEC, materialScope)).toEqual({
      observationState: "known", posture: "restrictable",
    });
  });

  it("admits the exact review-age limit but rejects stale and future reviews", () => {
    const current = review([{ chainId: "zano", contractOrTokenId: "native", posture: "permissionless" }]);
    const reviewedAt = Date.parse("2026-08-08T00:00:00Z") / 1_000;
    expect(resolveSafetyScoreV9ReviewedTransferFact(current, reviewedAt + V9_ACCESS_EVIDENCE_MAX_AGE_SEC, scope())).toMatchObject({
      observationState: "known", posture: "permissionless",
    });
    expect(resolveSafetyScoreV9ReviewedTransferFact(current, reviewedAt + V9_ACCESS_EVIDENCE_MAX_AGE_SEC + 1, scope())).toEqual({
      observationState: "stale", posture: null,
    });
    expect(() => resolveSafetyScoreV9ReviewedTransferFact(current, reviewedAt - 1, scope())).toThrow(/future-dated/);
  });
});
