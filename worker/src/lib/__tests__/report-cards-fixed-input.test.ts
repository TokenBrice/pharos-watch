import { describe, expect, it } from "vitest";
import type { DexLiquidityData, ExitRouteObservation } from "@shared/types/market";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import {
  computeDexLiquidityPayloadFingerprint as computeSharedDexLiquidityPayloadFingerprint,
  computeRedemptionPayloadFingerprint as computeSharedRedemptionPayloadFingerprint,
  computeReportCardsRegistryFingerprint as computeSharedReportCardsRegistryFingerprint,
  normalizeFixedRedemptionBackstopMap,
  normalizeReportCardsFixedInputMethodologyVersions,
  projectReportCardsFixedInputMethodologyVersions,
} from "@shared/lib/report-cards-fixed-input-identity";
import {
  buildReportCardsFixedInputCacheEntry,
  computeDexLiquidityPayloadFingerprint,
  computeRedemptionPayloadFingerprint,
  computeReportCardsRegistryFingerprint,
  normalizeFixedInput,
  parseReportCardsFixedInputCacheArtifact,
  parseReportCardsFixedInputCacheValue,
} from "../report-cards-fixed-input";
import { safetyScoreV9ChainSupplySourceGenerationId } from "../safety-score-v9-supply-attribution";
import { makeV9RegistryFixedInput } from "../../test-helpers/v9-fixed-input";
import {
  buildReviewedDeploymentRouteInventory,
  deriveReviewedDeploymentUnitPartition,
  expectedWmDeploymentIdentity,
  type ReviewedDeploymentSupplyObservation,
} from "../safety-score-v9-supply-attribution-contract";
import {
  buildXautTransparencySource,
  deriveXautRepresentationGroupSupplyAttribution,
  XAUT0_ADAPTER_ADDRESS,
  XAUT0_ADAPTER_IMPLEMENTATION_ADDRESS,
  XAUT0_ADAPTER_IMPLEMENTATION_CODE_SHA256,
  XAUT0_ADAPTER_RUNTIME_CODE_SHA256,
  XAUT0_LAYERZERO_ENDPOINT_ADDRESS,
  XAUT_CANONICAL_IMPLEMENTATION_ADDRESS,
  XAUT_CANONICAL_IMPLEMENTATION_CODE_SHA256,
  XAUT_CANONICAL_RUNTIME_CODE_SHA256,
  XAUT_ASSET_ID,
  XAUT_CANONICAL_TOKEN_ADDRESS,
  XAUT_TRANSPARENCY_SOURCE_ID,
  XAUT_TREASURY_ADDRESS,
} from "../safety-score-v9-xaut-supply-attribution-contract";

function fixedInput(dexLiqMap: Record<string, DexLiquidityData> = {}) {
  return makeV9RegistryFixedInput({
    captureKind: "public-reconstruction",
    sourceGeneration: "fixture-generation",
    redemptionStale: false,
    resolvedBlacklistStatuses: {
      "usdt-tether": true,
      "usdc-circle": true,
    },
    dexLiqMap,
  });
}

function withoutBaseInputGenerationId<T extends { baseInputGenerationId: string }>(input: T) {
  const { baseInputGenerationId: _baseInputGenerationId, ...legacy } = input;
  return legacy;
}

function wmSupplyAttribution(input: {
  aggregateSupplyUsd: number;
  registryFingerprint: string;
  clockSec: number;
}) {
  const inventory = buildReviewedDeploymentRouteInventory("wm-m0");
  if (!inventory) throw new Error("Missing wM route inventory");
  const observations: ReviewedDeploymentSupplyObservation[] = inventory.routes.map((route, index) => {
    const identity = expectedWmDeploymentIdentity(route.routeId);
    if (!identity) throw new Error(`Missing wM identity ${route.routeId}`);
    const common = {
      routeId: route.routeId,
      chainId: route.chainId,
      contractAddress: route.contractAddress,
      decimals: route.decimals,
      rawSupply: route.chainId === "ethereum" ? "86712798085682" : route.chainId === "solana" ? "247794997129" : "1",
      blockNumberOrSlot: (25_000_000 + index).toString(),
      blockTimeSec:
        route.chainId === "solana"
          ? input.clockSec + 5
          : input.clockSec - 10 + index,
    };
    return identity.runtime === "evm"
      ? {
          ...common,
          blockHash: `0x${(index + 1).toString(16).repeat(64)}`,
          runtimeCodeSha256: identity.runtimeCodeSha256,
          implementationAddress: identity.implementationAddress,
          implementationCodeSha256: identity.implementationCodeSha256,
          underlyingTokenAddress: identity.underlyingTokenAddress,
          controllerAddress: identity.controllerAddress,
        }
      : {
          ...common,
          blockHash: "B".repeat(44),
          programOwner: identity.programOwner,
          mintAuthority: identity.mintAuthority,
          controllerAddress: identity.controllerAddress,
          controllerProgramOwner: identity.controllerProgramOwner,
        };
  });
  const attribution = deriveReviewedDeploymentUnitPartition({
    assetId: "wm-m0",
    aggregateSupplyUsd: input.aggregateSupplyUsd,
    registryFingerprint: input.registryFingerprint,
    scoringClockSec: input.clockSec,
    observations,
  });
  if (!attribution) throw new Error("Could not derive wM attribution fixture");
  return attribution;
}

function route(routeId: string, commonModeKeys: string[], assetKeys: string[]): ExitRouteObservation {
  return {
    routeId,
    routeFamily: "dex-amm",
    scope: { kind: "chain-contract", chain: "solana", contractOrPoolId: routeId, protocol: "test" },
    requestedNotionalUsd: 100_000,
    settlementHorizonSec: 300,
    maxCostBps: 200,
    executableUsd: 50_000,
    completionRatio: 0.5,
    output: { kind: "collateral", assetKeys },
    evidenceKind: "reserve-based-amm-simulation",
    confidence: "high",
    scoreEligible: true,
    observedAt: 1_783_891_100,
    freshnessSeconds: 100,
    commonModeKeys,
    capacityCurve: [
      { requestedNotionalUsd: 1_000_000, maxCostBps: 200, executableUsd: 50_000, completionRatio: 0.05 },
      { requestedNotionalUsd: 100_000, maxCostBps: 200, executableUsd: 50_000, completionRatio: 0.5 },
    ],
  };
}

function redemptionRoute(routeId: string, commonModeKeys: string[], assetKeys: string[]): ExitRouteObservation {
  return {
    ...route(routeId, commonModeKeys, assetKeys),
    routeFamily: "issuer-redemption",
    scope: { kind: "issuer", issuerId: "fixture-issuer" },
    evidenceKind: "documented-terms",
  };
}

function redemptionEntry(
  exitRouteObservations: ExitRouteObservation[],
  methodologyVersion = "4.08",
): RedemptionBackstopEntry {
  return {
    stablecoinId: "fixture-coin",
    score: 88,
    dexLiquidityScore: 29,
    accessScore: 100,
    settlementScore: 100,
    executionCertaintyScore: 80,
    capacityScore: 100,
    outputAssetQualityScore: 80,
    costScore: 40,
    routeFamily: "basket-redeem",
    accessModel: "permissionless-onchain",
    settlementModel: "atomic",
    executionModel: "deterministic-basket",
    outputAssetType: "stable-basket",
    provider: "fixture",
    sourceMode: "estimated",
    resolutionState: "resolved",
    routeStatus: "open",
    routeStatusSource: "static-config",
    holderEligibility: "unknown",
    capacityConfidence: "documented-bound",
    capacitySemantics: "immediate-bounded",
    capacityProfile: {
      scoringHorizon: "immediate",
      capacityProfileConfidence: "documented-bound",
      exitRouteObservations,
    },
    feeConfidence: "undisclosed-reviewed",
    feeModelKind: "documented-variable",
    modelConfidence: "medium",
    immediateCapacityUsd: 10_000_000,
    immediateCapacityRatio: 0.5,
    feeBps: null,
    queueEnabled: false,
    methodologyVersion,
    updatedAt: 1_783_891_100,
    capsApplied: [],
    notes: [],
  };
}

function dexRow(exitRouteObservations: ExitRouteObservation[]): DexLiquidityData {
  return {
    totalTvlUsd: 1,
    totalVolume24hUsd: 1,
    totalVolume7dUsd: 1,
    poolCount: 1,
    pairCount: 1,
    chainCount: 1,
    protocolTvl: {},
    chainTvl: {},
    topPools: [],
    liquidityScore: 50,
    concentrationHhi: null,
    depthStability: null,
    tvlChange24h: null,
    tvlChange7d: null,
    updatedAt: 1_783_891_100,
    dexPriceUsd: null,
    dexDeviationBps: null,
    priceSourceCount: null,
    priceSourceTvl: null,
    priceSources: null,
    effectiveTvlUsd: 1,
    avgPoolStress: null,
    weightedBalanceRatio: null,
    organicFraction: null,
    durabilityScore: null,
    coverageClass: "primary",
    coverageConfidence: 1,
    liquidityEvidenceClass: "measured",
    hasMeasuredLiquidityEvidence: true,
    trendworthy: true,
    sourceMix: {},
    balanceMeasuredTvlUsd: 1,
    organicMeasuredTvlUsd: 1,
    scoreComponents: null,
    lockedLiquidityPct: null,
    methodologyVersion: "fixture",
    exitRouteObservations,
  };
}

const exactFixedInput = makeV9RegistryFixedInput;

describe("retained v3 fixed report-card input", () => {
  it("persists V9-only legacy supply attribution without changing the base identity", async () => {
    const assetId = "usdt-tether";
    const aggregateSupplyUsd = 2_480_000_000;
    const aggregateInput = normalizeFixedInput(
      withoutBaseInputGenerationId({
        ...exactFixedInput(),
        aggregateCirculatingById: {
          [assetId]: {
            circulating: { peggedUSD: aggregateSupplyUsd },
            observedAtSec: 1_783_891_200,
          },
        },
      }),
    );
    const attributedInput = normalizeFixedInput({
      ...aggregateInput,
      safetyScoreV9SupplyAttributionById: {
        [assetId]: {
          model: "canonical-lock-mint-partition-v1",
          observedAtSec: 1_783_891_200,
          currentSupplyUsdByChain: {
            Tron: 104_122_040.252,
            Ethereum: aggregateSupplyUsd - 104_122_040.252,
          },
        },
      },
    });

    expect(attributedInput.baseInputGenerationId).toBe(aggregateInput.baseInputGenerationId);
    expect(safetyScoreV9ChainSupplySourceGenerationId(attributedInput)).not.toBe(
      safetyScoreV9ChainSupplySourceGenerationId(aggregateInput),
    );
    expect(Object.keys(attributedInput.chainCirculatingById[assetId] ?? {})).toEqual([]);

    const v8Entry = await buildReportCardsFixedInputCacheEntry(attributedInput);
    const v8RoundTrip = await parseReportCardsFixedInputCacheValue(v8Entry.value);
    expect(v8RoundTrip.safetyScoreV9SupplyAttributionById).toEqual({});

    expect(() =>
      normalizeFixedInput({
        ...attributedInput,
        safetyScoreV9SupplyAttributionById: {
          [assetId]: {
            ...attributedInput.safetyScoreV9SupplyAttributionById[assetId]!,
            currentSupplyUsdByChain: {
              Ethereum: 1,
              Tron: 1,
            },
          },
        },
      }),
    ).toThrow("does not conserve aggregate circulating USD");
  });

  it("rejects legacy XAUT V1 attribution packets", () => {
    const aggregateSupplyUsd = 2_480_000_000;
    const aggregateInput = normalizeFixedInput(
      withoutBaseInputGenerationId({
        ...exactFixedInput(),
        aggregateCirculatingById: {
          [XAUT_ASSET_ID]: {
            circulating: { peggedGOLD: aggregateSupplyUsd },
            observedAtSec: 1_783_891_200,
          },
        },
      }),
    );

    expect(() =>
      normalizeFixedInput({
        ...aggregateInput,
        safetyScoreV9SupplyAttributionById: {
          [XAUT_ASSET_ID]: {
            model: "canonical-lock-mint-partition-v1",
            observedAtSec: 1_783_891_200,
            currentSupplyUsdByChain: {
              Ethereum: aggregateSupplyUsd - 104_122_040.252,
              "XAUt0 lock-mint pool": 104_122_040.252,
            },
          },
        },
      }),
    ).toThrow(
      "Legacy XAUT lock/mint attribution is no longer admissible; a reconciled V2 packet is required",
    );
  });

  it("validates and round-trips the identity-bound XAUT representation group", async () => {
    const aggregateSupplyUsd = 2_480_000_000;
    const aggregateInput = normalizeFixedInput(
      withoutBaseInputGenerationId({
        ...exactFixedInput(),
        aggregateCirculatingById: {
          "xaut-tether": {
            circulating: { peggedGOLD: aggregateSupplyUsd },
            observedAtSec: 1_783_891_100,
          },
        },
      }),
    );
    const attribution =
      deriveXautRepresentationGroupSupplyAttribution({
        aggregateSupplyUsd,
        registryFingerprint: aggregateInput.registryFingerprint,
        scoringClockSec: aggregateInput.clockSec,
        observation: {
          chainId: "ethereum",
          canonicalTokenAddress: XAUT_CANONICAL_TOKEN_ADDRESS,
          adapterAddress: XAUT0_ADAPTER_ADDRESS,
          decimals: 6,
          canonicalTotalSupplyRaw: "707747089000",
          treasuryAddress: XAUT_TREASURY_ADDRESS,
          treasuryBalanceRaw: "94923429468",
          adapterLockedSupplyRaw: "29720802896",
          blockNumber: 25_601_844,
          blockTimeSec: aggregateInput.clockSec - 100,
          blockHash: `0x${"ab".repeat(32)}`,
          canonicalRuntimeCodeSha256:
            XAUT_CANONICAL_RUNTIME_CODE_SHA256,
          canonicalImplementationAddress:
            XAUT_CANONICAL_IMPLEMENTATION_ADDRESS,
          canonicalImplementationCodeSha256:
            XAUT_CANONICAL_IMPLEMENTATION_CODE_SHA256,
          adapterRuntimeCodeSha256:
            XAUT0_ADAPTER_RUNTIME_CODE_SHA256,
          adapterImplementationAddress:
            XAUT0_ADAPTER_IMPLEMENTATION_ADDRESS,
          adapterImplementationCodeSha256:
            XAUT0_ADAPTER_IMPLEMENTATION_CODE_SHA256,
          adapterTokenAddress: XAUT_CANONICAL_TOKEN_ADDRESS,
          adapterEndpointAddress:
            XAUT0_LAYERZERO_ENDPOINT_ADDRESS,
          disclosure: {
            sourceId: XAUT_TRANSPARENCY_SOURCE_ID,
            sourceConfigDigest:
              buildXautTransparencySource()!.configDigest,
            sourceTimestampSec: aggregateInput.clockSec - 200,
            responseSha256: "c".repeat(64),
            totalAuthorizedRaw: "707747089000",
            notIssuedRaw: "94923429468",
            quarantinedRaw: "0",
          },
        },
      });
    expect(attribution).not.toBeNull();

    const attributedInput = normalizeFixedInput({
      ...aggregateInput,
      safetyScoreV9SupplyAttributionById: {
        "xaut-tether": attribution!,
      },
    });
    expect(
      attributedInput.safetyScoreV9SupplyAttributionById[
        "xaut-tether"
      ],
    ).toEqual(attribution);

    expect(() =>
      normalizeFixedInput({
        ...attributedInput,
        safetyScoreV9SupplyAttributionById: {
          "xaut-tether": {
            ...attribution!,
            routeInventoryDigest: "0".repeat(64),
          },
        },
      }),
    ).toThrow("route inventory mismatch");

    expect(() =>
      normalizeFixedInput({
        ...aggregateInput,
        aggregateCirculatingById: {
          ...aggregateInput.aggregateCirculatingById,
          "usdc-circle": {
            circulating: { peggedUSD: aggregateSupplyUsd },
            observedAtSec: 1_783_891_100,
          },
        },
        safetyScoreV9SupplyAttributionById: {
          "usdc-circle": attribution!,
        },
      }),
    ).toThrow(
      "V9 supply attribution key usdc-circle does not match packet asset xaut-tether",
    );
  });

  it("round-trips exact wM route attribution only through the V9 envelope", async () => {
    const aggregateSupplyUsd = 87_020_618.58982982;
    const aggregateInput = normalizeFixedInput(
      withoutBaseInputGenerationId({
        ...exactFixedInput(),
        aggregateCirculatingById: {
          "wm-m0": {
            circulating: { peggedUSD: aggregateSupplyUsd },
            observedAtSec: 1_783_891_190,
          },
        },
      }),
    );
    const attribution = wmSupplyAttribution({
      aggregateSupplyUsd,
      registryFingerprint: aggregateInput.registryFingerprint,
      clockSec: aggregateInput.clockSec,
    });
    const attributedInput = normalizeFixedInput({
      ...aggregateInput,
      safetyScoreV9SupplyAttributionById: {
        "wm-m0": {
          ...attribution,
          deployments: [...attribution.deployments].reverse(),
        },
      },
    });

    expect(attributedInput.baseInputGenerationId).toBe(aggregateInput.baseInputGenerationId);
    expect(safetyScoreV9ChainSupplySourceGenerationId(attributedInput)).not.toBe(
      safetyScoreV9ChainSupplySourceGenerationId(aggregateInput),
    );
    const direct = attributedInput.safetyScoreV9SupplyAttributionById["wm-m0"]!;
    expect(direct.model).toBe("reviewed-deployment-unit-partition-v1");
    if (direct.model !== "reviewed-deployment-unit-partition-v1") {
      throw new Error("Expected direct deployment attribution");
    }
    expect(direct.observedAtSec).toBe(aggregateInput.clockSec + 5);
    expect(direct.deployments.map((row) => row.routeId)).toEqual(
      [...direct.deployments.map((row) => row.routeId)].sort(),
    );
    expect(direct.deployments.reduce((sum, row) => sum + row.currentSupplyUsd, 0)).toBe(
      aggregateSupplyUsd,
    );

    const v8Entry = await buildReportCardsFixedInputCacheEntry(attributedInput);
    const v8RoundTrip = await parseReportCardsFixedInputCacheValue(v8Entry.value);
    expect(v8RoundTrip.safetyScoreV9SupplyAttributionById).toEqual({});

    expect(() =>
      normalizeFixedInput({
        ...attributedInput,
        safetyScoreV9SupplyAttributionById: {
          "wm-m0": {
            ...direct,
            routeInventoryDigest: "0".repeat(64),
          },
        },
      }),
    ).toThrow("route inventory mismatch");
    expect(() =>
      normalizeFixedInput({
        ...attributedInput,
        safetyScoreV9SupplyAttributionById: {
          "wm-m0": {
            ...direct,
            deployments: direct.deployments.slice(1),
          },
        },
      }),
    ).toThrow("route count mismatch");
  });

  it("normalizes equivalent record insertion orders", () => {
    const input = fixedInput();
    const permuted = {
      ...input,
      resolvedBlacklistStatuses: Object.fromEntries(Object.entries(input.resolvedBlacklistStatuses).reverse()),
    };
    expect(JSON.stringify(normalizeFixedInput(permuted))).toBe(JSON.stringify(normalizeFixedInput(input)));
    expect(normalizeFixedInput(permuted).baseInputGenerationId).toBe(
      normalizeFixedInput(input).baseInputGenerationId,
    );
  });

  it("normalizes nested route, key, output, and capacity-curve ordering", () => {
    const first = route("dex:a", ["protocol:test", "chain:solana"], ["solana:MintB", "solana:MintA"]);
    const second = route("dex:b", ["chain:solana", "protocol:test"], ["solana:MintA"]);
    const left = normalizeFixedInput(fixedInput({ coin: dexRow([second, first]) }));
    const right = normalizeFixedInput(
      fixedInput({
        coin: dexRow([
          {
            ...first,
            commonModeKeys: [...first.commonModeKeys].reverse(),
            capacityCurve: [...first.capacityCurve!].reverse(),
          },
          second,
        ]),
      }),
    );

    expect(JSON.stringify(left)).toBe(JSON.stringify(right));
  });

  it("keeps canonical identity exports and digest vectors stable", () => {
    expect(computeDexLiquidityPayloadFingerprint).toBe(computeSharedDexLiquidityPayloadFingerprint);
    expect(computeRedemptionPayloadFingerprint).toBe(computeSharedRedemptionPayloadFingerprint);
    expect(computeReportCardsRegistryFingerprint).toBe(computeSharedReportCardsRegistryFingerprint);
    expect(computeDexLiquidityPayloadFingerprint({}, "dex-test")).toBe(
      "eb15cc883287b8a986bb2aa451706ec9f882059876b78aef35c9c0c0ab071937",
    );
    expect(computeRedemptionPayloadFingerprint({}, "redemption-test")).toBe(
      "e4410ccc7fda2f9d507e84f421d1a1ff937353ca153d930b3089ad7c5b9f93e3",
    );
  });

  it("normalizes redemption payload identity and producer methodology versions", () => {
    const first = redemptionRoute("redeem:a", ["issuer:test", "rail:fiat"], ["USD:b", "USD:a"]);
    const second = redemptionRoute("redeem:b", ["rail:fiat", "issuer:test"], ["USD:a"]);
    const left = {
      zeta: redemptionEntry([second, first], "4.08"),
      alpha: redemptionEntry([], "4.07"),
    };
    const right = {
      alpha: redemptionEntry([], "4.07"),
      zeta: redemptionEntry([
        {
          ...first,
          commonModeKeys: [...first.commonModeKeys].reverse(),
          capacityCurve: [...first.capacityCurve!].reverse(),
        },
        second,
      ]),
    };

    expect(normalizeFixedRedemptionBackstopMap(left)).toEqual(normalizeFixedRedemptionBackstopMap(right));
    expect(computeRedemptionPayloadFingerprint(left, "redemption:test")).toBe(
      computeRedemptionPayloadFingerprint(right, "redemption:test"),
    );
    expect(
      projectReportCardsFixedInputMethodologyVersions({
        methodologyVersion: "8.17",
        dexLiqMap: {
          first: { methodologyVersion: "5.91" },
          duplicate: { methodologyVersion: "5.91" },
          older: { methodologyVersion: "5.9" },
          absent: {},
        },
        pegDataById: { current: { methodologyVersion: "3.04" }, old: { methodologyVersion: "3.03" } },
        redemptionBackstopMap: left,
      }),
    ).toEqual({
      safetyScore: "8.17",
      dexLiquidity: ["5.9", "5.91"],
      pegScore: ["3.03", "3.04"],
      redemptionBackstop: ["4.07", "4.08"],
    });
    expect(
      normalizeReportCardsFixedInputMethodologyVersions({
        safetyScore: "8.17",
        dexLiquidity: ["5.91", "5.9", "5.91"],
        pegScore: ["3.04", "3.03"],
        redemptionBackstop: ["4.08", "4.07"],
      }),
    ).toEqual({
      safetyScore: "8.17",
      dexLiquidity: ["5.9", "5.91"],
      pegScore: ["3.03", "3.04"],
      redemptionBackstop: ["4.07", "4.08"],
    });
  });

  it("round-trips the exact publication input through its bounded checksum envelope", async () => {
    const input = exactFixedInput();
    expect(input.baseInputGenerationId).toMatch(/^report-cards-input:v1:[a-f0-9]{64}$/);
    const entry = await buildReportCardsFixedInputCacheEntry(input);
    expect(entry.storedBytes).toBeLessThanOrEqual(1_900_000);
    await expect(parseReportCardsFixedInputCacheValue(entry.value)).resolves.toEqual(input);

    const tampered = JSON.parse(entry.value) as { payloadSha256: string };
    tampered.payloadSha256 = "0".repeat(64);
    await expect(parseReportCardsFixedInputCacheValue(JSON.stringify(tampered))).rejects.toThrow("checksum mismatch");

    const corruptLength = JSON.parse(entry.value) as { uncompressedBytes: number };
    corruptLength.uncompressedBytes = 1;
    await expect(parseReportCardsFixedInputCacheValue(JSON.stringify(corruptLength))).rejects.toThrow(
      "exceeds its declared uncompressed byte length",
    );
  });

  it("binds the fixed-input envelope to its upstream publication identity", async () => {
    const input = exactFixedInput();
    const identity = {
      model: "v8" as const,
      schemaVersion: 1 as const,
      methodologyVersion: input.methodologyVersion,
      evaluationBuildDigest: "a".repeat(64),
      baseInputGenerationId: input.baseInputGenerationId,
      publicationGenerationId: input.sourceGeneration,
    };
    const entry = await buildReportCardsFixedInputCacheEntry(input, identity);

    await expect(parseReportCardsFixedInputCacheArtifact(entry.value)).resolves.toEqual({
      input,
      safetyScoreIdentity: identity,
    });
    await expect(
      buildReportCardsFixedInputCacheEntry(input, {
        ...identity,
        publicationGenerationId: "different-publication",
      }),
    ).rejects.toThrow(/does not match/);
  });

  it("rejects a stale base-input generation instead of silently rebinding it", () => {
    const input = exactFixedInput();
    const firstId = input.activeAssetIds[0]!;

    expect(() =>
      normalizeFixedInput({
        ...input,
        activeDepegPeakBpsById: { ...input.activeDepegPeakBpsById, [firstId]: 25 },
      }),
    ).toThrow("Fixed input base generation");
  });

  it("binds exact producer methodology declarations to score-bearing rows", () => {
    const declaredMismatch = structuredClone(exactFixedInput());
    declaredMismatch.inputMethodologyVersions.dexLiquidity = ["forged-methodology"];
    expect(() => normalizeFixedInput(declaredMismatch)).toThrow(
      "producer methodology versions do not match its score-bearing payload rows",
    );

    const rowMismatch = structuredClone(exactFixedInput());
    const firstDexId = rowMismatch.activeAssetIds[0]!;
    rowMismatch.dexLiqMap[firstDexId]!.methodologyVersion = "different-row-methodology";
    rowMismatch.dexPayloadFingerprint = computeDexLiquidityPayloadFingerprint(
      rowMismatch.dexLiqMap,
      rowMismatch.dexGenerationId,
    );
    expect(() => normalizeFixedInput(rowMismatch)).toThrow(
      "producer methodology versions do not match its score-bearing payload rows",
    );

    const missingRowMethodology = structuredClone(exactFixedInput());
    delete missingRowMethodology.dexLiqMap[firstDexId]!.methodologyVersion;
    expect(() => normalizeFixedInput(missingRowMethodology)).toThrow("DEX rows lack producer methodology");
  });

  it("never persists a public fanout reconstruction as exact P0c evidence", async () => {
    await expect(buildReportCardsFixedInputCacheEntry(fixedInput())).rejects.toThrow("Only exact publication inputs");
  });

  it("rejects redemption-family observations from fixed DEX inputs", () => {
    const current = fixedInput({ coin: dexRow([]) });
    const misrouted = {
      ...route("redeem:misrouted", ["issuer:test"], []),
      routeFamily: "issuer-redemption",
      scope: { kind: "issuer", issuerId: "issuer" },
      output: { kind: "fiat", currency: "USD" },
      evidenceKind: "documented-terms",
    };

    expect(() =>
      normalizeFixedInput({
        ...current,
        dexLiqMap: {
          coin: {
            ...current.dexLiqMap.coin,
            exitRouteObservations: [misrouted],
          },
        },
      }),
    ).toThrow();
  });

  it("rejects incomplete or mixed-generation exact active DEX rows", () => {
    const complete = exactFixedInput();
    const [removedId] = complete.activeAssetIds;
    const incompleteRows = { ...complete.dexLiqMap };
    delete incompleteRows[removedId!];
    expect(() => normalizeFixedInput({ ...complete, dexLiqMap: incompleteRows })).toThrow(
      "Exact fixed input DEX active rows mismatch",
    );

    const [changedId] = complete.activeAssetIds;
    const mixedRows = {
      ...complete.dexLiqMap,
      [changedId!]: { ...complete.dexLiqMap[changedId!]!, updatedAt: complete.clockSec },
    };
    expect(() => normalizeFixedInput(withoutBaseInputGenerationId({ ...complete, dexLiqMap: mixedRows }))).toThrow(
      "DEX rows do not match the DEX freshness generation",
    );
  });

  it("rejects future-dated exact producer lanes instead of accepting age zero", () => {
    const complete = exactFixedInput();
    const futureUpdatedAt = complete.clockSec + 1;
    const futureDexRows = Object.fromEntries(
      Object.entries(complete.dexLiqMap).map(([id, row]) => [id, { ...row, updatedAt: futureUpdatedAt }]),
    );
    expect(() =>
      normalizeFixedInput(
        withoutBaseInputGenerationId({
          ...complete,
          dexGenerationId: `dex-liquidity-${futureUpdatedAt}`,
          dexLiqMap: futureDexRows,
          liquidityStale: true,
          inputFreshness: {
            ...complete.inputFreshness,
            dexLiquidity: { updatedAt: futureUpdatedAt, ageSeconds: 0, stale: true },
          },
        }),
      ),
    ).toThrow("producer timestamp 1783891201 is later than scoring clock 1783891200");

    expect(() =>
      normalizeFixedInput(
        withoutBaseInputGenerationId({
          ...complete,
          inputFreshness: {
            ...complete.inputFreshness,
            redemptionBackstops: { updatedAt: futureUpdatedAt, ageSeconds: null, stale: true },
          },
        }),
      ),
    ).toThrow("producer timestamp 1783891201 is later than scoring clock 1783891200");
  });
});
