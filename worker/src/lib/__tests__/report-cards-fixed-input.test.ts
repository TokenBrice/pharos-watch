import { describe, expect, it } from "vitest";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { DexLiquidityData, ExitRouteObservation } from "@shared/types/market";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import {
  computeDexLiquidityPayloadFingerprint as computeSharedDexLiquidityPayloadFingerprint,
  computeRedemptionPayloadFingerprint as computeSharedRedemptionPayloadFingerprint,
  computeReportCardsReplayPayloadFingerprint as computeSharedReportCardsReplayPayloadFingerprint,
  computeReportCardsRegistryFingerprint as computeSharedReportCardsRegistryFingerprint,
  normalizeFixedRedemptionBackstopMap,
  normalizeReportCardsReplayPayload as normalizeSharedReportCardsReplayPayload,
  normalizeReportCardsFixedInputMethodologyVersions,
  projectReportCardsFixedInputMethodologyVersions,
} from "@shared/lib/report-cards-fixed-input-identity";
import {
  buildReportCardsSnapshotFromFixedInput,
  buildReportCardsFixedInputCacheEntry,
  buildSafetyScoreV9FixedInputCacheEntry,
  computeDexLiquidityPayloadFingerprint,
  computeRedemptionPayloadFingerprint,
  computeReportCardsReplayPayloadFingerprint,
  computeReportCardsRegistryFingerprint,
  createReportCardsFixedInput,
  normalizeFixedInput,
  normalizeReportCardsReplayPayload,
  parseReportCardsFixedInputCacheArtifact,
  parseReportCardsFixedInputCacheValue,
  serializeNormalizedReportCardsReplay,
} from "../report-cards-fixed-input";
import { safetyScoreV9ChainSupplySourceGenerationId } from "../safety-score-v9-supply-attribution";

function fixedInput(dexLiqMap: Record<string, DexLiquidityData> = {}) {
  const dexUpdatedAt = Object.values(dexLiqMap)[0]?.updatedAt ?? 1_783_891_100;
  return createReportCardsFixedInput({
    captureKind: "public-reconstruction",
    capturedAt: "2026-07-12T22:00:00.000Z",
    sourceGeneration: "fixture-generation",
    dexGenerationId: `dex-liquidity-${dexUpdatedAt}`,
    redemptionGenerationId: "redemption-backstops-unavailable",
    registryRevision: "fixture-revision",
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    clockSec: 1_783_891_200,
    updatedAt: 1_783_891_200,
    liquidityStale: false,
    redemptionStale: false,
    inputFreshness: {
      dexLiquidity: { updatedAt: dexUpdatedAt, ageSeconds: 100, stale: false },
      redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
    },
    pegDataById: {},
    activeDepegPeakBpsById: {},
    dexLiqMap,
    redemptionBackstopMap: {},
    bluechipMap: {},
    resolvedBlacklistStatuses: {
      "usdt-tether": true,
      "usdc-circle": true,
    },
    liveReserveMap: {},
    liveReserveProvenanceMap: {},
    chainCirculatingById: {},
    dexDeploymentSupplyCoverageById: {},
    collateralDriftCoins: [],
    liveToFallbackCoins: [],
  });
}

function withoutBaseInputGenerationId<T extends { baseInputGenerationId: string }>(input: T) {
  const { baseInputGenerationId: _baseInputGenerationId, ...legacy } = input;
  return legacy;
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
    effectiveExitScore: 91,
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

function exactFixedInput() {
  const dexUpdatedAt = 1_783_891_100;
  return createReportCardsFixedInput({
    captureKind: "exact-publication-inputs",
    capturedAt: "2026-07-12T22:00:00.000Z",
    sourceGeneration: `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:1783891200`,
    dexGenerationId: `dex-liquidity-${dexUpdatedAt}`,
    redemptionGenerationId: "redemption-backstops-unavailable",
    registryRevision: "fixture-revision",
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    clockSec: 1_783_891_200,
    updatedAt: 1_783_891_200,
    liquidityStale: false,
    redemptionStale: true,
    inputFreshness: {
      dexLiquidity: { updatedAt: dexUpdatedAt, ageSeconds: 100, stale: false },
      redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
    },
    pegDataById: {},
    activeDepegPeakBpsById: {},
    dexLiqMap: Object.fromEntries(
      ACTIVE_STABLECOINS.map((coin) => [
        coin.id,
        {
          liquidityScore: null,
          concentrationHhi: null,
          poolCount: 0,
          chainCount: 0,
          methodologyVersion: "fixture",
          updatedAt: dexUpdatedAt,
        },
      ]),
    ),
    redemptionBackstopMap: {},
    bluechipMap: {},
    resolvedBlacklistStatuses: Object.fromEntries(ACTIVE_STABLECOINS.map((coin) => [coin.id, false])),
    liveReserveMap: {},
    liveReserveProvenanceMap: {},
    chainCirculatingById: {},
    dexDeploymentSupplyCoverageById: {},
    collateralDriftCoins: [],
    liveToFallbackCoins: [],
  });
}

describe("fixed report-card input replay", () => {
  it("replays byte-stably without network, D1, or wall-clock reads", () => {
    const input = fixedInput();
    const snapshot = buildReportCardsSnapshotFromFixedInput(input);
    const first = serializeNormalizedReportCardsReplay(snapshot);
    const second = serializeNormalizedReportCardsReplay(buildReportCardsSnapshotFromFixedInput(input));
    expect(first).toBe(second);
    expect(first).toBe(`${JSON.stringify(normalizeSharedReportCardsReplayPayload(snapshot), null, 2)}\n`);
    expect(JSON.parse(first).cards.length).toBeGreaterThan(300);
  });

  it("keeps the V8 replay byte-identical when measured points add realized cost", () => {
    const legacyRoute = {
      ...route("dex:usdt:measured", ["chain:ethereum"], ["ethereum:0xa0b8"]),
      evidenceKind: "measured-executable-depth" as const,
    };
    const realizedRoute = {
      ...legacyRoute,
      capacityCurve: legacyRoute.capacityCurve?.map((point) => ({
        ...point,
        executionCostBps: 20,
      })),
    };
    const legacy = fixedInput({ "usdt-tether": dexRow([legacyRoute]) });
    const realized = fixedInput({ "usdt-tether": dexRow([realizedRoute]) });

    expect(
      serializeNormalizedReportCardsReplay(buildReportCardsSnapshotFromFixedInput(realized)),
    ).toBe(
      serializeNormalizedReportCardsReplay(buildReportCardsSnapshotFromFixedInput(legacy)),
    );
  });

  it("persists V9-only supply attribution without changing V8 replay or base identity", async () => {
    const aggregateSupplyUsd = 2_480_000_000;
    const aggregateInput = normalizeFixedInput(
      withoutBaseInputGenerationId({
        ...exactFixedInput(),
        aggregateCirculatingById: {
          "xaut-tether": {
            circulating: { peggedGOLD: aggregateSupplyUsd },
            observedAtSec: 1_783_891_200,
          },
        },
      }),
    );
    const attributedInput = normalizeFixedInput({
      ...aggregateInput,
      safetyScoreV9SupplyAttributionById: {
        "xaut-tether": {
          model: "canonical-lock-mint-partition-v1",
          observedAtSec: 1_783_891_200,
          currentSupplyUsdByChain: {
            "XAUt0 lock-mint pool": 104_122_040.252,
            Ethereum: aggregateSupplyUsd - 104_122_040.252,
          },
        },
      },
    });

    expect(attributedInput.baseInputGenerationId).toBe(aggregateInput.baseInputGenerationId);
    expect(safetyScoreV9ChainSupplySourceGenerationId(attributedInput)).not.toBe(
      safetyScoreV9ChainSupplySourceGenerationId(aggregateInput),
    );
    expect(serializeNormalizedReportCardsReplay(buildReportCardsSnapshotFromFixedInput(attributedInput))).toBe(
      serializeNormalizedReportCardsReplay(buildReportCardsSnapshotFromFixedInput(aggregateInput)),
    );
    expect(Object.keys(attributedInput.chainCirculatingById["xaut-tether"] ?? {})).toEqual([]);

    const v8Entry = await buildReportCardsFixedInputCacheEntry(attributedInput);
    const v8RoundTrip = await parseReportCardsFixedInputCacheValue(v8Entry.value);
    expect(v8RoundTrip.safetyScoreV9SupplyAttributionById).toEqual({});
    const v9Entry = await buildSafetyScoreV9FixedInputCacheEntry(attributedInput, {
      model: "v8",
      schemaVersion: 1,
      methodologyVersion: attributedInput.methodologyVersion,
      evaluationBuildDigest: "a".repeat(64),
      baseInputGenerationId: attributedInput.baseInputGenerationId,
      publicationGenerationId: attributedInput.sourceGeneration,
    });
    const v9RoundTrip = await parseReportCardsFixedInputCacheValue(v9Entry.value);
    expect(v9RoundTrip.safetyScoreV9SupplyAttributionById).toEqual(
      attributedInput.safetyScoreV9SupplyAttributionById,
    );

    expect(() =>
      normalizeFixedInput({
        ...attributedInput,
        safetyScoreV9SupplyAttributionById: {
          "xaut-tether": {
            ...attributedInput.safetyScoreV9SupplyAttributionById["xaut-tether"]!,
            currentSupplyUsdByChain: {
              Ethereum: 1,
              "XAUt0 lock-mint pool": 1,
            },
          },
        },
      }),
    ).toThrow("does not conserve aggregate circulating USD");
  });

  it("normalizes equivalent record insertion orders", () => {
    const input = fixedInput();
    const permuted = {
      ...input,
      resolvedBlacklistStatuses: Object.fromEntries(Object.entries(input.resolvedBlacklistStatuses).reverse()),
    };
    expect(JSON.stringify(normalizeFixedInput(permuted))).toBe(JSON.stringify(normalizeFixedInput(input)));
    expect(serializeNormalizedReportCardsReplay(buildReportCardsSnapshotFromFixedInput(permuted))).toBe(
      serializeNormalizedReportCardsReplay(buildReportCardsSnapshotFromFixedInput(input)),
    );
  });

  it("rejects malformed inputs and unapproved methodology mismatches", () => {
    expect(() => buildReportCardsSnapshotFromFixedInput({ ...fixedInput(), clockSec: Number.NaN })).toThrow(
      "Malformed fixed report-card input",
    );
    const mismatched = { ...fixedInput(), methodologyVersion: "0.0" };
    expect(() => buildReportCardsSnapshotFromFixedInput(mismatched)).toThrow("does not match current");
    expect(() => buildReportCardsSnapshotFromFixedInput(mismatched, { allowMethodologyMismatch: true })).not.toThrow();

    const registryMismatched = withoutBaseInputGenerationId({
      ...fixedInput(),
      registryFingerprint: "0".repeat(64),
    });
    expect(() => buildReportCardsSnapshotFromFixedInput(registryMismatched)).toThrow("registry fingerprint");
    expect(() =>
      buildReportCardsSnapshotFromFixedInput(registryMismatched, { allowRegistryMismatch: true }),
    ).not.toThrow();

    expect(() =>
      buildReportCardsSnapshotFromFixedInput(
        withoutBaseInputGenerationId({ ...fixedInput(), dexPayloadFingerprint: "0".repeat(64) }),
      ),
    ).toThrow("DEX payload fingerprint");

    expect(() =>
      buildReportCardsSnapshotFromFixedInput(
        withoutBaseInputGenerationId({ ...fixedInput(), dexGenerationId: "different-generation" }),
      ),
    ).toThrow("DEX payload fingerprint");
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
    expect(computeReportCardsReplayPayloadFingerprint).toBe(computeSharedReportCardsReplayPayloadFingerprint);
    expect(computeReportCardsRegistryFingerprint).toBe(computeSharedReportCardsRegistryFingerprint);
    expect(normalizeReportCardsReplayPayload).toBe(normalizeSharedReportCardsReplayPayload);
    expect(computeDexLiquidityPayloadFingerprint({}, "dex-test")).toBe(
      "eb15cc883287b8a986bb2aa451706ec9f882059876b78aef35c9c0c0ab071937",
    );
    expect(computeRedemptionPayloadFingerprint({}, "redemption-test")).toBe(
      "e4410ccc7fda2f9d507e84f421d1a1ff937353ca153d930b3089ad7c5b9f93e3",
    );
    expect(
      computeReportCardsReplayPayloadFingerprint({
        cards: [],
        methodology: {
          version: "test",
          weights: {
            pegStability: 0.25,
            liquidity: 0.25,
            resilience: 0.2,
            decentralization: 0.15,
            dependencyRisk: 0.15,
          },
          pegMultiplierExponent: 1,
          thresholds: [],
        },
        dependencyGraph: { edges: [] },
        updatedAt: 1,
      }),
    ).toBe("d7af69822f28633a7d49c927604fbd7c83577cb9a330282a7e1aee85be5a8b63");
    const replay = buildReportCardsSnapshotFromFixedInput(fixedInput());
    expect(computeReportCardsReplayPayloadFingerprint(replay)).toMatch(/^[a-f0-9]{64}$/);
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
  });

  it("binds the canonical fixed-input envelope to the common V8 publication identity", async () => {
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
    const v9Entry = await buildSafetyScoreV9FixedInputCacheEntry(input, identity);

    await expect(parseReportCardsFixedInputCacheArtifact(entry.value)).resolves.toEqual({
      input,
      safetyScoreIdentity: identity,
    });
    expect(v9Entry.key).toBe("report-cards:v9-fixed-input:exact");
    expect(v9Entry.uncompressedBytes).toBeGreaterThan(entry.uncompressedBytes);
    await expect(parseReportCardsFixedInputCacheArtifact(v9Entry.value)).resolves.toEqual({
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

  it("migrates the legacy schema-v1 replay contract as an explicit reconstruction", () => {
    const current = fixedInput({ coin: dexRow([]) });
    const legacy = {
      schemaVersion: 1,
      capturedAt: current.capturedAt,
      sourceGeneration: current.sourceGeneration,
      registryRevision: current.registryRevision,
      methodologyVersion: current.methodologyVersion,
      clockSec: current.clockSec,
      updatedAt: current.updatedAt,
      liquidityStale: current.liquidityStale,
      redemptionStale: current.redemptionStale,
      inputFreshness: current.inputFreshness,
      pegDataById: current.pegDataById,
      activeDepegPeakBpsById: current.activeDepegPeakBpsById,
      dexLiqMap: { coin: dexRow([]) },
      redemptionBackstopMap: current.redemptionBackstopMap,
      bluechipMap: current.bluechipMap,
      resolvedBlacklistStatuses: current.resolvedBlacklistStatuses,
      liveReserveMap: current.liveReserveMap,
      liveReserveProvenanceMap: current.liveReserveProvenanceMap,
      chainCirculatingById: current.chainCirculatingById,
      dexDeploymentSupplyCoverageById: current.dexDeploymentSupplyCoverageById,
      collateralDriftCoins: current.collateralDriftCoins,
      liveToFallbackCoins: current.liveToFallbackCoins,
    };

    expect(normalizeFixedInput(legacy)).toMatchObject({
      schemaVersion: 3,
      captureKind: "public-reconstruction",
      dexGenerationId: "dex-liquidity-1783891100",
    });
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
