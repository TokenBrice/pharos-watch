import { afterEach, describe, expect, it, vi } from "vitest";
import { getEndpointRequiredKeyPlans } from "@shared/lib/api-endpoints";
import { PUBLIC_API_CONTRACT_VERSION } from "@shared/lib/public-api-contract";
import { renderSafetyBadgeSvg } from "@shared/lib/safety-badge-svg";
import {
  normalizeAddressForChainlessLookup,
  normalizeDeploymentAddress,
  parseContractTuple,
  resolveDeploymentChainId,
} from "@shared/lib/deployment-resolver";
import { computeDdrManifestBasePayloadHash } from "@shared/lib/depeg-resolver/public-contract";
import { DDR_METHODOLOGY_VERSION, DDR_SNAPSHOT_CACHE_GENERATION } from "@shared/lib/methodology-versions/depeg-resolver";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { WORKER_TRACKED_STABLECOINS } from "@shared/lib/stablecoins/worker-runtime-registry";
import {
  ComplianceCoinResponseSchema,
  ComplianceListResponseSchema,
} from "@shared/types/compliance-api";
import { DdrResponseSchema } from "@shared/types/depeg-resolver";
import { ResolveResponseSchema } from "@shared/types/resolve";
import { RiskCheckResponseSchema } from "@shared/types/risk-check";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { createEdgeCacheContext } from "../../handlers/http/edge-cache";
import { evaluateAccessGate, isMcpPlanDeniedResponse } from "../../handlers/http/gates";
import type { AuthenticatedApiKey } from "../../lib/api-key-core";
import { SAFETY_SCORE_V9_CACHE_KEYS } from "../../lib/safety-score-v9/publication-health";
import { makeReportCardsV9Response } from "../../test-helpers/report-cards-v9";
import { handleCompliance, handleComplianceCoin } from "../compliance";
import { handleSafetyBadge } from "../badge";
import { handleMcp } from "../mcp";
import { handleResolve, resolveContractDeployment } from "../resolve";
import { handleRiskCheck } from "../risk-check";
import { resolveRoute } from "../../router";

const makeMcpKey = (overrides: Partial<AuthenticatedApiKey> = {}): AuthenticatedApiKey => ({
  id: 1, keyPrefix: "ph_t", name: "k", ownerEmail: null, tier: "standard", plan: "commercial",
  trafficClass: "external", rateLimitPerMinute: 120, monthlyRequestQuota: null, isActive: true, expiresAt: null, ...overrides,
});

const USDC_ETH = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDC_ETH_CHECKSUM = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT_ETH = "0xdac17f958d2ee523a2206206994597c13d831ec7";

function makeSafetyScoreCacheRows(nowSec: number, overrides?: { held?: boolean; buidlMode?: "post-cutover" | "pre-cutover-rated" }) {
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
    expectedCount: overrides?.buidlMode ? 4 : 3,
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
      ...(overrides?.buidlMode === "post-cutover"
        ? {
            "buidl-blackrock": {
              score: null,
              grade: "NR",
              ratingStatus: "not-rated",
              partialEvidence: null,
              notRatedReason: "tokenized-fund-not-graded",
            },
          }
        : overrides?.buidlMode === "pre-cutover-rated"
          ? { "buidl-blackrock": { score: 67, grade: "B-", ratingStatus: "rated", partialEvidence: null } }
          : {}),
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
      ...(overrides?.buidlMode === "pre-cutover-rated"
        ? {
            "buidl-blackrock": {
              backing: { score: 88, grade: "A+" },
              exit: { score: 55, grade: "C" },
              control: { score: 60, grade: "C+" },
            },
          }
        : {}),
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
  buidlMode?: "post-cutover" | "pre-cutover-rated";
  missingPegAnalytics?: boolean;
  malformedRedemptionCoinId?: string;
  eventualOnlyRedemptionCoinId?: string;
  activeDdrCoinId?: string;
  ddrErratum?: boolean;
  stablecoinsAgeSec?: number;
  redemptionAgeSec?: number;
  dewsAgeSec?: number;
  malformedStablecoinEntry?: boolean;
  nullStablecoinPriceFor?: string;
  activeDepegRows?: Record<string, unknown>[];
  dexRowOverrides?: Record<string, Record<string, unknown>>;
}) {
  const safetyRow = makeSafetyScoreCacheRows(nowSec, { held: options?.heldSafety, buidlMode: options?.buidlMode });
  const freshAt = nowSec - 60;
  const stablecoinsAt = nowSec - (options?.stablecoinsAgeSec ?? 60);
  const redemptionAt = nowSec - (options?.redemptionAgeSec ?? 60);
  const dewsAt = nowSec - (options?.dewsAgeSec ?? 60);
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
      // Fails critical-field validation: the lenient decode drops it and degrades.
      ...(options?.malformedStablecoinEntry ? [{ id: "", symbol: "" }] : []),
    ].map((asset) => asset.id === options?.nullStablecoinPriceFor ? { ...asset, price: null } : asset),
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
        price: 0.9998,
        priceSource: "peg-analytics-quote",
        priceObservedAt: freshAt - 600,
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

  // The public cache contract recomputes the manifest base hash; the fixture must carry the real one.
  ddrPayload._meta.basePayloadHash = computeDdrManifestBasePayloadHash(DdrResponseSchema.parse(ddrPayload));

  const ddrEnvelope = {
    generation: DDR_SNAPSHOT_CACHE_GENERATION,
    methodologyVersion: DDR_METHODOLOGY_VERSION,
    payload: ddrPayload,
  };

  const dewsPointer = {
    updatedAt: dewsAt,
    source: "compute-dews",
    publishStatus: "published",
    coverageVersion: 2,
    expectedRowCount: 2,
    stablecoinIdsDigest: "d".repeat(64),
  };

  const cacheRows = [
    { key: "stablecoins", value: JSON.stringify(stablecoinsPayload), updated_at: stablecoinsAt },
    ...(options?.missingPegAnalytics
      ? []
      : [{ key: "peg-analytics", value: JSON.stringify(pegAnalyticsPayload), updated_at: freshAt }]),
    { key: "depeg-resolver:snapshot", value: JSON.stringify(ddrEnvelope), updated_at: freshAt },
    { key: "dews:published-generation", value: JSON.stringify(dewsPointer), updated_at: dewsAt },
  ];

  const redemptionRows = [
    options?.eventualOnlyRedemptionCoinId === "usdc-circle"
      ? {
          ...makeValidRedemptionRow("usdc-circle", redemptionAt),
          score: null,
          capacity_score: null,
          immediate_capacity_usd: null,
          immediate_capacity_ratio: null,
          details_json: JSON.stringify({
            resolutionState: "resolved",
            capacityConfidence: "documented-bound",
            capacitySemantics: "eventual-only",
            eventualRedeemabilityScore: 72,
            feeConfidence: "fixed",
            feeModelKind: "fixed-bps",
            modelConfidence: "high",
            routeStatus: "open",
            routeStatusSource: "static-config",
            holderEligibility: "verified-customer",
          }),
        }
      : makeValidRedemptionRow("usdc-circle", redemptionAt),
    options?.malformedRedemptionCoinId === "usdt-tether"
      ? {
          ...makeValidRedemptionRow("usdt-tether", redemptionAt),
          details_json: "{not-json",
        }
      : makeValidRedemptionRow("usdt-tether", redemptionAt),
  ];
  // The previous complete generation: the store falls back to it when the latest
  // run's row census does not match.
  const previousRunAt = nowSec - 3 * 3600;
  const previousRedemptionRows = ["usdc-circle", "usdt-tether"].map((id) => ({
    ...makeValidRedemptionRow(id, previousRunAt),
    snapshot_run_id: "run-0",
  }));
  const makeRedemptionRun = (runId: string, at: number) => ({
    run_id: runId,
    completed_at: at,
    status: "completed",
    expected_count: 2,
    written_count: 2,
    min_updated_at: at,
    max_updated_at: at,
    methodology_version: "4.0",
    metadata_json: null,
  });
  const redemptionRuns = [
    makeRedemptionRun("run-1", redemptionAt),
    ...(options?.malformedRedemptionCoinId ? [makeRedemptionRun("run-0", previousRunAt)] : []),
  ];
  const dexPriceSourcesJson = JSON.stringify({ aggregateObservedAt: freshAt, sources: [] });
  const dexRows = [
    {
      stablecoin_id: "usdc-circle",
      total_tvl_usd: 4_500_000_000,
      total_volume_24h_usd: 1_200_000_000,
      volume_availability_json: null,
      pool_count: 140,
      liquidity_score: 96,
      updated_at: freshAt,
      coverage_class: "primary",
      coverage_confidence: 0.95,
      effective_tvl_usd: 4_100_000_000,
      balance_measured_tvl_usd: 4_000_000_000,
      organic_measured_tvl_usd: 3_800_000_000,
      publication_generation_id: "dex:coin-row",
      dex_price_stablecoin_id: "usdc-circle",
      dex_price_usd: 0.9999,
      dex_price_updated_at: freshAt,
      dex_price_sources_json: dexPriceSourcesJson,
    },
    {
      stablecoin_id: "usdt-tether",
      total_tvl_usd: 5_200_000_000,
      total_volume_24h_usd: 2_100_000_000,
      volume_availability_json: null,
      pool_count: 180,
      liquidity_score: 97,
      updated_at: freshAt,
      coverage_class: "primary",
      coverage_confidence: 0.96,
      effective_tvl_usd: 4_900_000_000,
      balance_measured_tvl_usd: 4_700_000_000,
      organic_measured_tvl_usd: 4_500_000_000,
      publication_generation_id: "dex:coin-row",
      dex_price_stablecoin_id: "usdt-tether",
      dex_price_usd: 1.0,
      dex_price_updated_at: freshAt,
      dex_price_sources_json: dexPriceSourcesJson,
    },
    {
      stablecoin_id: "__global__",
      total_tvl_usd: 0,
      total_volume_24h_usd: 0,
      volume_availability_json: null,
      pool_count: 0,
      liquidity_score: null,
      updated_at: freshAt,
      coverage_class: null,
      coverage_confidence: null,
      effective_tvl_usd: null,
      balance_measured_tvl_usd: null,
      organic_measured_tvl_usd: null,
      publication_generation_id: "dex:gen-1",
      dex_price_stablecoin_id: null,
      dex_price_usd: null,
      dex_price_updated_at: null,
      dex_price_sources_json: null,
    },
  ].map((row) => ({ ...row, ...options?.dexRowOverrides?.[row.stablecoin_id] }));

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
      rows: options?.activeDepegRows ?? [],
    },
    {
      // Confirmed-output clock of the active-depeg producer (sync-stablecoins).
      match: "FROM cron_runs WHERE job = ?1",
      first: { started_at: freshAt },
      rows: [{ started_at: freshAt }],
    },
    {
      match: "pharos:depeg-event-projection:active-incidents",
      rows: [],
    },
    {
      match: "FROM dex_liquidity d",
      rows: dexRows,
    },
    {
      match: "FROM redemption_backstop_runs",
      rows: redemptionRuns,
    },
    {
      match: "FROM stress_signal_publication_rows",
      rows: [
        { stablecoin_id: "usdc-circle", score: 8, band: "CALM", computed_at: dewsAt },
        { stablecoin_id: "usdt-tether", score: 11, band: "CALM", computed_at: dewsAt },
      ],
    },
    {
      match: "FROM redemption_backstop_run_rows",
      matchBinds: ["run-0", "", 50],
      rows: previousRedemptionRows,
    },
    {
      match: "FROM redemption_backstop_run_rows",
      rows: redemptionRows,
    },
    {
      match: "FROM depeg_resolver_prediction_lock_state ls",
      rows: [],
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
    expect(resolveDeploymentChainId("01")).toBeNull();
  });

  it("normalizes addresses per chain family while keeping case-sensitive chains exact", () => {
    expect(normalizeDeploymentAddress("ethereum", USDC_ETH_CHECKSUM)).toBe(USDC_ETH);
    expect(normalizeDeploymentAddress("kava", "usdx")).toBe("usdx");
    expect(normalizeDeploymentAddress("starknet", "0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb"))
      .toBe("0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb");
    expect(normalizeDeploymentAddress("sui", "0x2::usdc::USDC"))
      .toBe(`0x${"0".repeat(63)}2::usdc::USDC`);
    // A Hedera long-zero EVM alias resolves to its native entity ID.
    expect(normalizeDeploymentAddress("hedera", "0x00000000000000000000000000000000009Ce723"))
      .toBe("0.0.10282787");
    // XRPL ticker, hex and standard-form codes, with any separator, share one key.
    const usdq = "5553445100000000000000000000000000000000.rDk1xiArDMjDqnrR2yWypwQAKg4mKnQYvs";
    expect(normalizeDeploymentAddress("xrpl", "USDQ.rDk1xiArDMjDqnrR2yWypwQAKg4mKnQYvs")).toBe(usdq);
    expect(normalizeDeploymentAddress("xrpl", "USDQ-rDk1xiArDMjDqnrR2yWypwQAKg4mKnQYvs")).toBe(usdq);
    expect(normalizeDeploymentAddress("xrpl", "00000000000000000000000054424C0000000000.rJNE2NNz83GJYtWVLwMvchDWEon3huWnFn"))
      .toBe("TBL.rJNE2NNz83GJYtWVLwMvchDWEon3huWnFn");
    expect(normalizeDeploymentAddress("stellar", "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"))
      .toBe("USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
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
    expect(listBody.regimes.genius.effectiveDate).toBe("2027-01-18");    expect(listBody.summary.totalCoins).toBe(listBody.coins.length);
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
      unavailableReason: "no-ddr-row",
    });
    expect(body.assets["usdc-circle"].controls.liveFreezeTrackerCovered).toBe(true);
    expect(body.assets["usdc-circle"].peg).toMatchObject({
      price: 0.9999,
      priceSource: "coingecko",
      priceObservedAt: nowSec - 60,
      pegScore: 98,
      unavailableReason: null,
    });
    expect(body.assets["usdc-circle"].liquidity).toMatchObject({
      volume24hUsd: 1_200_000_000,
      dexPriceUsd: 0.9999,
      unavailableReason: null,
    });
    expect(body._meta.dependencies?.dexLiquidity?.generationId).toBe("dex:gen-1");
    expect(body._meta.dependencies?.activeDepegs).toMatchObject({ status: "fresh", updatedAt: nowSec - 60 });
    expect(body._meta.status).toBe("fresh");

    // Canonicalized like the edge-cache key: reordering and duplication give one body.
    const reordered = await handleRiskCheck(
      db,
      new URL(`https://api.pharos.watch/api/risk-check?contracts=ethereum:${USDT_ETH},ethereum:${USDT_ETH}&ids=zz-unknown,unknown-coin,usdc-circle,unknown-coin`),
    );
    const reorderedBody = RiskCheckResponseSchema.parse(await reordered.json());
    expect(reorderedBody.requestedCount).toBe(4);
    expect(reorderedBody.unresolved.map((entry) => entry.input)).toEqual(["unknown-coin", "zz-unknown"]);
    const canonical = await handleRiskCheck(
      db,
      new URL(`https://api.pharos.watch/api/risk-check?ids=unknown-coin,usdc-circle,zz-unknown&contracts=ethereum:${USDT_ETH}`),
    );
    expect(JSON.stringify(RiskCheckResponseSchema.parse(await canonical.json()))).toBe(JSON.stringify(reorderedBody));
    const duplicatesOnly = await handleRiskCheck(
      db,
      new URL(`https://api.pharos.watch/api/risk-check?ids=${Array.from({ length: 30 }, () => "usdc-circle").join(",")}`),
    );
    expect(duplicatesOnly.status).toBe(200);
    expect(RiskCheckResponseSchema.parse(await duplicatesOnly.json()).requestedCount).toBe(1);

    // Zero DDR manifest/errata D1 reads when no requested coin has an active DDR row
    expect(executedSqls.some((sql) => sql.includes("depeg_resolver_publication_snapshots"))).toBe(false);
    expect(executedSqls.some((sql) => sql.includes("SELECT *\n         FROM depeg_resolver_prediction_errata"))).toBe(false);
    expect(executedSqls.some((sql) => sql.includes(SAFETY_SCORE_V9_CACHE_KEYS.publication))).toBe(false);
  });

  it.each(["post-cutover", "pre-cutover-rated"] as const)(
    "reports tokenized-fund-not-graded on /api/risk-check and MCP get_risk_check (%s snapshot)",
    async (buidlMode) => {
      const nowSec = 1_795_300_000;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(nowSec * 1000);
      const { db } = buildRiskCheckMockDb(nowSec, { buidlMode });
      const res = await handleRiskCheck(db, new URL("https://api.pharos.watch/api/risk-check?ids=buidl-blackrock,dai-makerdao"));
      expect(res.status).toBe(200);
      const body = RiskCheckResponseSchema.parse(await res.json());
      expect(body.assets["buidl-blackrock"].safety).toMatchObject({
        ratingStatus: "not-rated",
        score: null,
        grade: "NR",
        pillars: null,
        publicationStatus: "current",
        unavailableReason: "tokenized-fund-not-graded",
      });
      expect(body.assets["dai-makerdao"].safety).toMatchObject({
        ratingStatus: "not-rated",
        score: null,
        grade: "NR",
        pillars: null,
        unavailableReason: "not-rated",
      });
      // MCP get_risk_check passes tokenized-fund-not-graded through verbatim.
      const mcpRes = await handleMcp(
        db,
        new Request("https://api.pharos.watch/api/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2025-11-25" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 99, method: "tools/call",
            params: { name: "get_risk_check", arguments: { ids: ["buidl-blackrock"] } },
          }),
        }),
        undefined,
        makeMcpKey(),
      );
      expect(mcpRes.status).toBe(200);
      const mcpBody = (await mcpRes.json()) as {
        result: { isError: boolean; structuredContent: { assets: Record<string, { safety: { unavailableReason: string | null; grade: string | null; score: number | null; pillars: unknown } }> } };
      };
      expect(mcpBody.result.isError).toBe(false);
      expect(mcpBody.result.structuredContent.assets["buidl-blackrock"].safety).toMatchObject({
        grade: "NR",
        score: null,
        pillars: null,
        unavailableReason: "tokenized-fund-not-graded",
      });
    },
  );

  it("enforces R1-R8 on /api/risk-check: held safety, missing peg-analytics cache, redemption run fallback, and DDR errata", async () => {
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
    expect(body.assets["usdc-circle"].peg.unavailableReason).toBe("peg-analytics-missing-cache");
    // The store's run admission: a row-census mismatch rejects run-1 and falls back to run-0.
    expect(body.assets["usdc-circle"].redemption.score).toBe(92);
    expect(body.assets["usdt-tether"].redemption.score).toBe(92);
    expect(body._meta.dependencies?.redemptionBackstops).toMatchObject({
      status: "fresh",
      generationId: "run-0",
      updatedAt: nowSec - 3 * 3600,
    });
    expect(body._meta.dependencies?.pegAnalytics).toMatchObject({
      status: "unavailable",
      reason: "missing-cache",
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

  it("grades each /api/risk-check dependency against its own budget and clamps the cache to the earliest runway", async () => {
    const nowSec = 1_795_300_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(nowSec * 1000);

    // Redemption 3 h old is inside its own budget; stablecoins is 5 min old.
    const { db } = buildRiskCheckMockDb(nowSec, { redemptionAgeSec: 3 * 3600, stablecoinsAgeSec: 300 });
    const res = await handleRiskCheck(db, new URL("https://api.pharos.watch/api/risk-check?ids=usdc-circle"));
    const body = RiskCheckResponseSchema.parse(await res.json());
    const dependencies = body._meta.dependencies ?? {};
    expect(dependencies.redemptionBackstops).toMatchObject({ status: "fresh", ageSeconds: 3 * 3600 });
    expect(dependencies.stablecoins).toMatchObject({ status: "fresh", ageSeconds: 300 });
    expect(body._meta.status).toBe("fresh");

    const runways = Object.entries(dependencies)
      .filter(([name, dep]) => name !== "compliance" && dep.updatedAt != null && dep.freshBudgetSec != null)
      .map(([, dep]) => ({ updatedAt: dep.updatedAt as number, budget: dep.freshBudgetSec as number }))
      .sort((left, right) => (left.updatedAt + left.budget) - (right.updatedAt + right.budget));
    const binding = runways[0];
    expect(body._meta).toMatchObject({ updatedAt: binding.updatedAt, freshBudgetSec: binding.budget });
    expect(binding.updatedAt).not.toBe(nowSec - 3 * 3600);
    expect(res.headers.get("X-Data-Updated-At")).toBe(String(binding.updatedAt));
    const cacheControl = res.headers.get("Cache-Control") ?? "";
    expect(cacheControl).toContain("s-maxage=");
    const sMaxAge = Number(/s-maxage=(\d+)/.exec(cacheControl)?.[1]);
    expect(sMaxAge).toBeGreaterThan(0);
    expect(sMaxAge).toBeLessThanOrEqual(binding.updatedAt + binding.budget - nowSec);

    // Near the end of the binding runway the TTL is clamped to what remains.
    vi.setSystemTime((binding.updatedAt + binding.budget - 30) * 1000);
    const late = await handleRiskCheck(db, new URL("https://api.pharos.watch/api/risk-check?ids=usdc-circle"));
    const lateCacheControl = late.headers.get("Cache-Control") ?? "";
    expect(lateCacheControl).toContain("s-maxage=");
    const lateSMaxAge = Number(/s-maxage=(\d+)/.exec(lateCacheControl)?.[1]);
    expect(lateSMaxAge).toBeGreaterThan(0);
    expect(lateSMaxAge).toBeLessThanOrEqual(30);
  });

  it("discloses eventual-only redemption semantics and keeps /api/risk-check fresh past 30m DEWS cadence", async () => {
    const nowSec = 1_795_300_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(nowSec * 1000);

    const { db } = buildRiskCheckMockDb(nowSec, {
      eventualOnlyRedemptionCoinId: "usdc-circle",
      dewsAgeSec: 1900,
    });
    const res = await handleRiskCheck(db, new URL("https://api.pharos.watch/api/risk-check?ids=usdc-circle"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=");
    const body = RiskCheckResponseSchema.parse(await res.json());
    expect(body._meta.status).toBe("fresh");
    expect(body._meta.dependencies?.dews).toMatchObject({ status: "fresh", ageSeconds: 1900, freshBudgetSec: 3600 });
    expect(body.assets["usdc-circle"].redemption).toMatchObject({
      score: null,
      capacitySemantics: "eventual-only",
      eventualRedeemabilityScore: 72,
      unavailableReason: "eventual-only",
    });
  });

  it("quarantines per asset on /api/risk-check: degraded stablecoins, one price producer, unreadable depeg rows, DEX admission", async () => {
    const nowSec = 1_795_300_000;
    const freshAt = nowSec - 60;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(nowSec * 1000);

    const depegRow = {
      id: 801,
      stablecoin_id: "usdc-circle",
      symbol: "USDC",
      peg_type: "peggedUSD",
      direction: "below",
      peak_deviation_bps: -250,
      started_at: freshAt - 7200,
      ended_at: null,
      start_price: 0.985,
      peak_price: 0.975,
      recovery_price: null,
      peg_reference: 1,
      source: "live",
      confirmation_sources: null,
      pending_reason: null,
    };
    const { db, executedSqls } = buildRiskCheckMockDb(nowSec, {
      malformedStablecoinEntry: true,
      nullStablecoinPriceFor: "usdc-circle",
      activeDepegRows: [depegRow, { ...depegRow, id: 802, stablecoin_id: "usdt-tether", symbol: "USDT", direction: "sideways" }],
      dexRowOverrides: { "usdt-tether": { volume_availability_json: "{}", dex_price_updated_at: freshAt - 120 } },
    });
    const res = await handleRiskCheck(db, new URL("https://api.pharos.watch/api/risk-check?ids=usdc-circle,usdt-tether"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = RiskCheckResponseSchema.parse(await res.json());

    // A malformed entry degrades the dependency; it does not blank every asset.
    expect(body._meta.dependencies?.stablecoins).toMatchObject({ status: "degraded", reason: "filtered-malformed-entries" });
    expect(body.assets["usdt-tether"].peg.price).toBe(1);
    // The stablecoins producer published an explicit null price: never backfilled from peg analytics.
    expect(body.assets["usdc-circle"].peg).toMatchObject({
      price: null,
      priceSource: "coingecko",
      priceObservedAt: freshAt,
      unavailableReason: "price-unavailable",
    });
    // A readable active depeg without a DDR row reads "no-ddr-row", never "no active depeg".
    expect(body.assets["usdc-circle"].peg.activeDepeg).toMatchObject({ eventId: 801, direction: "below" });
    expect(body.assets["usdc-circle"].ddr.unavailableReason).toBe("no-ddr-row");
    expect(executedSqls.some((sql) => sql.includes("FROM depeg_resolver_prediction_lock_state ls"))).toBe(true);
    // One unreadable row quarantines its own coin only.
    expect(body.assets["usdt-tether"].peg).toMatchObject({ activeDepeg: null, unavailableReason: "active-depeg-row-unreadable" });
    // DEX: an unreadable volume record and a price from another publication are withheld.
    expect(body.assets["usdt-tether"].liquidity).toMatchObject({
      totalTvlUsd: 5_200_000_000,
      volume24hUsd: null,
      dexPriceUsd: null,
      unavailableReason: "volume-24h-availability-record-unreadable",
    });
    expect(body.assets["usdc-circle"].liquidity.dexPriceUsd).toBe(0.9999);
  });

  it("canonicalizes sorted comma-separated cache keys for /api/risk-check and /api/resolve", () => {
    const rcA = new URL("https://api.pharos.watch/api/risk-check?ids=usdt-tether,usdc-circle&utm=foo");
    const rcB = new URL("https://api.pharos.watch/api/risk-check?ids=usdc-circle,usdt-tether");
    expect(createEdgeCacheContext(new Request(rcA), rcA).cacheKey.url)
      .toBe(createEdgeCacheContext(new Request(rcB), rcB).cacheKey.url);

    const rcDup = new URL("https://api.pharos.watch/api/risk-check?ids=usdc-circle,usdt-tether,usdc-circle");
    expect(createEdgeCacheContext(new Request(rcDup), rcDup).cacheKey.url)
      .toBe(createEdgeCacheContext(new Request(rcB), rcB).cacheKey.url);

    // /api/resolve answers in input order, so a reordering keeps its own key.
    const resA = new URL("https://api.pharos.watch/api/resolve?contracts=b:0x2,a:0x1");
    const resB = new URL("https://api.pharos.watch/api/resolve?contracts=a:0x1,b:0x2&ignored=1");
    expect(createEdgeCacheContext(new Request(resA), resA).cacheKey.url)
      .not.toBe(createEdgeCacheContext(new Request(resB), resB).cacheKey.url);
  });
});

describe("Wave 3 endpoints: MCP server & SVG safety badge", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("enforces MCP auth/per-tool plan gating, 405 on GET, protocol version, no-batch, 413 cap, and JSON-RPC lifecycle", async () => {
    expect(getEndpointRequiredKeyPlans("/api/mcp")).toBeNull();
    expect(resolveRoute(new URL("https://api.pharos.watch/api/mcp"), "GET")?.methodValidation?.allowedMethods).toEqual(["POST"]);
    const unauthReq = new Request("https://api.pharos.watch/api/mcp", { method: "POST" });
    expect((await evaluateAccessGate(unauthReq, new URL(unauthReq.url), { API_KEY_HASH_PEPPER: "p" } as never)).response?.status).toBe(401);

    const nowSec = 1_795_300_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(nowSec * 1000);
    const { db } = buildRiskCheckMockDb(nowSec);
    const commercial = makeMcpKey({ plan: "commercial" });
    const institutional = makeMcpKey({ plan: "institutional" });
    const freePartner = makeMcpKey({ plan: "free_partner", rateLimitPerMinute: 60 });
    const donor = makeMcpKey({ tier: "donor", plan: null, rateLimitPerMinute: 10 });
    const openTools = ["resolve_stablecoin", "get_safety_report_card", "get_depeg_events", "get_stress_signals", "get_stablecoin_reserves"];
    const allTools = ["resolve_stablecoin", "get_risk_check", "get_compliance", "get_safety_report_card", "get_depeg_events", "get_stress_signals", "get_stablecoin_reserves"];
    const cacheStore = new Map<string, Response>();
    const match = vi.fn(async (req: Request) => cacheStore.get(req.url)?.clone());
    const put = vi.fn(async (req: Request, res: Response) => { cacheStore.set(req.url, res.clone()); });
    vi.stubGlobal("caches", { default: { match, put } });
    const execCtx = { waitUntil: vi.fn((p: Promise<unknown>) => void p) } as unknown as ExecutionContext;
    const postMcp = (
      body: unknown,
      apiKey: AuthenticatedApiKey | null | undefined = commercial,
      headers: Record<string, string> = {},
      trustedAdmin = false,
    ) =>
      handleMcp(db, new Request("https://api.pharos.watch/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }), execCtx, apiKey, trustedAdmin);

    const initLatest = await postMcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28" } });
    expect(initLatest.status).toBe(200);
    expect(initLatest.headers.get("Cache-Control")).toBe("no-store");
    await expect(initLatest.json()).resolves.toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2026-07-28", serverInfo: { name: "pharos", version: PUBLIC_API_CONTRACT_VERSION } } });

    // Headerless request exercises the documented default MCP-Protocol-Version: 2025-03-26 fallback.
    const notif = await postMcp({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notif.status).toBe(202); expect(await notif.text()).toBe("");
    expect((await postMcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }, commercial, { "MCP-Protocol-Version": "1999-01-01" })).status).toBe(400);
    const batch = await postMcp([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    expect(batch.status).toBe(400); await expect(batch.json()).resolves.toMatchObject({ error: { code: -32600 } });
    expect((await postMcp("x".repeat(17 * 1024))).status).toBe(413);

    for (const [key, expected, admin] of [[commercial, allTools, false], [institutional, allTools, false], [freePartner, openTools, false], [donor, openTools, false], [null, openTools, false], [null, allTools, true]] as const) {
      const list = (await (await postMcp({ jsonrpc: "2.0", id: 3, method: "tools/list" }, key, {}, admin)).json()) as { result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> } };
      expect(list.result.tools.map((t) => t.name)).toEqual(expected);
      expect(list.result.tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
    }

    // Commercial warms edge cache for both paid tools; institutional and trustedAdmin also succeed.
    const rcRes = await postMcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_risk_check", arguments: { ids: ["usdc-circle"] } } }, commercial, { "MCP-Protocol-Version": "2025-11-25" });
    expect(isMcpPlanDeniedResponse(rcRes)).toBe(false);
    const rc = (await rcRes.json()) as { result: { isError: boolean; _meta: { safetyScoreStatus: string }; structuredContent: { assets: Record<string, unknown> } } };
    expect(rc.result.isError).toBe(false);
    expect(rc.result._meta.safetyScoreStatus).toBe("current");
    expect(rc.result.structuredContent.assets["usdc-circle"]).toBeDefined();
    const comp = (await (await postMcp({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_compliance", arguments: { id: "usdc-circle" } } }, institutional)).json()) as { result: { isError: boolean; structuredContent: { coin: { id: string } } } };
    expect(comp.result.isError).toBe(false);
    expect(comp.result.structuredContent.coin.id).toBe("usdc-circle");
    expect(((await (await postMcp({ jsonrpc: "2.0", id: 50, method: "tools/call", params: { name: "get_risk_check", arguments: { ids: ["usdc-circle"] } } }, null, {}, true)).json()) as { result: { isError: boolean } }).result.isError).toBe(false);
    expect(put).toHaveBeenCalledTimes(2);
    expect(cacheStore.size).toBe(2);

    // Non-entitled keys succeed on open tools, but are rejected on paid tools BEFORE edge-cache reads and marked non-billable.
    for (const key of [freePartner, donor, null] as const) {
      const openRes = await postMcp({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "resolve_stablecoin", arguments: { id: "usdc-circle" } } }, key);
      expect(isMcpPlanDeniedResponse(openRes)).toBe(false);
      const open = (await openRes.json()) as { result: { isError: boolean } };
      expect(open.result.isError).toBe(false);
      match.mockClear();
      for (const [name, args, restPath] of [
        ["get_risk_check", { ids: ["usdc-circle"] }, "/api/risk-check"],
        ["get_compliance", { id: "usdc-circle" }, "/api/compliance/usdc-circle"],
      ] as const) {
        const deniedRes = await postMcp({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }, key);
        expect(isMcpPlanDeniedResponse(deniedRes)).toBe(true);
        const denied = (await deniedRes.json()) as { result: { isError: boolean; _meta: { httpStatus: number }; structuredContent: { reason: string; requiredPlans: string[] } } };
        expect(denied.result.isError).toBe(true);
        expect(denied.result._meta.httpStatus).toBe(403);
        expect(denied.result.structuredContent).toMatchObject({
          reason: "plan_upgrade_required",
          requiredPlans: getEndpointRequiredKeyPlans(restPath),
        });
      }
      expect(match).not.toHaveBeenCalled();
    }

    await expect((await postMcp({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "drop_tables", arguments: {} } })).json()).resolves.toMatchObject({ error: { code: -32602 } });

    // Unmocked router preserves the WeakSet plan-denied marker on POST /api/mcp.
    const { route: realRoute } = await import("../../router");
    const routedDenied = await realRoute({
      url: new URL("https://api.pharos.watch/api/mcp"),
      db,
      execCtx,
      request: new Request("https://api.pharos.watch/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "get_risk_check", arguments: { ids: ["usdc-circle"] } } }),
      }),
      trustedAdmin: false,
      apiKey: freePartner,
    });
    expect(routedDenied?.status).toBe(200);
    expect(routedDenied && isMcpPlanDeniedResponse(routedDenied)).toBe(true);
  });

  it("renders GET /api/badge/:id.svg across styles, themes, NR, held, stale, pipeline-gap, and 404 states without <style> blocks", async () => {
    const nowSec = 1_795_300_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(nowSec * 1000);

    // Pure renderer invariants (no <style>, XML escaping, flat/card/light/dark)
    const escaped = renderSafetyBadgeSvg({ kind: "rated", symbol: "A<B>&", name: 'Test "Coin"', grade: "A-", score: 88 }, { style: "card", theme: "light" });
    expect(escaped).not.toContain("<style");
    expect(escaped).not.toContain('style="');
    expect(escaped).toContain("A&lt;B&gt;&amp;");
    expect(escaped).toContain("88/100");

    // Current rated coin (USDC -> A- · 88)
    const { db } = buildRiskCheckMockDb(nowSec);
    const flatRes = await handleSafetyBadge(db, "usdc-circle", new URL("https://api.pharos.watch/api/badge/usdc-circle.svg"));
    expect(flatRes.status).toBe(200);
    expect(flatRes.headers.get("Content-Type")).toBe("image/svg+xml; charset=utf-8");
    expect(flatRes.headers.get("X-Safety-Score-Status")).toBe("current");
    expect(flatRes.headers.get("X-Safety-Score-Generation")).toBe("v9:test-gen-1");
    expect(flatRes.headers.get("Cache-Control")).toContain("s-maxage=");
    const flatSvg = await flatRes.text();
    expect(flatSvg).toContain("USDC");
    expect(flatSvg).toContain("A-");
    expect(flatSvg).not.toContain("<style");

    // Card + light theme + NR coin (dai-makerdao)
    const nrRes = await handleSafetyBadge(db, "dai-makerdao", new URL("https://api.pharos.watch/api/badge/dai-makerdao.svg?style=card&theme=light"));
    expect(nrRes.status).toBe(200);
    expect(nrRes.headers.get("Cache-Control")).toContain("s-maxage=");
    const nrSvg = await nrRes.text();
    expect(nrSvg).toContain("NR");
    expect(nrSvg).toContain("Not rated");

    // Pipeline-gap coin (usdt-tether in mock) -> 200 Unavailable SVG + no-store
    const gapRes = await handleSafetyBadge(db, "usdt-tether", new URL("https://api.pharos.watch/api/badge/usdt-tether.svg"));
    expect(gapRes.status).toBe(200);
    expect(gapRes.headers.get("Cache-Control")).toBe("no-store");
    expect(gapRes.headers.get("X-Badge-Reason")).toBe("pipeline-gap");
    expect(await gapRes.text()).toContain("Unavailable");

    // Held publication -> 200 Unavailable SVG + no-store + X-Safety-Score-Status: held
    const heldCase = buildRiskCheckMockDb(nowSec, { heldSafety: true });
    const heldRes = await handleSafetyBadge(heldCase.db, "usdc-circle", new URL("https://api.pharos.watch/api/badge/usdc-circle.svg"));
    expect(heldRes.status).toBe(200);
    expect(heldRes.headers.get("Cache-Control")).toBe("no-store");
    expect(heldRes.headers.get("X-Safety-Score-Status")).toBe("held");
    expect(heldRes.headers.get("X-Badge-Reason")).toBe("v9-publication-held");
    const heldSvg = await heldRes.text();
    expect(heldSvg).toContain("Unavailable");
    expect(heldSvg).not.toContain("88/100");
    expect(heldSvg).not.toContain("A-");

    // Stale publication -> 200 Unavailable SVG + no-store + X-Safety-Score-Status: stale
    vi.setSystemTime((nowSec + 100_000) * 1000);
    const staleRes = await handleSafetyBadge(db, "usdc-circle", new URL("https://api.pharos.watch/api/badge/usdc-circle.svg"));
    expect(staleRes.status).toBe(200);
    expect(staleRes.headers.get("Cache-Control")).toBe("no-store");
    expect(staleRes.headers.get("X-Safety-Score-Status")).toBe("stale");
    expect(await staleRes.text()).toContain("Unavailable");

    // Tokenized fund -> 200 Not graded SVG with X-Badge-Reason: tokenized-fund-not-graded
    const fundFlat = await handleSafetyBadge(db, "buidl-blackrock", new URL("https://api.pharos.watch/api/badge/buidl-blackrock.svg"));
    expect(fundFlat.status).toBe(200);
    expect(fundFlat.headers.get("X-Badge-Reason")).toBe("tokenized-fund-not-graded");
    const fundFlatSvg = await fundFlat.text();
    expect(fundFlatSvg).toContain("Not graded");
    expect(fundFlatSvg).not.toContain("/100");
    const fundCardSvg = renderSafetyBadgeSvg({ kind: "tokenized-fund", symbol: "BUIDL", name: "BlackRock USD" }, { style: "card", theme: "light" });
    expect(fundCardSvg).toContain("Tokenized fund");
    expect(fundCardSvg).toContain("Not graded");

    // Unknown coin -> 404
    const missing = await handleSafetyBadge(db, "nonexistent-coin", new URL("https://api.pharos.watch/api/badge/nonexistent-coin.svg"));
    expect(missing.status).toBe(404);
  });
});
