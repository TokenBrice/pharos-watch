import { afterEach, describe, expect, it, vi } from "vitest";
import { getEndpointRequiredKeyPlans } from "@shared/lib/api-endpoints";
import {
  normalizeAddressForChainlessLookup,
  normalizeDeploymentAddress,
  parseContractTuple,
  resolveDeploymentChainId,
} from "@shared/lib/deployment-resolver";
import { DDR_METHODOLOGY_VERSION, DDR_SNAPSHOT_CACHE_GENERATION } from "@shared/lib/methodology-versions/depeg-resolver";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { WORKER_TRACKED_STABLECOINS } from "@shared/lib/stablecoins/worker-runtime-registry";
import {
  ComplianceCoinResponseSchema,
  ComplianceListResponseSchema,
} from "@shared/types/compliance-api";
import { ResolveResponseSchema } from "@shared/types/resolve";
import { RiskCheckResponseSchema } from "@shared/types/risk-check";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { createEdgeCacheContext } from "../../handlers/http/edge-cache";
import { SAFETY_SCORE_V9_CACHE_KEYS } from "../../lib/safety-score-v9/publication-health";
import { makeReportCardsV9Response } from "../../test-helpers/report-cards-v9";
import { handleCompliance, handleComplianceCoin } from "../compliance";
import { handleResolve, resolveContractDeployment } from "../resolve";
import { handleRiskCheck } from "../risk-check";

const USDC_ETH = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDC_ETH_CHECKSUM = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT_ETH = "0xdac17f958d2ee523a2206206994597c13d831ec7";

function makeSafetyScoreCacheRows(nowSec: number, overrides?: { held?: boolean }) {
  const base = makeReportCardsV9Response();
  const publishedAtSec = nowSec - 60;
  const asOfSec = publishedAtSec - 10;
  const resultDigest = "a".repeat(64);
  const identity = {
    ...base.safetyScoreIdentity,
    publicationGenerationId: "v9:test-gen-1",
  };
  const storageIdentity = {
    candidateId: "candidate-v9.0",
    policyVersion: identity.methodologyVersion,
    publicationGenerationId: identity.publicationGenerationId,
    baseInputGenerationId: identity.baseInputGenerationId,
    factSetDigest: "d".repeat(64),
    policyId: identity.policyId,
    policyDigest: identity.policyDigest,
    evaluationBuildDigest: identity.evaluationBuildDigest,
    resultDigest,
  };
  const scoreIndex = {
    schemaVersion: 2,
    safetyScoreIdentity: identity,
    publicationResultDigest: resultDigest,
    asOfSec,
    publishedAtSec,
    expectedCount: 3,
    scores: {
      "usdc-circle": { score: 88, grade: "A-", ratingStatus: "rated", partialEvidence: null },
      "usdt-tether": {
        score: null,
        grade: null,
        ratingStatus: "pipeline-gap",
        partialEvidence: {
          reasonCode: "partial-evidence-pipeline-gap",
          excludedPillars: ["backing", "exit"],
          causes: ["A"],
        },
      },
      "dai-makerdao": { score: null, grade: "NR", ratingStatus: "not-rated", partialEvidence: null },
    },
  };
  const health = overrides?.held
    ? {
        schemaVersion: 2,
        status: "held",
        acceptedPublicationGenerationId: identity.publicationGenerationId,
        acceptedAtSec: publishedAtSec,
        attemptedAtSec: publishedAtSec + 30,
        heldSinceSec: publishedAtSec + 30,
        reasons: [{ code: "dex-stale" }],
      }
    : {
        schemaVersion: 2,
        status: "current",
        acceptedPublicationGenerationId: identity.publicationGenerationId,
        acceptedAtSec: publishedAtSec,
        attemptedAtSec: publishedAtSec,
        heldSinceSec: null,
        reasons: [],
      };
  const pillars = {
    publicationGenerationId: identity.publicationGenerationId,
    resultDigest,
    ratings: {
      "usdc-circle": {
        backing: { score: 91, grade: "A" },
        exit: { score: 94, grade: "A" },
        control: { score: 78, grade: "B+" },
      },
    },
  };
  return {
    score_index: stableJsonStringifyV1(scoreIndex),
    index_updated_at: publishedAtSec,
    health: stableJsonStringifyV1(health),
    health_updated_at: health.attemptedAtSec,
    publication_identity: JSON.stringify(storageIdentity),
    result_digest: resultDigest,
    publication_updated_at: publishedAtSec,
    pillar_ratings: JSON.stringify(pillars.ratings),
    identity,
    publishedAtSec,
  };
}

function makeValidRedemptionRow(stablecoinId: string, updatedAt: number) {
  return {
    stablecoin_id: stablecoinId,
    score: 92,
    dex_liquidity_score: 95,
    access_score: 90,
    settlement_score: 95,
    execution_certainty_score: 90,
    capacity_score: 95,
    output_asset_quality_score: 95,
    cost_score: 90,
    route_family: "offchain-issuer",
    access_model: "issuer-api",
    settlement_model: "same-day",
    execution_model: "deterministic-basket",
    output_asset_type: "stable-single",
    provider: "circle-mint",
    source_mode: "static",
    immediate_capacity_usd: 500_000_000,
    immediate_capacity_ratio: 0.02,
    fee_bps: 0,
    queue_enabled: 0,
    updated_at: updatedAt,
    methodology_version: "4.0",
    details_json: JSON.stringify({
      resolutionState: "resolved",
      capacityConfidence: "documented-bound",
      capacitySemantics: "immediate-bounded",
      feeConfidence: "fixed",
      feeModelKind: "fixed-bps",
      modelConfidence: "high",
      routeStatus: "open",
      routeStatusSource: "static-config",
      holderEligibility: "verified-customer",
    }),
    snapshot_run_id: "run-1",
  };
}

function buildRiskCheckMockDb(nowSec: number, options?: {
  heldSafety?: boolean;
  missingPegAnalytics?: boolean;
  malformedRedemptionCoinId?: string;
  activeDdrCoinId?: string;
  ddrErratum?: boolean;
}) {
  const safetyRow = makeSafetyScoreCacheRows(nowSec, { held: options?.heldSafety });
  const freshAt = nowSec - 60;
  const stablecoinsPayload = {
    peggedAssets: [
      {
        id: "usdc-circle",
        name: "USD Coin",
        symbol: "USDC",
        gecko_id: "usd-coin",
        pegType: "peggedUSD",
        pegMechanism: "fiat-backed",
        price: 0.9999,
        priceSource: "coingecko",
        priceConfidence: "high",
        priceObservedAt: freshAt,
        currentPeg: {
          currentDeviationBps: -1,
          pegReference: { valueUsd: 1, source: "median", contributorCount: 10, asOf: freshAt },
          pegReferenceUnavailable: false,
          currentPriceUnavailable: false,
          primaryTrust: "confirm_required",
          dexPriceCheck: null,
        },
        circulating: { peggedUSD: 35_000_000_000 },
        chains: ["Ethereum"],
      },
      {
        id: "usdt-tether",
        name: "Tether",
        symbol: "USDT",
        gecko_id: "tether",
        pegType: "peggedUSD",
        pegMechanism: "fiat-backed",
        price: 1.0,
        priceSource: "coingecko",
        priceConfidence: "high",
        priceObservedAt: freshAt,
        currentPeg: {
          currentDeviationBps: 0,
          pegReference: { valueUsd: 1, source: "median", contributorCount: 10, asOf: freshAt },
          pegReferenceUnavailable: false,
          currentPriceUnavailable: false,
          primaryTrust: "confirm_required",
          dexPriceCheck: null,
        },
        circulating: { peggedUSD: 120_000_000_000 },
        chains: ["Ethereum"],
      },
    ],
  };
  const pegAnalyticsPayload = {
    computedAtSec: freshAt,
    depegEventsToday: 0,
    depegEventsYesterday: 0,
    pegData: [
      {
        id: "usdc-circle",
        symbol: "USDC",
        name: "USD Coin",
        pegType: "peggedUSD",
        pegCurrency: "USD",
        governance: "centralized",
        currentDeviationBps: -1,
        pegScore: 98,
        pegPct: 99.9,
        severityScore: 99,
        spreadPenalty: 0,
        eventCount: 1,
        worstDeviationBps: -120,
        activeDepeg: false,
        lastEventAt: freshAt - 86400 * 30,
        trackingSpanDays: 365,
        methodologyVersion: "6.54",
      },
      {
        id: "usdt-tether",
        symbol: "USDT",
        name: "Tether",
        pegType: "peggedUSD",
        pegCurrency: "USD",
        governance: "centralized",
        currentDeviationBps: 0,
        pegScore: 97,
        pegPct: 99.8,
        severityScore: 98,
        spreadPenalty: 0,
        eventCount: 1,
        worstDeviationBps: -110,
        activeDepeg: false,
        lastEventAt: freshAt - 86400 * 60,
        trackingSpanDays: 365,
        methodologyVersion: "6.54",
      },
    ],
  };

  const ddrHorizons = [
    {
      horizon: "24h" as const,
      state: "benchmarked" as const,
      probability: 0.82,
      probabilityDisplay: "75-88%",
      probabilityInterval: { lower: 0.75, upper: 0.88 },
      rawAtRisk: 50,
      uniqueCoins: 20,
      intervalClosures: 41,
      intervalNonClosures: 9,
      horizonEndAt: freshAt + 86400,
      anchoredLabel: "24h",
    },
    {
      horizon: "7d" as const,
      state: "benchmarked" as const,
      probability: 0.95,
      probabilityDisplay: "90-98%",
      probabilityInterval: { lower: 0.9, upper: 0.98 },
      rawAtRisk: 50,
      uniqueCoins: 20,
      intervalClosures: 47,
      intervalNonClosures: 3,
      horizonEndAt: freshAt + 7 * 86400,
      anchoredLabel: "7d",
    },
  ];
  const ddrRows = options?.activeDdrCoinId
    ? [{
        stablecoinId: options.activeDdrCoinId,
        symbol: "USDC",
        name: "USD Coin",
        pegCurrency: "USD",
        governance: "centralized",
        status: null,
        eventId: 777,
        incidentKey: "inc-777",
        startedAt: freshAt - 7200,
        direction: "below",
        kind: "prediction",
        prediction: {
          state: "frozen",
          publicPredictionId: 42,
          incidentKey: "inc-777",
          predictionPolicyVersion: "2.0",
          predictionMethodologyVersion: DDR_METHODOLOGY_VERSION,
          predictionMethodologyVersionLabel: `v${DDR_METHODOLOGY_VERSION}`,
          resolutionRubricVersion: "2.0",
          durationModelVersion: "2.0",
          incidentGroupingVersion: "2.0",
          supportRulesVersion: "2.0",
          eligibleAt: freshAt - 3600,
          policyDelaySec: 3600,
          lockedAt: freshAt - 3500,
          publishedAt: freshAt - 3400,
          publicationSnapshotToken: "snap-tok-1",
          snapshotGeneration: 10,
          eventAgeAtLockSec: 3700,
          lockTiming: "on_time",
          source: "public_prediction",
          deferralReason: null,
          deferralCount: null,
          rowHash: "b".repeat(64),
          lineage: null,
          modelAsOf: freshAt,
          latestErratum: null,
          errataCount: 0,
          errataHistory: [],
        },
        frozen: {
          resolution: {
            tier: "recovery_likely",
            factors: [],
          },
          duration: {
            suppressed: false,
            suppressedReason: null,
            stratum: "below · moderate · USD",
            medianSec: 14400,
            remainingAsOf: freshAt - 3500,
            medianResolveAt: nowSec + 10_000,
            iqrSec: [7200, 28800],
            iqrResolveAt: [freshAt + 3700, freshAt + 25_300],
            ageStatus: "ordinary",
            horizons: ddrHorizons,
          },
          relatedContext: {},
          sourceRow: {
            stablecoinId: options.activeDdrCoinId,
            symbol: "USDC",
            name: "USD Coin",
            pegCurrency: "USD",
            governance: "centralized",
            status: null,
            eventId: 777,
            startedAt: freshAt - 7200,
            ageSec: 3700,
            direction: "below",
            peakDeviationBps: -250,
            currentDeviationBps: -180,
            resolution: { tier: "recovery_likely", factors: [] },
            duration: {
              suppressed: false,
              suppressedReason: null,
              stratum: "below · moderate · USD",
              medianSec: 14400,
              iqrSec: [7200, 28800],
              ageStatus: "ordinary",
              horizons: ddrHorizons,
            },
            relatedContext: {},
          },
        },
        live: {
          currentEventId: 777,
          ageSec: 7200,
          peakDeviationBps: -250,
          currentDeviationBps: -180,
          eventState: "active",
          updatedAt: freshAt,
          stale: false,
          degradedReason: null,
        },
      }]
    : [];

  const ddrPayload = {
    _meta: {
      schemaVersion: 2,
      dataAsOf: freshAt,
      modelAsOf: freshAt,
      computedAt: freshAt,
      expiresAt: freshAt + 1800,
      lastRefreshAttemptAt: freshAt,
      snapshotToken: "snap-tok-1",
      snapshotGeneration: 10,
      publicPredictionIds: options?.activeDdrCoinId ? [42] : [],
      publicPredictionRowHashes: options?.activeDdrCoinId ? { "42": "b".repeat(64) } : {},
      basePayloadHash: "c".repeat(64),
      readOverlay: {
        status: "none",
        resolvedExcludedCount: 0,
        errataAppliedCount: 0,
        lockDeferredAddedCount: 0,
      },
      degraded: false,
      degradedReason: null,
      degradedReasonDetail: null,
      publicWarning: "DDR is a calibrated model readout.",
      resolutionRubricVersion: "2.0",
      durationModelVersion: "2.0",
      durationBand: { label: "typical_range", lowerPercentile: 15, upperPercentile: 85 },
      incidentGroupingVersion: "2.0",
      supportRulesVersion: "2.0",
      lineage: null,
    },
    rows: ddrRows,
    methodology: {
      version: DDR_METHODOLOGY_VERSION,
      versionLabel: `v${DDR_METHODOLOGY_VERSION}`,
      currentVersion: DDR_METHODOLOGY_VERSION,
      currentVersionLabel: `v${DDR_METHODOLOGY_VERSION}`,
      changelogPath: "/methodology/depeg-resolver-changelog/",
      asOf: freshAt,
      isCurrent: true,
    },
  };

  const ddrEnvelope = {
    generation: DDR_SNAPSHOT_CACHE_GENERATION,
    methodologyVersion: DDR_METHODOLOGY_VERSION,
    payload: ddrPayload,
  };

  const dewsPointer = {
    updatedAt: freshAt,
    source: "compute-dews",
    publishStatus: "published",
    coverageVersion: 2,
    expectedRowCount: 2,
    stablecoinIdsDigest: "d".repeat(64),
  };

  const cacheRows = [
    { key: "stablecoins", value: JSON.stringify(stablecoinsPayload), updated_at: freshAt },
    ...(options?.missingPegAnalytics
      ? []
      : [{ key: "peg-analytics", value: JSON.stringify(pegAnalyticsPayload), updated_at: freshAt }]),
    { key: "depeg-resolver:snapshot", value: JSON.stringify(ddrEnvelope), updated_at: freshAt },
    { key: "dews:published-generation", value: JSON.stringify(dewsPointer), updated_at: freshAt },
  ];

  const redemptionRows = [
    makeValidRedemptionRow("usdc-circle", freshAt),
    options?.malformedRedemptionCoinId === "usdt-tether"
      ? {
          ...makeValidRedemptionRow("usdt-tether", freshAt),
          details_json: "{not-json",
        }
      : makeValidRedemptionRow("usdt-tether", freshAt),
  ];

  const executedSqls: string[] = [];
  const db = mockD1([
    {
      match: "SELECT key, value, updated_at FROM cache WHERE key IN",
      rows: cacheRows,
    },
    {
      match: "i.value AS score_index",
      first: safetyRow,
      rows: [safetyRow],
    },
    {
      match: "FROM depeg_events_with_provenance",
      rows: [],
    },
    {
      match: "pharos:depeg-event-projection:active-incidents",
      rows: [],
    },
    {
      match: "FROM dex_liquidity d",
      rows: [
        {
          stablecoin_id: "usdc-circle",
          total_tvl_usd: 4_500_000_000,
          total_volume_24h_usd: 1_200_000_000,
          pool_count: 140,
          liquidity_score: 96,
          updated_at: freshAt,
          coverage_class: "primary",
          coverage_confidence: 0.95,
          effective_tvl_usd: 4_100_000_000,
          balance_measured_tvl_usd: 4_000_000_000,
          organic_measured_tvl_usd: 3_800_000_000,
          publication_generation_id: "dex:gen-1",
          dex_price_usd: 0.9999,
          dex_price_updated_at: freshAt,
        },
        {
          stablecoin_id: "usdt-tether",
          total_tvl_usd: 5_200_000_000,
          total_volume_24h_usd: 2_100_000_000,
          pool_count: 180,
          liquidity_score: 97,
          updated_at: freshAt,
          coverage_class: "primary",
          coverage_confidence: 0.96,
          effective_tvl_usd: 4_900_000_000,
          balance_measured_tvl_usd: 4_700_000_000,
          organic_measured_tvl_usd: 4_500_000_000,
          publication_generation_id: "dex:gen-1",
          dex_price_usd: 1.0,
          dex_price_updated_at: freshAt,
        },
      ],
    },
    {
      match: "FROM redemption_backstop_runs",
      first: {
        run_id: "run-1",
        completed_at: freshAt,
        expected_count: 2,
        written_count: 2,
        max_updated_at: freshAt,
        methodology_version: "4.0",
      },
      rows: [],
    },
    {
      match: "FROM stress_signal_publication_rows",
      rows: [
        { stablecoin_id: "usdc-circle", score: 8, band: "CALM", computed_at: freshAt },
        { stablecoin_id: "usdt-tether", score: 11, band: "CALM", computed_at: freshAt },
      ],
    },
    {
      match: "FROM redemption_backstop_run_rows",
      rows: redemptionRows,
    },
    {
      match: "FROM depeg_resolver_publication_snapshots",
      first: null,
      rows: [],
    },
    {
      match: "FROM depeg_resolver_publication_snapshot_refs",
      first: null,
      rows: [],
    },
    {
      match: "SELECT *\n         FROM depeg_resolver_prediction_errata",
      rows: options?.ddrErratum
        ? [{
            id: 1,
            public_prediction_id: 42,
            incident_key: "inc-777",
            event_id: 777,
            assessment_id: 10,
            reason: "upstream_data_error",
            operator_note: "test erratum",
            replacement_assessment_id: null,
            replacement_row_hash: null,
            row_hash_before: "b".repeat(64),
            created_at: freshAt,
            created_by: "test",
          }]
        : [],
    },
  ]);

  const origPrepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    executedSqls.push(sql);
    return origPrepare(sql);
  }) as typeof db.prepare;

  return { db, executedSqls, safetyRow };
}

describe("deployment-resolver", () => {
  it("resolves chain aliases, display names, numeric EVM IDs, and CAIP-2", () => {
    expect(resolveDeploymentChainId("eth")).toBe("ethereum");
    expect(resolveDeploymentChainId("1")).toBe("ethereum");
    expect(resolveDeploymentChainId("eip155:8453")).toBe("base");
    expect(resolveDeploymentChainId("OP Mainnet")).toBe("optimism");
    expect(resolveDeploymentChainId("Kaia")).toBe("klaytn");
    expect(resolveDeploymentChainId("sol")).toBe("solana");
    expect(resolveDeploymentChainId("trx")).toBe("tron");
    expect(resolveDeploymentChainId("not-a-real-chain")).toBeNull();
  });

  it("normalizes addresses per chain family while keeping case-sensitive chains exact", () => {
    expect(normalizeDeploymentAddress("ethereum", USDC_ETH_CHECKSUM)).toBe(USDC_ETH);
    expect(normalizeDeploymentAddress("kava", "usdx")).toBe("usdx");
    expect(normalizeDeploymentAddress("starknet", "0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb"))
      .toBe("0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb");
    expect(normalizeDeploymentAddress("sui", "0x2::usdc::USDC"))
      .toBe(`0x${"0".repeat(63)}2::usdc::USDC`);
    expect(normalizeDeploymentAddress("hedera", "0x00000000000000000000000000000000009Ce723"))
      .toBe("0x00000000000000000000000000000000009ce723");
    expect(normalizeDeploymentAddress("hedera", "0.0.456858")).toBe("0.0.456858");
    expect(normalizeDeploymentAddress("injective", "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7"))
      .toBe(`peggy${USDT_ETH}`);
    expect(normalizeDeploymentAddress("xrpl", "524c555344000000000000000000000000000000.rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De"))
      .toBe("524C555344000000000000000000000000000000.rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De");
    expect(normalizeDeploymentAddress("solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"))
      .toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(normalizeAddressForChainlessLookup("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"))
      .toEqual(["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"]);
    expect(parseContractTuple("eip155:1:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")).toEqual({
      rawChain: "eip155:1",
      rawAddress: USDC_ETH_CHECKSUM,
    });
    expect(parseContractTuple("sui:0xdba3::usdc::USDC")).toEqual({
      rawChain: "sui",
      rawAddress: "0xdba3::usdc::USDC",
    });
  });

  it("resolves every deployment in WORKER_TRACKED_STABLECOINS without misses", () => {
    let checked = 0;
    for (const coin of WORKER_TRACKED_STABLECOINS) {
      for (const deployment of [...(coin.contracts ?? []), ...(coin.tradedContracts ?? [])]) {
        const result = resolveContractDeployment(deployment.chain, deployment.address);
        expect(result.ok, `${coin.id} ${deployment.chain}:${deployment.address}`).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(2000);
  });
});

describe("Wave 2 endpoints: compliance, resolve, risk-check", () => {
  afterEach(() => vi.useRealTimers());

  it("serves GET /api/compliance and GET /api/compliance/:id with regime context and R1/R4 unreviewed provenance", async () => {
    expect(getEndpointRequiredKeyPlans("/api/compliance")).toEqual(["commercial", "institutional"]);
    expect(getEndpointRequiredKeyPlans("/api/compliance/usdc-circle")).toEqual(["commercial", "institutional"]);

    const listRes = await handleCompliance(new URL("https://api.pharos.watch/api/compliance"));
    expect(listRes.status).toBe(200);
    expect(listRes.headers.get("Cache-Control")).toContain("s-maxage=");
    const listBody = ComplianceListResponseSchema.parse(await listRes.json());
    expect(listBody.regimes.genius.isEffective).toBe(false);
    expect(listBody.regimes.genius.effectiveDate).toBe("2027-01-18");
    expect(listBody.summary.totalCoins).toBe(listBody.coins.length);
    expect(listBody.summary.unassessedCoins).toBeGreaterThan(0);

    const unreviewed = listBody.coins.find((coin) => coin.mica === null && coin.genius === null);
    expect(unreviewed).toMatchObject({
      micaUnavailableReason: "not-reviewed",
      geniusUnavailableReason: "not-reviewed",
    });

    const alusdRes = await handleComplianceCoin("alusd-alchemix");
    expect(alusdRes.status).toBe(200);
    const alusdBody = ComplianceCoinResponseSchema.parse(await alusdRes.json());
    // Tri-state GENIUS disclosure booleans preserve absent as null (never coalesced to false).
    expect(alusdBody.coin.genius?.reserveDisclosurePresent).toBeNull();
    expect(alusdBody.coin.genius?.redemptionPolicyPresent).toBe(true);

    const invalidFilter = await handleCompliance(new URL("https://api.pharos.watch/api/compliance?regime=bogus"));
    expect(invalidFilter.status).toBe(400);

    const missingCoin = await handleComplianceCoin("does-not-exist");
    expect(missingCoin.status).toBe(404);
  });

  it("serves GET /api/resolve across all 4 query modes, cross-chain collisions, and batch partial misses", async () => {
    expect(getEndpointRequiredKeyPlans("/api/resolve")).toBeNull();

    // Mode 1: chain+address (CAIP-2 + checksummed)
    const singleRes = await handleResolve(
      new URL(`https://api.pharos.watch/api/resolve?chain=eip155:1&address=${USDC_ETH_CHECKSUM}`),
    );
    expect(singleRes.status).toBe(200);
    const singleBody = ResolveResponseSchema.parse(await singleRes.json());
    expect(singleBody.mode).toBe("deployment");
    if (singleBody.mode === "deployment") {
      expect(singleBody.coin.id).toBe("usdc-circle");
      expect(singleBody.query.chain).toBe("ethereum");
    }

    // Mode 2: address-only with real cross-chain collision across distinct coins
    const byAddr = new Map<string, Set<string>>();
    let collidingAddress: string | null = null;
    for (const coin of WORKER_TRACKED_STABLECOINS) {
      for (const c of coin.contracts ?? []) {
        const canonicalChain = resolveDeploymentChainId(c.chain) ?? c.chain;
        const norm = normalizeDeploymentAddress(canonicalChain, c.address);
        const set = byAddr.get(norm) ?? new Set<string>();
        set.add(coin.id);
        byAddr.set(norm, set);
        if (set.size > 1 && !collidingAddress) collidingAddress = c.address;
      }
    }
    expect(collidingAddress).not.toBeNull();
    const addrRes = await handleResolve(
      new URL(`https://api.pharos.watch/api/resolve?address=${encodeURIComponent(collidingAddress!)}`),
    );
    expect(addrRes.status).toBe(200);
    const addrBody = ResolveResponseSchema.parse(await addrRes.json());
    expect(addrBody.mode).toBe("address");
    if (addrBody.mode === "address") {
      expect(addrBody.ambiguousCoin).toBe(true);
      expect(addrBody.matchCount).toBeGreaterThan(1);
    }

    // Mode 3: id / geckoId reverse lookup
    const coinRes = await handleResolve(new URL("https://api.pharos.watch/api/resolve?geckoId=usd-coin"));
    expect(coinRes.status).toBe(200);
    const coinBody = ResolveResponseSchema.parse(await coinRes.json());
    expect(coinBody.mode).toBe("coin");
    if (coinBody.mode === "coin") {
      expect(coinBody.coin.id).toBe("usdc-circle");
      expect(coinBody.deployments.length).toBeGreaterThan(5);
    }

    // Mode 4: batch with inline partial misses
    const batchRes = await handleResolve(
      new URL(`https://api.pharos.watch/api/resolve?contracts=ethereum:${USDC_ETH_CHECKSUM},bogus:0x1,not-a-tuple,ethereum:0x${"0".repeat(40)}`),
    );
    expect(batchRes.status).toBe(200);
    const batchBody = ResolveResponseSchema.parse(await batchRes.json());
    expect(batchBody.mode).toBe("batch");
    if (batchBody.mode === "batch") {
      expect(batchBody.matchedCount).toBe(1);
      expect(batchBody.unresolvedCount).toBe(3);
      expect(batchBody.results.map((r) => r.reason)).toEqual([
        null,
        "unknown-chain",
        "invalid-contract",
        "deployment-not-found",
      ]);
    }

    // Errors: unknown chain, conflicting params, >50 contracts
    const unknownChain = await handleResolve(new URL("https://api.pharos.watch/api/resolve?chain=mars&address=0x1"));
    expect(unknownChain.status).toBe(400);
    expect(await unknownChain.json()).toMatchObject({ reason: "unknown-chain" });

    const conflict = await handleResolve(new URL("https://api.pharos.watch/api/resolve?id=usdc-circle&address=0x1"));
    expect(conflict.status).toBe(400);

    const tooMany = await handleResolve(
      new URL(`https://api.pharos.watch/api/resolve?contracts=${Array.from({ length: 51 }, () => `ethereum:${USDC_ETH}`).join(",")}`),
    );
    expect(tooMany.status).toBe(400);
  });

  it("serves GET /api/risk-check healthy path with bounded cache headers, pillars, and zero calm-market DDR reads", async () => {
    expect(getEndpointRequiredKeyPlans("/api/risk-check")).toEqual(["commercial", "institutional"]);

    const nowSec = 1_795_300_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(nowSec * 1000);

    const { db, executedSqls } = buildRiskCheckMockDb(nowSec);
    const res = await handleRiskCheck(
      db,
      new URL(`https://api.pharos.watch/api/risk-check?ids=usdc-circle,unknown-coin&contracts=ethereum:${USDT_ETH}`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Safety-Score-Status")).toBe("current");
    expect(res.headers.get("X-Safety-Score-Generation")).toBe("v9:test-gen-1");
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=");
    expect(res.headers.get("Cache-Control")).not.toBe("no-store");

    const body = RiskCheckResponseSchema.parse(await res.json());
    expect(body.requestedCount).toBe(3);
    expect(body.resolvedCount).toBe(2);
    expect(body.unresolved).toEqual([{ input: "unknown-coin", kind: "id", reason: "unknown-stablecoin" }]);
    expect(body.assets["usdc-circle"].safety).toMatchObject({
      ratingStatus: "rated",
      score: 88,
      grade: "A-",
      pillars: { backing: 91, exit: 94, control: 78 },
      publicationStatus: "current",
      unavailableReason: null,
    });
    expect(body.assets["usdt-tether"].safety).toMatchObject({
      ratingStatus: "pipeline-gap",
      score: null,
      grade: null,
      pillars: null,
      unavailableReason: "pipeline-gap",
    });
    expect(body.assets["usdc-circle"].ddr).toMatchObject({
      outlook: null,
      unavailableReason: "no-active-depeg",
    });
    expect(body.assets["usdc-circle"].controls.liveFreezeTrackerCovered).toBe(true);
    expect(body._meta.status).toBe("fresh");

    // Zero DDR manifest/errata D1 reads when no requested coin has an active DDR row
    expect(executedSqls.some((sql) => sql.includes("depeg_resolver_publication_snapshots"))).toBe(false);
    expect(executedSqls.some((sql) => sql.includes("SELECT *\n         FROM depeg_resolver_prediction_errata"))).toBe(false);
    expect(executedSqls.some((sql) => sql.includes(SAFETY_SCORE_V9_CACHE_KEYS.publication))).toBe(false);
  });

  it("enforces R1-R8 on /api/risk-check: held safety, missing peg-analytics cache, redemption row quarantine, and DDR errata", async () => {
    const nowSec = 1_795_300_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(nowSec * 1000);

    // Held safety + missing peg-analytics cache + malformed redemption on usdt-tether
    const { db } = buildRiskCheckMockDb(nowSec, {
      heldSafety: true,
      missingPegAnalytics: true,
      malformedRedemptionCoinId: "usdt-tether",
    });
    const res = await handleRiskCheck(
      db,
      new URL("https://api.pharos.watch/api/risk-check?ids=usdc-circle,usdt-tether"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Safety-Score-Status")).toBe("held");
    const body = RiskCheckResponseSchema.parse(await res.json());
    expect(body.assets["usdc-circle"].safety.publicationStatus).toBe("held");
    expect(body.assets["usdc-circle"].safety.unavailableReason).toBe("v9-publication-held");
    expect(body.assets["usdc-circle"].peg.pegScore).toBeNull();
    expect(body.assets["usdc-circle"].peg.unavailableReason).toBe("peg-analytics-cache-missing");
    // R8 quarantine: usdt-tether redemption quarantined while usdc-circle remains populated
    expect(body.assets["usdc-circle"].redemption.score).toBe(92);
    expect(body.assets["usdt-tether"].redemption.score).toBeNull();
    expect(body.assets["usdt-tether"].redemption.unavailableReason).toBe("redemption-row-malformed");
    expect(body._meta.dependencies?.pegAnalytics).toMatchObject({
      status: "unavailable",
      reason: "cache-missing",
    });

    // Active DDR row triggers conditional manifest+errata lookup; erratum invalidates prediction
    const ddrCase = buildRiskCheckMockDb(nowSec, { activeDdrCoinId: "usdc-circle", ddrErratum: true });
    const ddrRes = await handleRiskCheck(
      ddrCase.db,
      new URL("https://api.pharos.watch/api/risk-check?ids=usdc-circle"),
    );
    const ddrBody = RiskCheckResponseSchema.parse(await ddrRes.json());
    expect(ddrCase.executedSqls.some((sql) => sql.includes("depeg_resolver_publication_snapshots"))).toBe(true);
    expect(ddrCase.executedSqls.some((sql) => sql.includes("SELECT *\n         FROM depeg_resolver_prediction_errata"))).toBe(true);
    expect(ddrBody.assets["usdc-circle"].ddr).toMatchObject({
      outlook: null,
      unavailableReason: "prediction-invalidated",
    });

    // Unresolved-only returns 404; empty or >25 returns 400
    const allUnresolved = await handleRiskCheck(
      db,
      new URL("https://api.pharos.watch/api/risk-check?ids=totally-fake-coin"),
    );
    expect(allUnresolved.status).toBe(404);
    const empty = await handleRiskCheck(db, new URL("https://api.pharos.watch/api/risk-check"));
    expect(empty.status).toBe(400);
    const tooMany = await handleRiskCheck(
      db,
      new URL(`https://api.pharos.watch/api/risk-check?ids=${Array.from({ length: 26 }, (_, i) => `c${i}`).join(",")}`),
    );
    expect(tooMany.status).toBe(400);
  });

  it("canonicalizes sorted comma-separated cache keys for /api/risk-check and /api/resolve", () => {
    const rcA = new URL("https://api.pharos.watch/api/risk-check?ids=usdt-tether,usdc-circle&utm=foo");
    const rcB = new URL("https://api.pharos.watch/api/risk-check?ids=usdc-circle,usdt-tether");
    expect(createEdgeCacheContext(new Request(rcA), rcA).cacheKey.url)
      .toBe(createEdgeCacheContext(new Request(rcB), rcB).cacheKey.url);

    const resA = new URL("https://api.pharos.watch/api/resolve?contracts=b:0x2,a:0x1");
    const resB = new URL("https://api.pharos.watch/api/resolve?contracts=a:0x1,b:0x2&ignored=1");
    expect(createEdgeCacheContext(new Request(resA), resA).cacheKey.url)
      .toBe(createEdgeCacheContext(new Request(resB), resB).cacheKey.url);
  });
});
