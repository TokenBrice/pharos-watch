import { formatCompactUsdWithOptions } from "@shared/lib/format";
import { getCirculatingRaw } from "@shared/lib/supply";
import { DEX_LIQUIDITY_PUBLISHED_ROW_FILTER } from "../lib/dex-liquidity";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { loadActiveSafetyScoreSource } from "../lib/safety-score-active-source";
import { buildInClause, chunkArray } from "../lib/db";
import { classifyTelegramLogError, logTelegramEvent } from "../lib/telegram-log";
import { getMintBurnConfigsForStablecoin } from "../lib/mint-burn-contracts";
import { perCoinFlowCacheKey } from "../lib/mint-burn-flows-service";
import { getCache } from "../lib/db-cache";
import { safeJsonParse } from "../lib/api-cache-read";

/** 24h mint/burn flow older than this is omitted from the terse alert Context line. */
const MINT_BURN_FLOW_STALE_SEC = 6 * 3600;
const ALERT_USD_PROFILE = {
  decimals: { trillion: 1, billion: 1, million: 1, thousand: 1, unit: 0 },
  invalidFallback: "n/a",
  maximumTier: "billion",
  signPosition: "after-currency",
} as const;

function formatUsdCompact(value: number | null | undefined): string {
  return formatCompactUsdWithOptions(value, ALERT_USD_PROFILE);
}

function formatSignedUsdCompact(value: number): string {
  return formatCompactUsdWithOptions(value, {
    ...ALERT_USD_PROFILE,
    positiveSign: true,
    signPosition: "before-currency",
  });
}

export async function buildAlertContextLines(
  db: D1Database,
  stablecoinIds: readonly string[],
): Promise<Map<string, string>> {
  const uniqueIds = Array.from(new Set(stablecoinIds));
  if (uniqueIds.length === 0) return new Map();
  const nowSec = Math.floor(Date.now() / 1000);

  const [snapshot, stablecoinsResult, liquidityResult, flowResult] = await Promise.all([
    loadActiveSafetyScoreSource(db).then((source) =>
      source.kind === "v9" ? source : null,
    ).catch(() => null),
    loadStablecoinsCache(db, { mode: "strict" }).catch(() => null),
    loadLiquidityRows(db, uniqueIds),
    loadFlowRows(db, uniqueIds, nowSec),
  ]);

  const cards = new Map((snapshot?.snapshot.cards ?? []).map((card) => [card.id, card]));
  const supplies = new Map<string, number>();
  if (stablecoinsResult?.kind === "ok") {
    const wantedIds = new Set(uniqueIds);
    for (const asset of stablecoinsResult.payload.peggedAssets) {
      if (wantedIds.has(asset.id)) {
        supplies.set(asset.id, getCirculatingRaw(asset));
      }
    }
  }

  const out = new Map<string, string>();
  for (const id of uniqueIds) {
    const parts: string[] = [];
    const card = cards.get(id);
    const liq = liquidityResult.get(id);
    if (card) {
      parts.push(
        `Safety ${card.grade}${card.score != null ? ` ${card.score}` : ""} (${snapshot!.snapshot.safetyScoreIdentity.model.toUpperCase()} ${snapshot!.snapshot.safetyScoreIdentity.methodologyVersion})`,
      );
    }
    if (liq) parts.push(`Liquidity ${liq.score ?? "NR"}, DEX TVL ${formatUsdCompact(liq.tvl)}`);
    const supply = supplies.get(id);
    if (supply != null) parts.push(`Supply ${formatUsdCompact(supply)}`);
    const flow = flowResult.get(id);
    if (flow && flow.netFlowUsd !== 0) parts.push(`Flow24h ${formatSignedUsdCompact(flow.netFlowUsd)}`);
    if (parts.length > 0) out.set(id, `Context: ${parts.join(" · ")}`);
  }

  return out;
}

async function loadLiquidityRows(
  db: D1Database,
  stablecoinIds: readonly string[],
): Promise<Map<string, { score: number | null; tvl: number }>> {
  const uniqueIds = Array.from(new Set(stablecoinIds));
  if (uniqueIds.length === 0) return new Map();
  const rows: Array<{ stablecoin_id: string; liquidity_score: number | null; total_tvl_usd: number }> = [];
  for (const idChunk of chunkArray(uniqueIds)) {
    const inClause = buildInClause(idChunk);
    try {
      const result = await db
        .prepare(
          `SELECT stablecoin_id, liquidity_score, total_tvl_usd
           FROM dex_liquidity
           WHERE stablecoin_id IN (${inClause.sql})
             AND ${DEX_LIQUIDITY_PUBLISHED_ROW_FILTER}`,
        )
        .bind(...inClause.binds)
        .all<{ stablecoin_id: string; liquidity_score: number | null; total_tvl_usd: number }>();
      rows.push(...(result.results ?? []));
    } catch (error) {
      logTelegramEvent({
        level: "warn",
        message: "Failed to load Telegram alert liquidity context",
        action: "alert-context-liquidity",
        module: "telegram-alert-context",
        requestedStablecoinCount: uniqueIds.length,
        chunkSize: idChunk.length,
        errorClass: classifyTelegramLogError(error),
      });
    }
  }

  return new Map(rows.map((row) => [row.stablecoin_id, { score: row.liquidity_score, tvl: row.total_tvl_usd }]));
}

/**
 * Reads cached 24h net mint/burn flow for the mint-burn-tracked subset of the requested ids
 * (no recompute) as one bounded Promise.all. Stale/missing/malformed entries are omitted so the
 * Context line only carries fresh, meaningful flow. D1 cache reads are not subject to the
 * repo-defined six-request outbound budget, and the set is bounded to tracked coins.
 */
async function loadFlowRows(
  db: D1Database,
  stablecoinIds: readonly string[],
  nowSec: number,
): Promise<Map<string, { netFlowUsd: number; updatedAt: number }>> {
  const trackedIds = Array.from(new Set(stablecoinIds)).filter((id) => getMintBurnConfigsForStablecoin(id).length > 0);
  if (trackedIds.length === 0) return new Map();

  const entries = await Promise.all(
    trackedIds.map(async (id) => {
      try {
        const cached = await getCache(db, perCoinFlowCacheKey(id, 24));
        if (!cached) return null;
        const parsed = safeJsonParse<{ netFlowUsd?: unknown; updatedAt?: unknown } | null>(
          cached.value,
          null,
          "telegram-context-flow",
        );
        if (!parsed || typeof parsed.netFlowUsd !== "number" || !Number.isFinite(parsed.netFlowUsd)) {
          return null;
        }
        const updatedAt = typeof parsed.updatedAt === "number" ? parsed.updatedAt : cached.updatedAt;
        if (nowSec - updatedAt > MINT_BURN_FLOW_STALE_SEC) return null;
        return { id, netFlowUsd: parsed.netFlowUsd, updatedAt };
      } catch {
        return null;
      }
    }),
  );

  const out = new Map<string, { netFlowUsd: number; updatedAt: number }>();
  for (const entry of entries) {
    if (entry) out.set(entry.id, { netFlowUsd: entry.netFlowUsd, updatedAt: entry.updatedAt });
  }
  return out;
}
