import { DAY_SECONDS } from "@shared/lib/time-constants";
import { unwrapStressSignalsEnvelope } from "@shared/lib/stress-signals-envelope";
import { decodeJsonString } from "../../lib/cache-json";
import { getDexTrustPolicy, isTrustedDexPriceRow } from "../../lib/depeg-trust-policy";
import { isCanonicalMintBurnPair } from "../../lib/mint-burn-canonical-chain";
import type { DewsSourceState, PersistedJsonDecodeReason } from "./contracts";
import type { YieldRankChangeAttribution, YieldSourceRisk } from "@shared/types/yield";

const DEWS_STALE_DEX_LIQUIDITY_SEC = 2 * 3600;
const DEWS_PREVIOUS_SIGNAL_SMOOTHING_MAX_AGE_SEC = 2 * 3600;
const DEWS_DEX_PRICE_TRUST_POLICY = getDexTrustPolicy("depeg");
const BOOTSTRAP_ALLOWED_MISSING_TABLE_SOURCES = new Set([
  "dex-prices",
  "dex-liquidity-history",
  "blacklist-events",
  "mint-burn-hourly",
  "yield-data",
  "stability-index-samples",
]);

interface LoadDewsSourceStateOptions {
  db: D1Database;
  nowSec: number;
  bootstrapPending: boolean;
  registerSourceFailure: (source: string, error: unknown, options?: { bootstrapAllowed?: boolean }) => void;
  registerMalformedPersistedInput: (options: {
    source: string;
    context: string;
    stablecoinId: string;
    updatedAt?: number | null;
    reason: PersistedJsonDecodeReason;
    degradesRun: boolean;
  }) => void;
}

function isMissingTableError(error: unknown): boolean {
  return String(error).toLowerCase().includes("no such table");
}

function isBootstrapAllowedMissingTableSource(source: string): boolean {
  return BOOTSTRAP_ALLOWED_MISSING_TABLE_SOURCES.has(source);
}

function getObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function getNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getRowAgeSec(updatedAt: number | null | undefined, nowSec: number): number | null {
  return typeof updatedAt === "number" && Number.isFinite(updatedAt) ? Math.max(0, nowSec - updatedAt) : null;
}

function normalizeYieldSourceRisk(value: unknown): YieldSourceRisk | null {
  const row = getObject(value);
  if (!row) return null;
  const venueRiskTier = getString(row.venueRiskTier);
  const deploymentPlace = getString(row.deploymentPlace);
  return {
    sourceRiskScore: getNumber(row.sourceRiskScore),
    sourceRiskPenalty: getNumber(row.sourceRiskPenalty),
    sourceDepthRatio: getNumber(row.sourceDepthRatio),
    rewardShare: getNumber(row.rewardShare),
    sourceAgeSeconds: getNumber(row.sourceAgeSeconds),
    observationCount30d: getNumber(row.observationCount30d),
    sourceSwitchCount30d: getNumber(row.sourceSwitchCount30d),
    deploymentPlace:
      deploymentPlace === "native-wrapper" ||
      deploymentPlace === "issuer-savings" ||
      deploymentPlace === "lending-market" ||
      deploymentPlace === "strategy-vault" ||
      deploymentPlace === "lp-or-dex" ||
      deploymentPlace === "rwa-fund" ||
      deploymentPlace === "reward-program" ||
      deploymentPlace === "rate-derived" ||
      deploymentPlace === "price-derived"
        ? deploymentPlace
        : null,
    venueProtocol: getString(row.venueProtocol),
    venueChain: getString(row.venueChain),
    venueRiskTier:
      venueRiskTier === "low" || venueRiskTier === "medium" || venueRiskTier === "high" || venueRiskTier === "unknown"
        ? venueRiskTier
        : null,
    investabilityFlags: Array.isArray(row.investabilityFlags)
      ? row.investabilityFlags.filter((flag): flag is string => typeof flag === "string")
      : [],
  };
}

function normalizeYieldRankChangeAttribution(value: unknown): YieldRankChangeAttribution | null {
  const row = getObject(value);
  if (!row) return null;
  const primaryDriver = getString(row.primaryDriver);
  return {
    previousRank: getNumber(row.previousRank),
    rankDelta: getNumber(row.rankDelta),
    previousPys: getNumber(row.previousPys),
    pysDelta: getNumber(row.pysDelta),
    primaryDriver:
      primaryDriver === "apy" ||
      primaryDriver === "benchmark" ||
      primaryDriver === "stablecoin-safety" ||
      primaryDriver === "source-risk" ||
      primaryDriver === "source-switch" ||
      primaryDriver === "freshness" ||
      primaryDriver === "volatility" ||
      primaryDriver === "tvl-depth"
        ? primaryDriver
        : null,
    driverContributions: null,
  };
}

export async function loadDewsSourceState(options: LoadDewsSourceStateOptions): Promise<DewsSourceState> {
  const sourceCoverage: Record<string, number> = {};

  let dexLiqRows = {
    results: [],
  } as DewsSourceState["dexLiqRows"];
  try {
    dexLiqRows = await options.db
      .prepare(
        "SELECT stablecoin_id, weighted_balance_ratio, avg_pool_stress, top_pools_json, liquidity_score, total_tvl_usd, updated_at FROM dex_liquidity",
      )
      .all<DewsSourceState["dexLiqRows"]["results"][number]>();
  } catch (error) {
    options.registerSourceFailure("dex-liquidity", error);
  }
  sourceCoverage.dexLiquidity = dexLiqRows.results.length;
  const dexLiqMap = new Map<string, DewsSourceState["dexLiqRows"]["results"][number]>();
  const dexLiqAgeSecById = new Map<string, number>();
  const dexLiqStaleIds = new Set<string>();
  for (const row of dexLiqRows.results) {
    const ageSec = getRowAgeSec(row.updated_at, options.nowSec);
    if (ageSec != null) {
      dexLiqAgeSecById.set(row.stablecoin_id, ageSec);
    }
    if (ageSec == null || ageSec > DEWS_STALE_DEX_LIQUIDITY_SEC) {
      dexLiqStaleIds.add(row.stablecoin_id);
      continue;
    }
    dexLiqMap.set(row.stablecoin_id, row);
  }
  sourceCoverage.dexLiquidityFreshRows = dexLiqMap.size;
  sourceCoverage.dexLiquidityStaleRows = dexLiqStaleIds.size;
  const dexLiquidityUpdatedAt = dexLiqRows.results.reduce<number | null>((latest, row) => {
    if (row.updated_at == null || !Number.isFinite(row.updated_at)) return latest;
    if (latest == null || row.updated_at > latest) return row.updated_at;
    return latest;
  }, null);
  const dexLiquidityAgeSec = dexLiquidityUpdatedAt != null ? Math.max(0, options.nowSec - dexLiquidityUpdatedAt) : null;
  if (dexLiquidityAgeSec != null) {
    sourceCoverage.dexLiquidityAgeSec = dexLiquidityAgeSec;
    if (dexLiquidityAgeSec > DEWS_STALE_DEX_LIQUIDITY_SEC) {
      options.registerSourceFailure(
        "dex-liquidity-freshness",
        `dex_liquidity age ${dexLiquidityAgeSec}s exceeds ${DEWS_STALE_DEX_LIQUIDITY_SEC}s`,
      );
    }
  }

  let dexPriceMap = new Map<string, DewsSourceState["dexPriceMap"] extends Map<string, infer T> ? T : never>();
  const dexPriceAgeSecById = new Map<string, number>();
  const dexPriceStaleIds = new Set<string>();
  try {
    const dexPriceRows = await options.db
      .prepare("SELECT stablecoin_id, dex_price_usd, source_total_tvl, updated_at FROM dex_prices")
      .all<{ stablecoin_id: string; dex_price_usd: number; source_total_tvl: number; updated_at: number }>();
    const trustedDexPriceEntries: Array<
      [string, DewsSourceState["dexPriceMap"] extends Map<string, infer T> ? T : never]
    > = [];
    for (const row of dexPriceRows.results ?? []) {
      const ageSec = getRowAgeSec(row.updated_at, options.nowSec);
      if (ageSec != null) dexPriceAgeSecById.set(row.stablecoin_id, ageSec);
      if (ageSec == null || ageSec >= DEWS_DEX_PRICE_TRUST_POLICY.maxAgeSec) {
        dexPriceStaleIds.add(row.stablecoin_id);
      }
      if (!isTrustedDexPriceRow(row, options.nowSec, "depeg")) continue;
      trustedDexPriceEntries.push([
        row.stablecoin_id,
        {
          dexPriceUsd: row.dex_price_usd,
          sourceTotalTvl: row.source_total_tvl,
          updatedAt: row.updated_at,
        },
      ]);
    }
    dexPriceMap = new Map(trustedDexPriceEntries);
    sourceCoverage.dexPrices = dexPriceMap.size;
    sourceCoverage.dexPricesStaleRows = dexPriceStaleIds.size;
  } catch (error) {
    options.registerSourceFailure("dex-prices", error, {
      bootstrapAllowed:
        options.bootstrapPending && isMissingTableError(error) && isBootstrapAllowedMissingTableSource("dex-prices"),
    });
    sourceCoverage.dexPrices = 0;
  }

  const liqHistCutoff = options.nowSec - 8 * DAY_SECONDS;
  const target7d = options.nowSec - 7 * DAY_SECONDS;
  const liqHist7dMap = new Map<string, { score: number | null; tvl: number | null; date: number }>();
  let liqHistRowsRead = 0;
  try {
    const liqHistRows = await options.db
      .prepare(
        "SELECT stablecoin_id, snapshot_date, liquidity_score, total_tvl_usd FROM dex_liquidity_history WHERE snapshot_date >= ? ORDER BY snapshot_date ASC",
      )
      .bind(liqHistCutoff)
      .all<{
        stablecoin_id: string;
        snapshot_date: number;
        liquidity_score: number | null;
        total_tvl_usd: number | null;
      }>();
    liqHistRowsRead = liqHistRows.results.length;

    for (const row of liqHistRows.results) {
      const existing = liqHist7dMap.get(row.stablecoin_id);
      if (!existing || Math.abs(row.snapshot_date - target7d) < Math.abs(existing.date - target7d)) {
        liqHist7dMap.set(row.stablecoin_id, {
          score: row.liquidity_score ?? null,
          tvl: row.total_tvl_usd ?? null,
          date: row.snapshot_date,
        });
      }
    }
  } catch (error) {
    options.registerSourceFailure("dex-liquidity-history", error, {
      bootstrapAllowed:
        options.bootstrapPending &&
        isMissingTableError(error) &&
        isBootstrapAllowedMissingTableSource("dex-liquidity-history"),
    });
  }
  sourceCoverage.dexLiquidityHistory = liqHistRowsRead;

  const blacklistCounts = new Map<string, { count24h: number; count7d: number }>();
  let blacklistRowsRead = 0;
  try {
    const bl7d = await options.db
      .prepare("SELECT stablecoin, COUNT(*) as cnt FROM blacklist_events WHERE timestamp >= ? GROUP BY stablecoin")
      .bind(options.nowSec - 7 * DAY_SECONDS)
      .all<{ stablecoin: string; cnt: number }>();
    const bl24h = await options.db
      .prepare("SELECT stablecoin, COUNT(*) as cnt FROM blacklist_events WHERE timestamp >= ? GROUP BY stablecoin")
      .bind(options.nowSec - DAY_SECONDS)
      .all<{ stablecoin: string; cnt: number }>();
    blacklistRowsRead = (bl7d.results?.length ?? 0) + (bl24h.results?.length ?? 0);

    const map7d = new Map(bl7d.results.map((row) => [row.stablecoin, row.cnt]));
    const map24h = new Map(bl24h.results.map((row) => [row.stablecoin, row.cnt]));

    for (const [symbol, count7d] of map7d) {
      blacklistCounts.set(symbol, {
        count24h: map24h.get(symbol) ?? 0,
        count7d,
      });
    }
  } catch (error) {
    options.registerSourceFailure("blacklist-events", error, {
      bootstrapAllowed:
        options.bootstrapPending &&
        isMissingTableError(error) &&
        isBootstrapAllowedMissingTableSource("blacklist-events"),
    });
  }
  sourceCoverage.blacklistEvents = blacklistRowsRead;

  const prevSignals = new Map<
    string,
    { signals: Record<string, { value: number }>; computedAt: number; ageSec: number }
  >();
  const prevSignalStaleIds = new Set<string>();
  let prevSignalRowsRead = 0;
  try {
    const prevRows = await options.db
      .prepare(
        `SELECT s.stablecoin_id, s.signals_json, s.band, s.computed_at
         FROM stress_signals s
         INNER JOIN (
           SELECT stablecoin_id, MAX(computed_at) as max_at
           FROM stress_signals GROUP BY stablecoin_id
         ) latest ON s.stablecoin_id = latest.stablecoin_id AND s.computed_at = latest.max_at`,
      )
      .all<{ stablecoin_id: string; signals_json: string; band: string; computed_at: number }>();
    prevSignalRowsRead = prevRows.results.length;
    for (const row of prevRows.results) {
      const ageSec = getRowAgeSec(row.computed_at, options.nowSec);
      if (ageSec == null || ageSec > DEWS_PREVIOUS_SIGNAL_SMOOTHING_MAX_AGE_SEC) {
        prevSignalStaleIds.add(row.stablecoin_id);
        continue;
      }
      const decoded = decodeJsonString<Record<string, unknown>, PersistedJsonDecodeReason>(row.signals_json, {
        mode: "degraded",
        updatedAt: row.computed_at,
        missingReason: "missing",
        parseErrorReason: "json-parse-failed",
        normalize: (parsed) => {
          const unwrapped = unwrapStressSignalsEnvelope(parsed);
          if (unwrapped == null) {
            return { ok: false, reason: "invalid-shape" as const };
          }
          return { ok: true, payload: unwrapped.signals };
        },
      });
      if (!decoded.ok) {
        options.registerMalformedPersistedInput({
          source: "stress_signals",
          context: "stress_signals.signals_json",
          stablecoinId: row.stablecoin_id,
          updatedAt: row.computed_at,
          reason: decoded.reason,
          degradesRun: true,
        });
        continue;
      }
      prevSignals.set(row.stablecoin_id, {
        signals: decoded.payload as Record<string, { value: number }>,
        computedAt: row.computed_at,
        ageSec,
      });
    }
  } catch (error) {
    options.registerSourceFailure("stress-signals", error);
  }
  sourceCoverage.previousStressSignals = prevSignalRowsRead;
  sourceCoverage.previousStressSignalsFreshRows = prevSignals.size;
  sourceCoverage.previousStressSignalsStaleRows = prevSignalStaleIds.size;

  const mintBurnMap = new Map<
    string,
    {
      burn24h: number;
      mint24h: number;
      burnBaseline: number;
      mintBaseline: number;
      dataAgeDays: number;
      baselineDays: number;
    }
  >();
  let mintBurnRowsRead = 0;
  try {
    const mb24h = await options.db
      .prepare(
        `SELECT stablecoin_id, chain_id,
                SUM(CASE WHEN burn_volume_usd IS NOT NULL THEN burn_volume_usd ELSE 0 END) as total_burn,
                SUM(CASE WHEN mint_volume_usd IS NOT NULL THEN mint_volume_usd ELSE 0 END) as total_mint
         FROM mint_burn_hourly WHERE hour_ts >= ? GROUP BY stablecoin_id, chain_id`,
      )
      .bind(options.nowSec - DAY_SECONDS)
      .all<{ stablecoin_id: string; chain_id: string; total_burn: number; total_mint: number }>();

    const mb30d = await options.db
      .prepare(
        `SELECT stablecoin_id, chain_id,
                SUM(CASE WHEN burn_volume_usd IS NOT NULL THEN burn_volume_usd ELSE 0 END) as total_burn,
                SUM(CASE WHEN mint_volume_usd IS NOT NULL THEN mint_volume_usd ELSE 0 END) as total_mint,
                COUNT(DISTINCT date(hour_ts, 'unixepoch')) as days_with_data
         FROM mint_burn_hourly WHERE hour_ts >= ? GROUP BY stablecoin_id, chain_id`,
      )
      .bind(options.nowSec - 30 * DAY_SECONDS)
      .all<{
        stablecoin_id: string;
        chain_id: string;
        total_burn: number;
        total_mint: number;
        days_with_data: number;
      }>();
    mintBurnRowsRead = (mb24h.results?.length ?? 0) + (mb30d.results?.length ?? 0);

    const mb24hMap = new Map<string, { total_burn: number; total_mint: number }>();
    for (const row of mb24h.results) {
      if (!isCanonicalMintBurnPair(row.stablecoin_id, row.chain_id)) continue;
      const aggregate = mb24hMap.get(row.stablecoin_id) ?? { total_burn: 0, total_mint: 0 };
      aggregate.total_burn += row.total_burn;
      aggregate.total_mint += row.total_mint;
      mb24hMap.set(row.stablecoin_id, aggregate);
    }
    const mb30dMap = new Map<string, { avg_burn: number; avg_mint: number; days_with_data: number }>();
    for (const row of mb30d.results) {
      if (!isCanonicalMintBurnPair(row.stablecoin_id, row.chain_id)) continue;
      const aggregate = mb30dMap.get(row.stablecoin_id) ?? { avg_burn: 0, avg_mint: 0, days_with_data: 0 };
      const observedDays = Math.max(0, row.days_with_data);
      aggregate.avg_burn += observedDays > 0 ? row.total_burn / observedDays : 0;
      aggregate.avg_mint += observedDays > 0 ? row.total_mint / observedDays : 0;
      aggregate.days_with_data = Math.max(aggregate.days_with_data, observedDays);
      mb30dMap.set(row.stablecoin_id, aggregate);
    }
    const mintBurnIds = new Set([...mb24hMap.keys(), ...mb30dMap.keys()]);

    for (const stablecoinId of mintBurnIds) {
      const latestWindow = mb24hMap.get(stablecoinId);
      const baseline = mb30dMap.get(stablecoinId);
      mintBurnMap.set(stablecoinId, {
        burn24h: latestWindow?.total_burn ?? 0,
        mint24h: latestWindow?.total_mint ?? 0,
        burnBaseline: baseline?.avg_burn ?? 0,
        mintBaseline: baseline?.avg_mint ?? 0,
        dataAgeDays: baseline?.days_with_data ?? 0,
        baselineDays: baseline?.days_with_data ?? 0,
      });
    }
  } catch (error) {
    options.registerSourceFailure("mint-burn-hourly", error, {
      bootstrapAllowed:
        options.bootstrapPending &&
        isMissingTableError(error) &&
        isBootstrapAllowedMissingTableSource("mint-burn-hourly"),
    });
  }
  sourceCoverage.mintBurnHourly = mintBurnRowsRead;

  const yieldWarnings = new Map<string, string[]>();
  let yieldWarningRowsRead = 0;
  try {
    const yieldRows = await options.db
      .prepare(
        `SELECT stablecoin_id, warning_signals
         FROM yield_data
         WHERE is_best = 1
           AND warning_signals IS NOT NULL
           AND warning_signals != '[]'
           AND (publication_state IS NULL OR publication_state = 'published')`,
      )
      .all<{ stablecoin_id: string; warning_signals: string }>();
    yieldWarningRowsRead = yieldRows.results.length;
    for (const row of yieldRows.results) {
      const decoded = decodeJsonString<string[], PersistedJsonDecodeReason>(row.warning_signals, {
        mode: "degraded",
        missingReason: "missing",
        parseErrorReason: "json-parse-failed",
        normalize: (parsed) => {
          if (!Array.isArray(parsed) || !parsed.every((signal) => typeof signal === "string")) {
            return { ok: false, reason: "invalid-shape" as const };
          }
          return { ok: true, payload: parsed };
        },
      });
      if (!decoded.ok) {
        options.registerMalformedPersistedInput({
          source: "yield_data",
          context: "yield_data.warning_signals",
          stablecoinId: row.stablecoin_id,
          reason: decoded.reason,
          degradesRun: true,
        });
        continue;
      }
      yieldWarnings.set(row.stablecoin_id, decoded.payload);
    }
  } catch (error) {
    options.registerSourceFailure("yield-data", error, {
      bootstrapAllowed:
        options.bootstrapPending && isMissingTableError(error) && isBootstrapAllowedMissingTableSource("yield-data"),
    });
  }
  sourceCoverage.yieldWarnings = yieldWarningRowsRead;

  const yieldSourceRisk = new Map<string, YieldSourceRisk>();
  const yieldRankChangeAttribution = new Map<string, YieldRankChangeAttribution>();
  try {
    const rankingsCache = await options.db
      .prepare("SELECT value, updated_at FROM cache WHERE key = ?")
      .bind("yield-rankings")
      .first<{ value: string | null; updated_at: number | null }>();
    const decoded = decodeJsonString<unknown[], PersistedJsonDecodeReason>(rankingsCache?.value ?? null, {
      mode: "degraded",
      updatedAt: rankingsCache?.updated_at ?? null,
      missingReason: "missing",
      parseErrorReason: "json-parse-failed",
      normalize: (parsed) => {
        const payload = getObject(parsed);
        return Array.isArray(payload?.rankings)
          ? { ok: true, payload: payload.rankings }
          : { ok: false, reason: "invalid-shape" as const };
      },
    });
    if (decoded.ok) {
      for (const ranking of decoded.payload) {
        const row = getObject(ranking);
        const stablecoinId = getString(row?.id);
        if (!stablecoinId) continue;

        const sourceRisk = normalizeYieldSourceRisk(row?.sourceRisk);
        if (sourceRisk) yieldSourceRisk.set(stablecoinId, sourceRisk);

        const rankChangeAttribution = normalizeYieldRankChangeAttribution(row?.rankChangeAttribution);
        if (rankChangeAttribution) yieldRankChangeAttribution.set(stablecoinId, rankChangeAttribution);
      }
    } else if (rankingsCache?.value != null) {
      options.registerMalformedPersistedInput({
        source: "yield-rankings",
        context: "cache.yield-rankings",
        stablecoinId: "aggregate",
        updatedAt: rankingsCache?.updated_at ?? null,
        reason: decoded.reason,
        degradesRun: false,
      });
    }
  } catch (error) {
    options.registerSourceFailure("yield-rankings", error, {
      bootstrapAllowed:
        options.bootstrapPending && isMissingTableError(error) && isBootstrapAllowedMissingTableSource("yield-data"),
    });
  }
  sourceCoverage.yieldStructuredRows = yieldSourceRisk.size;

  let latestPsiScore: number | null = null;
  try {
    const psiRow = await options.db
      .prepare("SELECT score FROM stability_index_samples ORDER BY stored_at DESC LIMIT 1")
      .first<{ score: number }>();
    if (psiRow) latestPsiScore = psiRow.score;
  } catch (error) {
    options.registerSourceFailure("stability-index-samples", error, {
      bootstrapAllowed:
        options.bootstrapPending &&
        isMissingTableError(error) &&
        isBootstrapAllowedMissingTableSource("stability-index-samples"),
    });
  }

  return {
    dexLiqRows,
    dexLiqMap,
    dexLiqAgeSecById,
    dexLiqStaleIds,
    dexPriceMap,
    dexPriceAgeSecById,
    dexPriceStaleIds,
    liqHist7dMap,
    liqHistRowsRead,
    blacklistCounts,
    prevSignals,
    prevSignalStaleIds,
    mintBurnMap,
    yieldWarnings,
    yieldSourceRisk,
    yieldRankChangeAttribution,
    latestPsiScore,
    sourceCoverage,
  };
}
