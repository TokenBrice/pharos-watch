import { vi } from "vitest";
import * as publishedMintBurn from "../../lib/mint-burn-pipeline/mint-burn-published-gauge";
import { buildHistoryKey } from "../yield-sync/history-evidence";
import { buildYieldRankingsPayloadFromEvaluatedSources } from "../yield-sync/publication-rankings";
import {
  makeBenchmarkMeta,
  makeEvaluatedSource,
  makePublicationViews,
  makeSafetySnapshotMeta,
  makeYieldSourceMeta,
} from "./yield-publication.test-support";

import { makeNoopD1 } from "../../test-helpers/noop-d1";

export function createDewsDb(prepare: (sql: string) => unknown): D1Database {
  return makeNoopD1({
    prepare,
    batch: async (statements: D1PreparedStatement[]) => Promise.all(statements.map((statement) =>
      /^\s*SELECT\b/i.test((statement as D1PreparedStatement & { sql: string }).sql)
        ? statement.all()
        : statement.run(),
    )),
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  });
}

export function dewsCoin(overrides: Record<string, unknown> = {}) {
  return {
    id: "usdt-tether", symbol: "USDT", pegType: "peggedUSD", price: 1, priceConfidence: "high",
    circulating: { peggedUSD: 100_000_000 },
    circulatingPrevDay: { peggedUSD: 99_000_000 },
    circulatingPrevWeek: { peggedUSD: 98_000_000 },
    ...overrides,
  };
}

export function dewsCache(peggedAssets = [dewsCoin()], extra: Record<string, unknown> = {}) {
  return {
    value: JSON.stringify({ peggedAssets, ...extra }),
    updatedAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * A payload built by the real publisher, so the DEWS consumer is tested against
 * what production writes into `cache.yield-rankings` (D10).
 */
export function publishShapedRankingsPayload() {
  const startSec = Math.floor(Date.now() / 1000);
  const source = makeEvaluatedSource({
    id: "usdt-tether",
    symbol: "USDT",
    sourceKey: "defillama:usdt-new",
    pharosYieldScore: 40,
    sourceSwitchCount30d: 1,
    previousBestSourceKey: "defillama:usdt-old",
  });
  const benchmark = makeBenchmarkMeta();
  return buildYieldRankingsPayloadFromEvaluatedSources({
    evaluatedSources: [source],
    publicationViews: makePublicationViews([source], new Map([[source.id, source.sourceKey]]), startSec),
    rankingProvenanceByKey: new Map([
      [
        buildHistoryKey(source.id, source.sourceKey),
        {
          sourceKey: source.sourceKey,
          sourceObservedAt: startSec,
          sourceAgeSeconds: 0,
          confidenceTier: source.confidenceTier,
          selectionMethod: "confidence-weighted" as const,
          selectionReason: "test",
          sourceSwitch: true,
          previousBestSourceKey: "defillama:usdt-old",
          usedLegacyHistory: false,
          usedDefaultSafety: false,
          // P1-10 validates complete per-row provenance before publication.
          benchmarkRecordDate: source.benchmarkRecordDate,
          benchmarkIsFallback: source.benchmarkIsFallback,
          benchmarkFallbackMode: source.benchmarkFallbackMode,
          anomalies: [],
        },
      ],
    ]),
    riskFreeRate: benchmark.rate,
    riskFreeRateMeta: benchmark,
    dlPoolsMeta: makeYieldSourceMeta(),
    safetySnapshot: makeSafetySnapshotMeta(),
    medianApy: 4.5,
    startSec,
    previousPublication: {
      rankings: [
        {
          id: "usdt-tether",
          name: "Tether",
          currentApy: 4.8,
          pharosYieldScore: 20,
          safetyScore: source.safetyScore,
          publishedRank: 2,
          warningSignals: [],
        },
        {
          id: "pyusd-paypal",
          name: "PayPal USD",
          currentApy: 9,
          pharosYieldScore: 30,
          safetyScore: 80,
          publishedRank: 1,
          warningSignals: [],
        },
      ],
    },
  });
}

interface MakeDbOptions {
  failDexLiquidity?: boolean;
  failDexPricesMissingTable?: boolean;
  dexMethodologyVersion?: string | null;
  dexHistoryMethodologyVersion?: string | null;
  dexPriceRows?: Array<{
    stablecoin_id: string;
    dex_price_usd: number;
    source_total_tvl?: number;
    updated_at: number;
  }>;
  dexLiqRows?: Array<{
    stablecoin_id: string;
    weighted_balance_ratio: number | null;
    avg_pool_stress: number | null;
    top_pools_json?: string | null;
    liquidity_score: number | null;
    total_tvl_usd: number | null;
    updated_at?: number | null;
  }>;
  mintBurn24hRows?: Array<{
    // Observed raw rows are independent of the publication's scan proof.
    stablecoin_id: string;
    chain_id?: string;
    total_burn: number;
    total_mint: number;
    latest_hour_ts?: number | null;
  }>;
  mintBurn30dRows?: Array<{
    stablecoin_id: string;
    chain_id?: string;
    total_burn: number;
    total_mint: number;
    days_with_data: number;
    latest_hour_ts?: number | null;
  }>;
  blacklistRows?: Array<{
    stablecoin: string;
    chain_id?: string;
    config_key?: string | null;
    contract_address?: string | null;
    timestamp: number;
  }>;
  prevSignalRows?: Array<{
    stablecoin_id: string;
    signals_json: string;
    band: string;
    computed_at: number;
  }>;
  yieldWarningRows?: Array<{
    stablecoin_id: string;
    warning_signals: string;
    is_best?: number | null;
    publication_state?: string | null;
  }>;
  yieldRankingsPayload?: unknown;
  yieldRankingsUpdatedAt?: number;
  signalIds?: string[];
  historyIds?: string[];
  historySnapshotIds?: string[];
  dexPublicationLatest?: {
    generation_id: string;
    state: string;
    started_at: number | null;
    published_at: number | null;
    failed_at: number | null;
    failure_reason: string | null;
  };
  dexPublicationLatestPublished?: {
    generation_id: string;
    state: string;
    started_at: number | null;
    published_at: number | null;
    failed_at: number | null;
    failure_reason: string | null;
  };
  failDexPublicationDiagnostics?: boolean;
  psiSample?: { score: number; stored_at: number } | null;
  onBind?: (sql: string, args: unknown[]) => void;
  mintBurnProofAvailable?: boolean;
}

export function makeDb(sqlSeen: string[], opts: MakeDbOptions = {}): D1Database {
  const proofEnd = Math.floor(Date.now() / 1000 / 3600) * 3600;
  const proofRows = [...(opts.mintBurn24hRows ?? []), ...(opts.mintBurn30dRows ?? [])];
  if (proofRows.length > 0 && opts.mintBurnProofAvailable !== false) {
    const complete = { complete: true, unavailableReason: null } as const;
    vi.spyOn(publishedMintBurn, "readPublishedMintBurnGauge").mockResolvedValue({ kind: "ok", gauge: {
      score: null, partialValuationInputs: 0, partialValuationMcapUsd: 0, scoredMcapUsd: 0, chains: [],
      window: { start: proofEnd - 86400, end: proofEnd, semantics: "closed-utc-hours" },
      publication: { evaluatedAt: proofEnd, requiredBaselineSec: 90 * 86400, freshnessBudgetSec: 7200,
        legs: proofRows.map((row) => ({ configKey: `${row.stablecoin_id}-${row.chain_id ?? "ethereum"}`,
          configFingerprint: "synthetic-admitted-proof", stablecoinId: row.stablecoin_id, chainId: row.chain_id ?? "ethereum",
          status: "admitted", reason: null, admittedAt: proofEnd - 86400, baselineFrom: proofEnd - 90 * 86400,
          baselineTo: proofEnd, coveredSeconds: 90 * 86400, frontierAgeSec: 0 })),
      },
      updatedAt: proofEnd, publishedAt: proofEnd, stale: false,
      coins: [...new Set(proofRows.map((row) => row.stablecoin_id))].map((id) => ({
        id, symbol: id, intensity: null, net24hUsd: null, gaugeWeightUsd: null, baselineValuation: "unknown",
        valuation24h: { completeness: "unknown", mintCompleteness: "unknown", burnCompleteness: "unknown",
          unpricedMintEventCount: 0, unpricedBurnEventCount: 0 },
        scanCoverage: { window24h: complete, window7d: complete, window30d: complete, window90d: complete },
      })),
    } });
  }
  const computedSnapshotIds = new Set<string>();
  const stmt = (sql: string) => {
    sqlSeen.push(sql);
    const all = async <T>() => {
      if (sql.includes("pharos:dews:publication-generation-ids")
        || sql.includes("pharos:dews:stress-latest-generation-ids")) {
        return { results: [...computedSnapshotIds].map((stablecoin_id) => ({ stablecoin_id })) as T[] };
      }
      if (sql.includes("pharos:dews:stress-history-daily-ids")) {
        return {
          results: (opts.historySnapshotIds ?? [...computedSnapshotIds])
            .map((stablecoin_id) => ({ stablecoin_id })) as T[],
        };
      }
      if (sql.includes("pharos:dews:orphan-ids:stress_signals")) {
        return {
          results: (opts.signalIds ?? ["usdt-tether"]).map((stablecoin_id) => ({ stablecoin_id })) as T[],
        };
      }
      if (sql.includes("pharos:dews:orphan-ids:stress_signal_history")) {
        return {
          results: (opts.historyIds ?? ["usdt-tether"]).map((stablecoin_id) => ({ stablecoin_id })) as T[],
        };
      }
      if (/FROM dex_liquidity(?!_history)/.test(sql)) {
        if (opts.failDexLiquidity) {
          throw new Error("dex-liquidity unavailable");
        }
        return {
          results: (opts.dexLiqRows ?? [
            {
              stablecoin_id: "usdt-tether",
              weighted_balance_ratio: 0.95,
              avg_pool_stress: 0.05,
              top_pools_json: "[]",
              liquidity_score: 80,
              total_tvl_usd: 1_500_000,
              updated_at: Math.floor(Date.now() / 1000),
              methodology_version: opts.dexMethodologyVersion ?? null,
            },
          ]) as T[],
        };
      }
      if (sql.includes("FROM dex_prices")) {
        if (opts.failDexPricesMissingTable) {
          throw new Error("no such table: dex_prices");
        }
        return {
          results: (opts.dexPriceRows ?? []) as T[],
        };
      }
      if (sql.includes("FROM stress_signals s")) {
        return {
          results: (opts.prevSignalRows ?? []) as T[],
        };
      }
      if (sql.includes("FROM dex_liquidity_history")) {
        return {
          results: [
            {
              stablecoin_id: "usdt-tether",
              snapshot_date: Math.floor(Date.now() / 1000) - 7 * 86400,
              liquidity_score: 73,
              total_tvl_usd: 1_200_000,
              coverage_confidence: 0.5,
              methodology_version: opts.dexHistoryMethodologyVersion ?? null,
            },
          ] as T[],
        };
      }
      if (sql.includes("FROM blacklist_events")) {
        return {
          results: (opts.blacklistRows ?? []).map((row) => ({
            chain_id: "ethereum",
            config_key: null,
            contract_address: null,
            ...row,
          })) as T[],
        };
      }
      if (sql.includes("FROM yield_data")) {
        const rows = opts.yieldWarningRows ?? [];
        const bestRows = sql.includes("is_best = 1")
          ? rows.filter((row) => row.is_best == null || row.is_best === 1)
          : rows;
        if (sql.includes("publication_state")) {
          return {
            results: bestRows.filter(
              (row) => row.publication_state == null || row.publication_state === "published",
            ) as T[],
          };
        }
        return { results: bestRows as T[] };
      }
      if (sql.includes("FROM mint_burn_hourly")) {
        const freshHourTs = Math.floor(Date.now() / 1000) - 3600;
        if (sql.includes("pharos:dews:mint-burn-30d")) {
          return {
            results: (opts.mintBurn30dRows ?? []).map((row) => ({
              chain_id: "ethereum",
              latest_hour_ts: row.latest_hour_ts ?? freshHourTs,
              ...row,
            })) as T[],
          };
        }
        return {
          results: (opts.mintBurn24hRows ?? []).map((row) => ({
            chain_id: "ethereum",
            latest_hour_ts: row.latest_hour_ts ?? freshHourTs,
            ...row,
          })) as T[],
        };
      }
      return { results: [] as T[] };
    };

    const first = async <T>() => {
      if (sql.includes("FROM dex_liquidity_publication_generations")) {
        if (opts.failDexPublicationDiagnostics) {
          throw new Error("publication diagnostics unavailable");
        }
        if (sql.includes("WHERE state = 'published'")) {
          return (opts.dexPublicationLatestPublished ?? null) as T | null;
        }
        return (opts.dexPublicationLatest ?? null) as T | null;
      }
      if (sql.includes("FROM cache WHERE key = ?")) {
        if (opts.yieldRankingsPayload === undefined) return null as T | null;
        return {
          value: JSON.stringify(opts.yieldRankingsPayload),
          updated_at: opts.yieldRankingsUpdatedAt ?? Math.floor(Date.now() / 1000),
        } as T;
      }
      if (sql.includes("stress_signal_history")) return null as T | null;
      if (sql.includes("stability_index_samples")) return (opts.psiSample ?? null) as T | null;
      return null as T | null;
    };

    let boundArgs: unknown[] = [];
    const run = async () => {
      if (sql.includes("pharos:dews:stress-history-sparse-insert") && typeof boundArgs[0] === "string") {
        computedSnapshotIds.add(boundArgs[0]);
      }
      return { success: true, meta: { changes: 1 } };
    };

    return {
      sql,
      bind: (...args: unknown[]) => {
        boundArgs = args;
        opts.onBind?.(sql, args);
        return { sql, all, first, run };
      },
      all,
      first,
      run,
    };
  };

  return createDewsDb((sql) => stmt(sql));
}
