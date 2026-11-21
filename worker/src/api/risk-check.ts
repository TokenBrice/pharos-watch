import type { ApiDependencyMeta, ApiMetaEnvelope } from "@pharos/contracts/api-meta";
import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { RISK_CHECK_MAX_ASSETS } from "@shared/lib/api-endpoints/queries";
import { API_FRESHNESS_MAX_AGE_SEC, STRESS_SIGNALS_DEGRADED_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { isBlacklistStablecoin } from "@shared/lib/blacklist";
import { GENIUS_REGIME_STATE, isGeniusRegimeEffective } from "@shared/lib/compliance-regime-state";
import { parseContractTuple } from "@shared/lib/deployment-resolver";
import { applyDurationStaleness } from "@shared/lib/depeg-resolver/public-contract";
import {
  WORKER_TRACKED_META_BY_ID,
  type WorkerRuntimeStablecoinMeta,
} from "@shared/lib/stablecoins/worker-runtime-registry";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { DdrResponse, DdrV2ResponseRow } from "@shared/types/depeg-resolver";
import { PegSummaryCoinSchema, type PegSummaryCoin } from "@shared/types/peg";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import type {
  RiskCheckAsset,
  RiskCheckResponse,
  RiskCheckUnresolvedInput,
} from "@shared/types/risk-check";
import { addFreshnessHeaders, buildFreshnessMeta } from "../lib/api-freshness";
import { assessFreshnessTimestamp } from "../lib/api-freshness-age";
import { jsonResponse } from "../lib/api-response";
import { buildInClause } from "../lib/db";
import {
  decodeActiveIncidentProjections,
  EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL,
  prepareActiveIncidentProjections,
  rowToPublicDepegEvent,
} from "../lib/depeg-event-projection";
import type { DepegRow } from "../lib/depeg-helpers";
import { loadPredictionErrata } from "../lib/depeg-resolver-errata-store";
import { loadLatestPublicationManifest, type DdrPublicationManifest } from "../lib/depeg-resolver-publication-store";
import { parseDepegResolverSnapshotRow } from "../lib/depeg-resolver-snapshot-cache";
import { DEWS_PUBLICATION_POINTER_CACHE_KEY, parseDewsPublishedGeneration } from "../lib/dews-publication-pointer";
import { dexLiquidityPublishedRowFilter, normalizeDexLiquidityEvidence } from "../lib/dex-liquidity";
import { mentoFpmmIds, nextMentoHour, projectMentoMarketPhase } from "../lib/redemption-backstop-capacity/mento-phase";
import {
  decodeRedemptionBackstopRow,
  REDEMPTION_BACKSTOP_ROW_COLUMNS,
  type RedemptionBackstopRow,
} from "../lib/redemption-backstops-store";
import { loadActiveSafetyScoreIndex } from "../lib/safety-score-index";
import {
  isSafetyScoreV9SnapshotFresh,
  SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC,
} from "../lib/safety-score-v9/consumer-freshness";
import { resolveMentoFxMarketReopen } from "../lib/stablecoin-publication-coverage";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import { loadComplianceIndex, resolveComplianceUpdatedAtSec } from "./compliance";
import { resolveContractDeployment } from "./resolve";

const COMPLIANCE_REVIEW_BUDGET_SEC = 90 * DAY_SECONDS;
const CACHE_KEYS_FOR_RISK_CHECK = [
  "stablecoins",
  "peg-analytics",
  "depeg-resolver:snapshot",
  DEWS_PUBLICATION_POINTER_CACHE_KEY,
] as const;

interface RawCacheRow {
  key: string;
  value: string;
  updated_at: number;
}

interface SlimDexLiquidityRow {
  stablecoin_id: string;
  total_tvl_usd: number;
  total_volume_24h_usd: number;
  pool_count: number;
  liquidity_score: number | null;
  updated_at: number;
  coverage_class: string | null;
  coverage_confidence: number | null;
  effective_tvl_usd: number | null;
  balance_measured_tvl_usd: number | null;
  organic_measured_tvl_usd: number | null;
  publication_generation_id: string | null;
  dex_price_usd: number | null;
  dex_price_updated_at: number | null;
}

interface LatestRedemptionRunRow {
  run_id: string;
  completed_at: number | null;
  expected_count: number;
  written_count: number;
  max_updated_at: number | null;
  methodology_version: string;
}

interface DewsRow {
  stablecoin_id: string;
  score: number;
  band: string;
  computed_at: number;
}

interface PegAnalyticsParsed {
  ok: true;
  computedAtSec: number;
  byId: Map<string, PegSummaryCoin>;
}

type PegAnalyticsLoad =
  | PegAnalyticsParsed
  | { ok: false; reason: string };

function splitCsvParam(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parsePegAnalyticsCacheRow(
  row: { value: string; updatedAt: number } | null,
  targetIds: ReadonlySet<string>,
  nowSec: number,
): PegAnalyticsLoad {
  if (!row) return { ok: false, reason: "cache-missing" };
  const clock = assessFreshnessTimestamp(nowSec, row.updatedAt);
  if (clock.reason != null) return { ok: false, reason: clock.reason };
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return { ok: false, reason: "json-parse-failed" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "invalid-payload" };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.computedAtSec !== "number" || !Number.isFinite(obj.computedAtSec) || !Array.isArray(obj.pegData)) {
    return { ok: false, reason: "invalid-payload" };
  }
  const byId = new Map<string, PegSummaryCoin>();
  for (const item of obj.pegData) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rawId = (item as { id?: unknown }).id;
    if (typeof rawId !== "string" || !targetIds.has(rawId)) continue;
    const validated = PegSummaryCoinSchema.safeParse(item);
    if (validated.success) {
      byId.set(rawId, validated.data);
    }
  }
  return { ok: true, computedAtSec: obj.computedAtSec, byId };
}

function classifyDewsAge(
  computedAt: number,
  nowSec: number,
  publishedAtSec: number | null,
): "fresh" | "lagging" | "stale" | "retainedLastValid" {
  if (publishedAtSec != null && computedAt < publishedAtSec) {
    return "retainedLastValid";
  }
  const ageSec = Math.max(0, nowSec - computedAt);
  if (ageSec <= API_FRESHNESS_MAX_AGE_SEC.stressSignals) return "fresh";
  if (ageSec <= STRESS_SIGNALS_DEGRADED_MAX_AGE_SEC) return "lagging";
  return "stale";
}

function ddrCacheMatchesManifest(snapshot: DdrResponse, manifest: DdrPublicationManifest | null): boolean {
  if (!manifest) return true;
  if (snapshot._meta.snapshotToken !== manifest.snapshotToken) return false;
  if (snapshot._meta.snapshotGeneration !== manifest.snapshotGeneration) return false;
  if (snapshot._meta.basePayloadHash !== manifest.basePayloadHash) return false;
  return true;
}

function buildDependencyMeta(
  updatedAt: number | null,
  maxAgeSec: number,
  cacheKey: string,
  nowSec: number,
  options: {
    freshBudgetSec?: number;
    degradedBudgetSec?: number;
    generationId?: string | null;
    unavailableReason?: string | null;
    forceStatus?: ApiDependencyMeta["status"];
    reason?: string | null;
  } = {},
): ApiDependencyMeta {
  const freshBudgetSec = options.freshBudgetSec ?? maxAgeSec;
  if (options.unavailableReason || updatedAt == null) {
    return {
      updatedAt: updatedAt ?? null,
      ageSeconds: updatedAt != null ? Math.max(0, nowSec - updatedAt) : null,
      freshBudgetSec,
      generationId: options.generationId ?? null,
      status: "unavailable",
      reason: options.unavailableReason ?? "unavailable",
    };
  }
  const freshness = buildFreshnessMeta(updatedAt, maxAgeSec, cacheKey, {
    assessedAt: nowSec,
    freshBudgetSec,
    degradedBudgetSec: options.degradedBudgetSec ?? freshBudgetSec * 2,
  });
  return {
    updatedAt: freshness.updatedAt,
    ageSeconds: freshness.ageSeconds,
    freshBudgetSec: freshness.freshBudgetSec,
    generationId: options.generationId ?? null,
    status: options.forceStatus ?? freshness.status,
    reason: options.reason ?? (freshness.status === "fresh" ? null : `${cacheKey}-${freshness.status}`),
  };
}

function selectActiveDepegForCoin(
  rows: readonly DepegRow[],
  projections: Parameters<typeof rowToPublicDepegEvent>[1],
): Map<string, { eventId: number; startedAt: number; direction: "above" | "below"; peakDeviationBps: number }> {
  const map = new Map<string, { eventId: number; startedAt: number; direction: "above" | "below"; peakDeviationBps: number }>();
  for (const row of rows) {
    const projected = rowToPublicDepegEvent(row, projections);
    if (projected.provenance?.pegScoreEligible === false) continue;
    const candidate = {
      eventId: projected.id,
      startedAt: projected.startedAt,
      direction: projected.direction,
      peakDeviationBps: projected.peakDeviationBps,
    };
    const existing = map.get(projected.stablecoinId);
    if (!existing || Math.abs(candidate.peakDeviationBps) > Math.abs(existing.peakDeviationBps)) {
      map.set(projected.stablecoinId, candidate);
    }
  }
  return map;
}

export async function handleRiskCheck(db: D1Database, url: URL): Promise<Response> {
  const idInputs = splitCsvParam(url.searchParams.get("ids"));
  const contractInputs = splitCsvParam(url.searchParams.get("contracts"));
  const requestedCount = idInputs.length + contractInputs.length;

  if (requestedCount === 0) {
    return jsonResponse(
      { error: "Provide at least one asset via ids or contracts", reason: "missing-assets" },
      { status: 400 },
    );
  }
  if (requestedCount > RISK_CHECK_MAX_ASSETS) {
    return jsonResponse(
      {
        error: `Maximum ${RISK_CHECK_MAX_ASSETS} assets per risk-check request`,
        reason: "too-many-assets",
        max: RISK_CHECK_MAX_ASSETS,
      },
      { status: 400 },
    );
  }

  const resolvedIds: string[] = [];
  const resolvedIdSet = new Set<string>();
  const unresolved: RiskCheckUnresolvedInput[] = [];

  for (const rawId of idInputs) {
    const meta = WORKER_TRACKED_META_BY_ID.get(rawId);
    if (!meta) {
      unresolved.push({ input: rawId, kind: "id", reason: "unknown-stablecoin" });
      continue;
    }
    if (!resolvedIdSet.has(meta.id)) {
      resolvedIdSet.add(meta.id);
      resolvedIds.push(meta.id);
    }
  }

  for (const rawContract of contractInputs) {
    const tuple = parseContractTuple(rawContract);
    if (!tuple) {
      unresolved.push({ input: rawContract, kind: "contract", reason: "invalid-contract" });
      continue;
    }
    const resolved = resolveContractDeployment(tuple.rawChain, tuple.rawAddress);
    if (!resolved.ok) {
      unresolved.push({ input: rawContract, kind: "contract", reason: resolved.reason });
      continue;
    }
    const canonicalId = resolved.entry.coin.id;
    if (!resolvedIdSet.has(canonicalId)) {
      resolvedIdSet.add(canonicalId);
      resolvedIds.push(canonicalId);
    }
  }

  if (resolvedIds.length === 0) {
    return jsonResponse(
      {
        error: "None of the requested assets matched tracked stablecoins",
        reason: "no-resolved-assets",
        unresolved,
      },
      { status: 404 },
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const idInClause = buildInClause(resolvedIds);
  const cacheInClause = buildInClause([...CACHE_KEYS_FOR_RISK_CHECK]);

  // Round 1: parallel D1 reads + lazy in-memory compliance index (0 D1 reads)
  const [
    cacheQueryResult,
    safetyIndex,
    activeDepegsRead,
    activeProjectionRead,
    dexRead,
    latestRedemptionRunRead,
    complianceIndex,
  ] = await Promise.all([
    db.prepare(`SELECT key, value, updated_at FROM cache WHERE key IN (${cacheInClause.sql})`)
      .bind(...cacheInClause.binds)
      .all<RawCacheRow>()
      .then((res) => ({ ok: true as const, rows: res.results ?? [] }))
      .catch(() => ({ ok: false as const, rows: [] as RawCacheRow[] })),
    loadActiveSafetyScoreIndex(db, undefined, { includePillarsForIds: resolvedIds }),
    db.prepare(
      `SELECT * FROM depeg_events_with_provenance
        WHERE ended_at IS NULL
          AND stablecoin_id IN (${idInClause.sql})
          AND ${EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL}`,
    )
      .bind(...idInClause.binds)
      .all<DepegRow>()
      .then((res) => ({ ok: true as const, rows: res.results ?? [] }))
      .catch(() => ({ ok: false as const, rows: [] as DepegRow[] })),
    prepareActiveIncidentProjections(db, resolvedIds.length === 1 ? resolvedIds[0] : null)
      .all()
      .then((res) => decodeActiveIncidentProjections(res))
      .catch(() => ({ available: false as const, reason: "incident-projection-read-failed" as const })),
    db.prepare(
      `SELECT d.stablecoin_id, d.total_tvl_usd, d.total_volume_24h_usd, d.pool_count,
              d.liquidity_score, d.updated_at, d.coverage_class, d.coverage_confidence,
              d.effective_tvl_usd, d.balance_measured_tvl_usd, d.organic_measured_tvl_usd,
              d.publication_generation_id, p.dex_price_usd, p.updated_at AS dex_price_updated_at
         FROM dex_liquidity d
         LEFT JOIN dex_prices p ON p.stablecoin_id = d.stablecoin_id
        WHERE ${dexLiquidityPublishedRowFilter("d")}
          AND (d.stablecoin_id IN (${idInClause.sql}) OR d.stablecoin_id = '__global__')`,
    )
      .bind(...idInClause.binds)
      .all<SlimDexLiquidityRow>()
      .then((res) => ({ ok: true as const, rows: res.results ?? [] }))
      .catch(() => ({ ok: false as const, rows: [] as SlimDexLiquidityRow[] })),
    db.prepare(
      `SELECT run_id, completed_at, expected_count, written_count, max_updated_at, methodology_version
         FROM redemption_backstop_runs
        WHERE status = 'completed' AND written_count = expected_count
        ORDER BY completed_at DESC
        LIMIT 1`,
    )
      .first<LatestRedemptionRunRow>()
      .then((row) => ({ ok: true as const, row }))
      .catch(() => ({ ok: false as const, row: null })),
    loadComplianceIndex(),
  ]);

  const cacheByKey = new Map<string, { value: string; updatedAt: number }>();
  if (cacheQueryResult.ok) {
    for (const row of cacheQueryResult.rows) {
      cacheByKey.set(row.key, { value: row.value, updatedAt: row.updated_at });
    }
  }

  const stablecoinsCache = cacheQueryResult.ok
    ? await loadStablecoinsCache(db, {
        mode: "lenient",
        preloadedCache: cacheByKey.get("stablecoins") ?? null,
      })
    : { kind: "error" as const, reason: "cache-read-failed", updatedAt: null };

  const pegAnalytics = cacheQueryResult.ok
    ? parsePegAnalyticsCacheRow(cacheByKey.get("peg-analytics") ?? null, resolvedIdSet, nowSec)
    : { ok: false as const, reason: "cache-read-failed" };

  const ddrCacheLoad = cacheQueryResult.ok
    ? parseDepegResolverSnapshotRow(cacheByKey.get("depeg-resolver:snapshot") ?? null)
    : { kind: "error" as const, reason: "cache-read-failed", updatedAt: null };

  const dewsPointer = cacheQueryResult.ok
    ? parseDewsPublishedGeneration(cacheByKey.get(DEWS_PUBLICATION_POINTER_CACHE_KEY) ?? null, nowSec)
    : { status: "read-failed" as const, error: "cache-read-failed" };

  const ddrSnapshot = ddrCacheLoad.kind === "ok"
    ? applyDurationStaleness(ddrCacheLoad.payload, nowSec)
    : null;
  const matchingDdrRows = ddrSnapshot
    ? ddrSnapshot.rows.filter((row) => resolvedIdSet.has(row.stablecoinId))
    : [];
  const ddrPredictionIds = matchingDdrRows
    .map((row) => row.prediction.publicPredictionId)
    .filter((id): id is number => id != null);

  // Round 2: parallel conditioned reads (DEWS rows, Redemption rows, conditional DDR overlay)
  const [dewsRowsRead, redemptionRowsRead, ddrOverlayRead] = await Promise.all([
    dewsPointer.status === "ok"
      ? (dewsPointer.expectedRowCount != null && dewsPointer.stablecoinIdsDigest != null
          ? db.prepare(
              `SELECT stablecoin_id, score, band, computed_at
                 FROM stress_signal_publication_rows
                WHERE computed_at = ? AND stablecoin_id IN (${idInClause.sql})`,
            )
              .bind(dewsPointer.computedAt, ...idInClause.binds)
              .all<DewsRow>()
          : db.prepare(
              `SELECT stablecoin_id, score, band, computed_at
                 FROM stress_signals_latest
                WHERE stablecoin_id IN (${idInClause.sql}) AND computed_at <= ?`,
            )
              .bind(...idInClause.binds, dewsPointer.computedAt)
              .all<DewsRow>()
        )
          .then((res) => ({ ok: true as const, rows: res.results ?? [] }))
          .catch(() => ({ ok: false as const, rows: [] as DewsRow[] }))
      : Promise.resolve({ ok: true as const, rows: [] as DewsRow[] }),

    latestRedemptionRunRead.ok && latestRedemptionRunRead.row
      ? db.prepare(
          `SELECT ${REDEMPTION_BACKSTOP_ROW_COLUMNS}
             FROM redemption_backstop_run_rows
            WHERE snapshot_run_id = ? AND stablecoin_id IN (${idInClause.sql})`,
        )
          .bind(latestRedemptionRunRead.row.run_id, ...idInClause.binds)
          .all<RedemptionBackstopRow>()
          .then((res) => ({ ok: true as const, rows: res.results ?? [] }))
          .catch(() => ({ ok: false as const, rows: [] as RedemptionBackstopRow[] }))
      : Promise.resolve({ ok: true as const, rows: [] as RedemptionBackstopRow[] }),

    // Zero DDR overlay D1 reads in calm markets when no requested coin has an active DDR row.
    matchingDdrRows.length > 0 && ddrSnapshot
      ? Promise.all([
          loadLatestPublicationManifest(db),
          ddrPredictionIds.length > 0 ? loadPredictionErrata(db, { publicPredictionIds: ddrPredictionIds }) : Promise.resolve([]),
        ])
          .then(([manifest, errata]) => ({
            ok: true as const,
            manifestMatches: ddrCacheMatchesManifest(ddrSnapshot, manifest),
            invalidatedPredictionIds: new Set(errata.map((entry) => entry.publicPredictionId)),
          }))
          .catch(() => ({
            ok: false as const,
            manifestMatches: false,
            invalidatedPredictionIds: new Set<number>(),
          }))
      : Promise.resolve(null),
  ]);

  // Index decoded Round 1 + Round 2 maps
  type CachedStablecoinAsset = Extract<
    Awaited<ReturnType<typeof loadStablecoinsCache>>,
    { kind: "ok" }
  >["payload"]["peggedAssets"][number];
  const stablecoinById = new Map<string, CachedStablecoinAsset>();
  if (stablecoinsCache.kind === "ok") {
    for (const asset of stablecoinsCache.payload.peggedAssets) {
      if (resolvedIdSet.has(asset.id)) {
        stablecoinById.set(asset.id, asset);
      }
    }
  }

  const safetyCardById = new Map<string, NonNullable<typeof safetyIndex.snapshot>["cards"][number]>();
  const safetySnapshot = safetyIndex.kind === "error" ? null : safetyIndex.snapshot;
  if (safetySnapshot) {
    for (const card of safetySnapshot.cards) {
      if (resolvedIdSet.has(card.id)) {
        safetyCardById.set(card.id, card);
      }
    }
  }
  const safetyPublicationStatus: "current" | "held" | "stale" | "unavailable" = safetyIndex.kind === "error"
    ? "unavailable"
    : safetyIndex.kind === "held"
      ? "held"
      : isSafetyScoreV9SnapshotFresh(safetyIndex.snapshot, nowSec)
        ? "current"
        : "stale";

  const activeDepegsAvailable = activeDepegsRead.ok && activeProjectionRead.available;
  const activeDepegById = activeDepegsAvailable
    ? selectActiveDepegForCoin(activeDepegsRead.rows, activeProjectionRead.projections)
    : new Map<string, { eventId: number; startedAt: number; direction: "above" | "below"; peakDeviationBps: number }>();

  const dexRowById = new Map<string, SlimDexLiquidityRow>();
  let dexCohortUpdatedAt: number | null = null;
  let dexGenerationId: string | null = null;
  if (dexRead.ok) {
    for (const row of dexRead.rows) {
      if (row.updated_at > (dexCohortUpdatedAt ?? 0)) {
        dexCohortUpdatedAt = row.updated_at;
      }
      if (row.publication_generation_id && !dexGenerationId) {
        dexGenerationId = row.publication_generation_id;
      }
      if (row.stablecoin_id !== "__global__") {
        dexRowById.set(row.stablecoin_id, row);
      }
    }
  }

  const dewsRowById = new Map<string, DewsRow>();
  if (dewsRowsRead.ok) {
    for (const row of dewsRowsRead.rows) {
      dewsRowById.set(row.stablecoin_id, row);
    }
  }

  const redemptionEntryById = new Map<string, RedemptionBackstopEntry>();
  const quarantinedRedemptionIds = new Set<string>();
  const latestRun = latestRedemptionRunRead.ok ? latestRedemptionRunRead.row : null;
  if (latestRun && redemptionRowsRead.ok) {
    for (const row of redemptionRowsRead.rows) {
      const reasons: string[] = [];
      const decoded = decodeRedemptionBackstopRow(row, latestRun.run_id, reasons);
      if (!decoded) {
        quarantinedRedemptionIds.add(row.stablecoin_id);
        continue;
      }
      redemptionEntryById.set(row.stablecoin_id, projectMentoMarketPhase(decoded, nowSec));
    }
  }

  const ddrRowById = new Map<string, DdrV2ResponseRow>();
  for (const row of matchingDdrRows) {
    if (!ddrRowById.has(row.stablecoinId)) {
      ddrRowById.set(row.stablecoinId, row);
    }
  }
  const ddrOverlayUnavailableReason = ddrOverlayRead
    ? !ddrOverlayRead.ok
      ? "ddr-overlay-read-failed"
      : !ddrOverlayRead.manifestMatches
        ? "cache-manifest-mismatch"
        : null
    : null;

  const complianceUpdatedAt = resolveComplianceUpdatedAtSec(complianceIndex.reviewTimestampsSec, nowSec);
  const geniusEffective = isGeniusRegimeEffective(GENIUS_REGIME_STATE);

  // Assemble per-asset blocks
  const assets: Record<string, RiskCheckAsset> = {};
  let minMentoPhaseValidUntilSec = Infinity;

  for (const id of resolvedIds) {
    const meta = WORKER_TRACKED_META_BY_ID.get(id) as WorkerRuntimeStablecoinMeta;
    const scAsset = stablecoinById.get(id);
    const pegCoin = pegAnalytics.ok ? pegAnalytics.byId.get(id) : undefined;
    const safetyCard = safetyCardById.get(id);
    const rawPillars = safetySnapshot?.scorecardPillarsById?.[id];
    const dewsRow = dewsRowById.get(id);
    const activeDepeg = activeDepegById.get(id) ?? null;
    const dexRow = dexRowById.get(id);
    const redemptionEntry = redemptionEntryById.get(id);
    const ddrRow = ddrRowById.get(id);
    const compRecord = complianceIndex.byId.get(id);

    // Safety slice
    let safetyUnavailableReason: string | null = null;
    if (safetyIndex.kind === "error") {
      safetyUnavailableReason = safetyIndex.reason;
    } else if (!safetyCard) {
      safetyUnavailableReason = "not-in-safety-index";
    } else if (safetyPublicationStatus === "held") {
      safetyUnavailableReason = "v9-publication-held";
    } else if (safetyPublicationStatus === "stale") {
      safetyUnavailableReason = "safety-score-publication-age";
    } else if (safetyCard.ratingStatus === "pipeline-gap") {
      safetyUnavailableReason = "pipeline-gap";
    } else if (safetyCard.ratingStatus === "not-rated") {
      safetyUnavailableReason = "not-rated";
    }

    const safetyPillars = safetyCard?.ratingStatus === "rated" && rawPillars
      ? {
          backing: rawPillars.backing?.score ?? null,
          exit: rawPillars.exit?.score ?? null,
          control: rawPillars.control?.score ?? null,
        }
      : null;

    // DEWS slice
    let dewsUnavailableReason: string | null = null;
    if (dewsPointer.status === "no-pointer") {
      dewsUnavailableReason = "dews-pointer-missing";
    } else if (dewsPointer.status !== "ok") {
      dewsUnavailableReason = "dews-pointer-unavailable";
    } else if (!dewsRowsRead.ok) {
      dewsUnavailableReason = "dews-read-failed";
    } else if (!dewsRow) {
      dewsUnavailableReason = "no-dews-row";
    }

    // Peg slice
    const price = scAsset?.price ?? pegCoin?.price ?? null;
    const priceSource = scAsset?.priceSource ?? pegCoin?.priceSource ?? null;
    const priceConfidence = scAsset?.priceConfidence ?? pegCoin?.priceConfidence ?? null;
    const priceObservedAt = scAsset?.priceObservedAt ?? pegCoin?.priceObservedAt ?? null;
    const currentDeviationBps = scAsset?.currentPeg?.currentDeviationBps ?? pegCoin?.currentDeviationBps ?? null;
    const pegScore = pegCoin?.pegScore ?? null;
    const pegPct = pegCoin?.pegPct ?? null;
    let pegUnavailableReason: string | null = null;
    if (stablecoinsCache.kind !== "ok" && !pegAnalytics.ok) {
      pegUnavailableReason = "peg-and-price-caches-unavailable";
    } else if (!pegAnalytics.ok) {
      pegUnavailableReason = `peg-analytics-${pegAnalytics.reason}`;
    } else if (!activeDepegsAvailable) {
      pegUnavailableReason = activeProjectionRead.available ? "active-depegs-read-failed" : activeProjectionRead.reason;
    } else if (price == null) {
      pegUnavailableReason = "price-unavailable";
    }

    // DDR slice
    let ddrBlock: RiskCheckAsset["ddr"];
    if (ddrCacheLoad.kind !== "ok") {
      ddrBlock = {
        outlook: null,
        recoveryProbability24h: null,
        recoveryProbability7d: null,
        medianHours: null,
        stale: null,
        unavailableReason: `ddr-${ddrCacheLoad.reason}`,
      };
    } else if (ddrOverlayUnavailableReason) {
      ddrBlock = {
        outlook: null,
        recoveryProbability24h: null,
        recoveryProbability7d: null,
        medianHours: null,
        stale: null,
        unavailableReason: ddrOverlayUnavailableReason,
      };
    } else if (!ddrRow) {
      ddrBlock = {
        outlook: null,
        recoveryProbability24h: null,
        recoveryProbability7d: null,
        medianHours: null,
        stale: null,
        unavailableReason: "no-active-depeg",
      };
    } else {
      const invalidatedByErratum = ddrRow.prediction.publicPredictionId != null
        && ddrOverlayRead?.invalidatedPredictionIds.has(ddrRow.prediction.publicPredictionId) === true;
      if (invalidatedByErratum || ddrRow.kind === "invalidated_prediction") {
        ddrBlock = {
          outlook: null,
          recoveryProbability24h: null,
          recoveryProbability7d: null,
          medianHours: null,
          stale: ddrRow.live.stale,
          unavailableReason: "prediction-invalidated",
        };
      } else if (ddrRow.kind === "pending") {
        ddrBlock = {
          outlook: null,
          recoveryProbability24h: null,
          recoveryProbability7d: null,
          medianHours: null,
          stale: ddrRow.live.stale,
          unavailableReason: "prediction-pending",
        };
      } else if (ddrRow.kind === "no_call") {
        ddrBlock = {
          outlook: null,
          recoveryProbability24h: null,
          recoveryProbability7d: null,
          medianHours: null,
          stale: ddrRow.live.stale,
          unavailableReason: "no-call",
        };
      } else {
        const horizon24h = ddrRow.frozen?.duration.horizons.find((h) => h.horizon === "24h")?.probability ?? null;
        const horizon7d = ddrRow.frozen?.duration.horizons.find((h) => h.horizon === "7d")?.probability ?? null;
        const medianSec = ddrRow.frozen?.duration.suppressed ? null : (ddrRow.frozen?.duration.medianSec ?? null);
        ddrBlock = {
          outlook: ddrRow.frozen?.resolution.tier ?? null,
          recoveryProbability24h: horizon24h,
          recoveryProbability7d: horizon7d,
          medianHours: medianSec != null ? Math.round((medianSec / 3600) * 10) / 10 : null,
          stale: ddrRow.live.stale,
          unavailableReason: ddrRow.live.stale ? (ddrRow.live.degradedReason ?? "duration-exceeded") : null,
        };
      }
    }

    // DEX liquidity slice (with per-row evidence validation / R8 quarantine)
    let liquidityBlock: RiskCheckAsset["liquidity"];
    if (!dexRead.ok) {
      liquidityBlock = {
        liquidityScore: null,
        totalTvlUsd: null,
        volume24hUsd: null,
        poolCount: null,
        dexPriceUsd: null,
        updatedAt: null,
        warning: null,
        unavailableReason: "dex-liquidity-read-failed",
      };
    } else if (!dexRow) {
      liquidityBlock = {
        liquidityScore: null,
        totalTvlUsd: null,
        volume24hUsd: null,
        poolCount: null,
        dexPriceUsd: null,
        updatedAt: null,
        warning: null,
        unavailableReason: "no-dex-liquidity-row",
      };
    } else {
      let evidenceWarning: string | null = null;
      let quarantineReason: string | null = null;
      try {
        const evidence = normalizeDexLiquidityEvidence(dexRow);
        if (!evidence.hasMeasuredLiquidityEvidence) {
          evidenceWarning = "unmeasured-liquidity-evidence";
        }
      } catch {
        quarantineReason = "invalid-coverage-evidence";
      }
      if (quarantineReason) {
        liquidityBlock = {
          liquidityScore: null,
          totalTvlUsd: null,
          volume24hUsd: null,
          poolCount: null,
          dexPriceUsd: null,
          updatedAt: dexRow.updated_at,
          warning: null,
          unavailableReason: quarantineReason,
        };
      } else {
        liquidityBlock = {
          liquidityScore: dexRow.liquidity_score,
          totalTvlUsd: dexRow.total_tvl_usd,
          volume24hUsd: dexRow.total_volume_24h_usd,
          poolCount: dexRow.pool_count,
          dexPriceUsd: dexRow.dex_price_usd ?? null,
          updatedAt: dexRow.updated_at,
          warning: evidenceWarning,
          unavailableReason: null,
        };
      }
    }

    // Redemption slice (per-row quarantine + Mento market phase)
    const isMentoFpmm = mentoFpmmIds.has(id);
    const mentoReopenSec = isMentoFpmm ? resolveMentoFxMarketReopen(nowSec) : null;
    if (isMentoFpmm) {
      const phaseBoundary = mentoReopenSec ?? nextMentoHour(nowSec);
      if (phaseBoundary < minMentoPhaseValidUntilSec) {
        minMentoPhaseValidUntilSec = phaseBoundary;
      }
    }
    const marketPhase = isMentoFpmm ? (mentoReopenSec != null ? "closed" : "open") : null;

    let redemptionBlock: RiskCheckAsset["redemption"];
    if (!latestRedemptionRunRead.ok || !redemptionRowsRead.ok) {
      redemptionBlock = {
        score: null,
        routeFamily: null,
        accessModel: null,
        immediateCapacityUsd: null,
        feeBps: null,
        marketPhase,
        unavailableReason: "redemption-read-failed",
      };
    } else if (!latestRun) {
      redemptionBlock = {
        score: null,
        routeFamily: null,
        accessModel: null,
        immediateCapacityUsd: null,
        feeBps: null,
        marketPhase,
        unavailableReason: "no-completed-redemption-run",
      };
    } else if (quarantinedRedemptionIds.has(id)) {
      redemptionBlock = {
        score: null,
        routeFamily: null,
        accessModel: null,
        immediateCapacityUsd: null,
        feeBps: null,
        marketPhase,
        unavailableReason: "redemption-row-malformed",
      };
    } else if (!redemptionEntry) {
      redemptionBlock = {
        score: null,
        routeFamily: null,
        accessModel: null,
        immediateCapacityUsd: null,
        feeBps: null,
        marketPhase,
        unavailableReason: "no-redemption-route",
      };
    } else {
      redemptionBlock = {
        score: redemptionEntry.score,
        routeFamily: redemptionEntry.routeFamily,
        accessModel: redemptionEntry.accessModel,
        immediateCapacityUsd: redemptionEntry.immediateCapacityUsd,
        feeBps: redemptionEntry.feeBps,
        marketPhase,
        unavailableReason: redemptionEntry.resolutionState === "resolved" ? null : redemptionEntry.resolutionState,
      };
    }

    // Controls slice (in-memory)
    const freezeable = meta.blacklistabilityReview?.reviewedStatus ?? null;
    const controlsBlock: RiskCheckAsset["controls"] = {
      freezeable,
      blacklistabilityStatus: freezeable == null ? "unreviewed" : String(freezeable),
      liveFreezeTrackerCovered: isBlacklistStablecoin(meta.symbol.toUpperCase()),
    };

    // Compliance slice (in-memory)
    const complianceBlock: RiskCheckAsset["compliance"] = {
      micaStatus: compRecord?.mica?.status ?? null,
      micaTokenType: compRecord?.mica?.tokenType ?? null,
      geniusStatus: compRecord?.genius?.authorizationStatus ?? null,
      geniusPathway: compRecord?.genius?.issuerPathway ?? null,
      geniusRegimeEffective: geniusEffective,
      reviewedAt: compRecord?.genius?.reviewedAt ?? null,
      unavailableReason: compRecord?.mica || compRecord?.genius ? null : "not-reviewed",
    };

    assets[id] = {
      identity: {
        id: meta.id,
        symbol: meta.symbol,
        name: meta.name,
        status: meta.status ?? "active",
        pegCurrency: meta.pegCurrency,
        governance: meta.governance,
        backing: meta.flags.backing ?? null,
        navToken: meta.flags.navToken === true,
        yieldBearing: meta.flags.yieldBearing === true,
      },
      safety: {
        ratingStatus: safetyCard?.ratingStatus ?? null,
        score: safetyCard?.score ?? null,
        grade: safetyCard?.grade ?? null,
        pillars: safetyPillars,
        publicationStatus: safetyPublicationStatus,
        heldSinceSec: safetyPublicationStatus === "held" ? (safetySnapshot?.publicationHealth.heldSinceSec ?? null) : null,
        methodologyVersion: safetySnapshot?.methodology.version ?? null,
        unavailableReason: safetyUnavailableReason,
      },
      dews: {
        score: dewsRow?.score ?? null,
        band: dewsRow?.band ?? null,
        computedAt: dewsRow?.computed_at ?? null,
        ageClassification: dewsRow
          ? classifyDewsAge(dewsRow.computed_at, nowSec, dewsPointer.status === "ok" ? dewsPointer.computedAt : null)
          : null,
        unavailableReason: dewsUnavailableReason,
      },
      peg: {
        price,
        priceSource,
        priceConfidence,
        priceObservedAt,
        currentDeviationBps,
        pegScore,
        pegPct,
        activeDepeg,
        unavailableReason: pegUnavailableReason,
      },
      ddr: ddrBlock,
      liquidity: liquidityBlock,
      redemption: redemptionBlock,
      controls: controlsBlock,
      compliance: complianceBlock,
    };
  }

  // Per-producer dependency metadata (R3 / R4)
  const safetyDep = safetySnapshot
    ? buildDependencyMeta(safetySnapshot.updatedAt, API_FRESHNESS_MAX_AGE_SEC.reportCards, "report-cards", nowSec, {
        freshBudgetSec: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC,
        degradedBudgetSec: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC * 2,
        generationId: safetySnapshot.safetyScoreIdentity.publicationGenerationId,
        forceStatus: safetyPublicationStatus === "current"
          ? "fresh"
          : safetyPublicationStatus === "held"
            ? "degraded"
            : "stale",
        reason: safetyPublicationStatus === "current"
          ? null
          : safetyPublicationStatus === "held"
            ? "v9-publication-held"
            : "safety-score-publication-age",
      })
    : buildDependencyMeta(null, API_FRESHNESS_MAX_AGE_SEC.reportCards, "report-cards", nowSec, {
        freshBudgetSec: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC,
        unavailableReason: safetyIndex.kind === "error" ? safetyIndex.reason : "safety-score-unavailable",
      });

  const dewsDep = dewsPointer.status === "ok" && dewsRowsRead.ok
    ? buildDependencyMeta(dewsPointer.computedAt, API_FRESHNESS_MAX_AGE_SEC.stressSignals, "dews", nowSec, {
        freshBudgetSec: API_FRESHNESS_MAX_AGE_SEC.stressSignals,
        degradedBudgetSec: STRESS_SIGNALS_DEGRADED_MAX_AGE_SEC,
        generationId: `dews:${dewsPointer.computedAt}`,
      })
    : buildDependencyMeta(null, API_FRESHNESS_MAX_AGE_SEC.stressSignals, "dews", nowSec, {
        freshBudgetSec: API_FRESHNESS_MAX_AGE_SEC.stressSignals,
        unavailableReason: !dewsRowsRead.ok
          ? "dews-read-failed"
          : dewsPointer.status === "no-pointer"
            ? "dews-pointer-missing"
            : "dews-pointer-unavailable",
      });

  const stablecoinsDep = stablecoinsCache.kind === "ok"
    ? buildDependencyMeta(stablecoinsCache.updatedAt, API_FRESHNESS_MAX_AGE_SEC.stablecoins, "stablecoins", nowSec, {
        freshBudgetSec: API_FRESHNESS_MAX_AGE_SEC.stablecoins,
      })
    : buildDependencyMeta(null, API_FRESHNESS_MAX_AGE_SEC.stablecoins, "stablecoins", nowSec, {
        freshBudgetSec: API_FRESHNESS_MAX_AGE_SEC.stablecoins,
        unavailableReason: stablecoinsCache.reason,
      });

  const pegAnalyticsDep = pegAnalytics.ok
    ? buildDependencyMeta(pegAnalytics.computedAtSec, API_FRESHNESS_MAX_AGE_SEC.pegSummary, "peg-summary", nowSec, {
        freshBudgetSec: API_FRESHNESS_MAX_AGE_SEC.pegSummary,
      })
    : buildDependencyMeta(null, API_FRESHNESS_MAX_AGE_SEC.pegSummary, "peg-summary", nowSec, {
        freshBudgetSec: API_FRESHNESS_MAX_AGE_SEC.pegSummary,
        unavailableReason: pegAnalytics.reason,
      });

  const activeDepegsClock = stablecoinsCache.kind === "ok"
    ? stablecoinsCache.updatedAt
    : pegAnalytics.ok
      ? pegAnalytics.computedAtSec
      : nowSec;
  const activeDepegsDep = activeDepegsAvailable
    ? buildDependencyMeta(activeDepegsClock, API_FRESHNESS_MAX_AGE_SEC.depegEvents, "depeg-events", nowSec, {
        freshBudgetSec: API_FRESHNESS_MAX_AGE_SEC.depegEvents,
      })
    : buildDependencyMeta(null, API_FRESHNESS_MAX_AGE_SEC.depegEvents, "depeg-events", nowSec, {
        freshBudgetSec: API_FRESHNESS_MAX_AGE_SEC.depegEvents,
        unavailableReason: activeProjectionRead.available ? "active-depegs-read-failed" : activeProjectionRead.reason,
      });

  const ddrDep = ddrCacheLoad.kind === "ok" && !ddrOverlayUnavailableReason
    ? buildDependencyMeta(ddrCacheLoad.payload._meta.computedAt, API_FRESHNESS_MAX_AGE_SEC.depegResolver, "depeg-resolver", nowSec, {
        freshBudgetSec: API_FRESHNESS_MAX_AGE_SEC.depegResolver,
        generationId: ddrCacheLoad.payload._meta.snapshotGeneration != null
          ? String(ddrCacheLoad.payload._meta.snapshotGeneration)
          : null,
      })
    : buildDependencyMeta(null, API_FRESHNESS_MAX_AGE_SEC.depegResolver, "depeg-resolver", nowSec, {
        freshBudgetSec: API_FRESHNESS_MAX_AGE_SEC.depegResolver,
        unavailableReason: ddrOverlayUnavailableReason ?? (ddrCacheLoad.kind === "error" ? ddrCacheLoad.reason : "ddr-unavailable"),
      });

  const dexDep = dexRead.ok && dexCohortUpdatedAt != null
    ? buildDependencyMeta(dexCohortUpdatedAt, API_FRESHNESS_MAX_AGE_SEC.dexLiquidity, "dex-liquidity", nowSec, {
        freshBudgetSec: API_FRESHNESS_MAX_AGE_SEC.dexLiquidity,
        generationId: dexGenerationId,
      })
    : buildDependencyMeta(null, API_FRESHNESS_MAX_AGE_SEC.dexLiquidity, "dex-liquidity", nowSec, {
        freshBudgetSec: API_FRESHNESS_MAX_AGE_SEC.dexLiquidity,
        unavailableReason: !dexRead.ok ? "dex-liquidity-read-failed" : "dex-liquidity-empty",
      });

  const redemptionClock = latestRun ? (latestRun.max_updated_at ?? latestRun.completed_at) : null;
  const redemptionDep = latestRedemptionRunRead.ok && redemptionRowsRead.ok && latestRun && redemptionClock != null
    ? buildDependencyMeta(redemptionClock, API_FRESHNESS_MAX_AGE_SEC.redemptionBackstops, "redemption-backstops", nowSec, {
        freshBudgetSec: API_FRESHNESS_MAX_AGE_SEC.redemptionBackstops,
        generationId: latestRun.run_id,
      })
    : buildDependencyMeta(null, API_FRESHNESS_MAX_AGE_SEC.redemptionBackstops, "redemption-backstops", nowSec, {
        freshBudgetSec: API_FRESHNESS_MAX_AGE_SEC.redemptionBackstops,
        unavailableReason: !latestRedemptionRunRead.ok || !redemptionRowsRead.ok
          ? "redemption-read-failed"
          : "no-completed-redemption-run",
      });

  const complianceDep = buildDependencyMeta(complianceUpdatedAt, COMPLIANCE_REVIEW_BUDGET_SEC, "compliance", nowSec, {
    freshBudgetSec: COMPLIANCE_REVIEW_BUDGET_SEC,
    degradedBudgetSec: COMPLIANCE_REVIEW_BUDGET_SEC * 2,
  });

  const dependencies: Record<string, ApiDependencyMeta> = {
    safetyScore: safetyDep,
    dews: dewsDep,
    stablecoins: stablecoinsDep,
    pegAnalytics: pegAnalyticsDep,
    activeDepegs: activeDepegsDep,
    ddr: ddrDep,
    dexLiquidity: dexDep,
    redemptionBackstops: redemptionDep,
    compliance: complianceDep,
  };

  const d1Dependencies = [
    safetyDep,
    dewsDep,
    stablecoinsDep,
    pegAnalyticsDep,
    activeDepegsDep,
    ddrDep,
    dexDep,
    redemptionDep,
  ];
  const allD1Fresh = d1Dependencies.every((dep) => dep.status === "fresh")
    && safetyPublicationStatus === "current"
    && quarantinedRedemptionIds.size === 0;
  const nonFreshReasons = Object.entries(dependencies)
    .filter(([, dep]) => dep.status !== "fresh")
    .map(([name, dep]) => `${name}:${dep.reason ?? dep.status}`);
  if (quarantinedRedemptionIds.size > 0) {
    nonFreshReasons.push("redemption:row-quarantined");
  }

  const anyStaleOrUnavailable = d1Dependencies.some((dep) => dep.status === "stale" || dep.status === "unavailable");
  const overallStatus = allD1Fresh ? "fresh" : anyStaleOrUnavailable ? "stale" : "degraded";

  const availableD1UpdatedAts = d1Dependencies
    .map((dep) => dep.updatedAt)
    .filter((ts): ts is number => ts != null && Number.isFinite(ts));
  const oldestUpdatedAt = availableD1UpdatedAts.length > 0 ? Math.min(...availableD1UpdatedAts) : null;
  const tightestFreshBudget = Math.min(
    ...d1Dependencies
      .map((dep) => dep.freshBudgetSec)
      .filter((sec): sec is number => typeof sec === "number" && Number.isFinite(sec)),
  );

  const metaEnvelope: ApiMetaEnvelope = oldestUpdatedAt != null
    ? {
        updatedAt: oldestUpdatedAt,
        ageSeconds: Math.max(0, nowSec - oldestUpdatedAt),
        assessedAt: nowSec,
        freshBudgetSec: tightestFreshBudget,
        degradedBudgetSec: tightestFreshBudget * 2,
        status: overallStatus,
        ...(nonFreshReasons.length > 0 ? { warning: `Degraded or stale dependencies: ${nonFreshReasons.join(", ")}` } : {}),
        dependencies,
      }
    : {
        updatedAt: null,
        ageSeconds: null,
        assessedAt: nowSec,
        freshBudgetSec: tightestFreshBudget,
        degradedBudgetSec: tightestFreshBudget * 2,
        status: "unknown",
        reason: nonFreshReasons.join(",") || "all-dependencies-unavailable",
        warning: `All dependencies unavailable: ${nonFreshReasons.join(", ")}`,
        dependencies,
      };

  // Compute response headers and bounded Cache-Control
  let headers: Record<string, string> = {
    "X-Safety-Score-Status": safetyPublicationStatus,
    ...(safetySnapshot
      ? { "X-Safety-Score-Generation": safetySnapshot.safetyScoreIdentity.publicationGenerationId }
      : {}),
  };

  if (allD1Fresh && oldestUpdatedAt != null) {
    let minValidUntilSec = minMentoPhaseValidUntilSec;
    for (const dep of d1Dependencies) {
      if (dep.updatedAt != null && dep.freshBudgetSec != null) {
        const validUntil = dep.updatedAt + dep.freshBudgetSec;
        if (validUntil < minValidUntilSec) minValidUntilSec = validUntil;
      }
    }
    headers = addFreshnessHeaders(
      { ...headers, "Cache-Control": CACHE_PROFILES.producerBacked },
      oldestUpdatedAt,
      tightestFreshBudget,
      {
        assessedAt: nowSec,
        freshBudgetSec: tightestFreshBudget,
        cacheValidUntil: minValidUntilSec,
      },
    );
  } else {
    headers["Cache-Control"] = CACHE_PROFILES.noStore;
    headers["X-Data-Freshness"] = overallStatus;
    if (oldestUpdatedAt != null) {
      headers["X-Data-Updated-At"] = String(oldestUpdatedAt);
      headers["X-Data-Age"] = String(Math.max(0, nowSec - oldestUpdatedAt));
    }
    if (nonFreshReasons.length > 0) {
      headers.Warning = `199 - "Risk-check dependencies degraded: ${nonFreshReasons.join(", ")}"`;
    }
  }

  const body: RiskCheckResponse = {
    schemaVersion: 1,
    assessedAt: nowSec,
    requestedCount,
    resolvedCount: resolvedIds.length,
    unresolved,
    assets,
    _meta: metaEnvelope,
  };
  return jsonResponse(body, { headers });
}
