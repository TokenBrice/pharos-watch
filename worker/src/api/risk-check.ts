import {
  SAFETY_SCORE_PUBLICATION_AGE_REASON,
  type ApiDependencyMeta,
  type ApiMetaEnvelope,
} from "@pharos/contracts/api-meta";
import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { RISK_CHECK_MAX_ASSETS } from "@shared/lib/api-endpoints/queries";
import { API_FRESHNESS_MAX_AGE_SEC, STRESS_SIGNALS_DEGRADED_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { FRESHNESS_RATIOS } from "@shared/lib/status-thresholds";
import { parseContractTuple } from "@shared/lib/deployment-resolver";
import { applyDurationStaleness, validateDdrPublicCacheContract } from "@shared/lib/depeg-resolver/public-contract";
import { parseDexVolumeAvailabilityRecord, readStoredDexVolumeWindow } from "@shared/lib/dex-volume-availability";
import {
  WORKER_TRACKED_META_BY_ID,
  type WorkerRuntimeStablecoinMeta,
} from "@shared/lib/stablecoins/worker-runtime-registry";
import type { DdrResponse, DdrV2ResponseRow } from "@shared/types/depeg-resolver";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import type {
  RiskCheckAsset,
  RiskCheckResponse,
  RiskCheckUnresolvedInput,
} from "@shared/types/risk-check";
import {
  addFreshnessHeaders,
  buildCronFreshnessMeta,
  buildFreshnessMeta,
  getLatestSuccessfulCronTimestampResult,
} from "../lib/api-freshness";
import { jsonResponse } from "../lib/api-response";
import { BLACKLIST_TRACKED_STABLECOIN_IDS } from "../lib/blacklist-contracts";
import { buildInClause } from "../lib/db";
import {
  decodeActiveIncidentProjections,
  EXCLUDE_SUPERSEDED_ACTIVE_INCIDENT_EVENTS_SQL,
  prepareActiveIncidentProjections,
  rowToPublicDepegEvent,
} from "../lib/depeg-event-projection";
import type { DepegRow } from "../lib/depeg-helpers";
import { loadLatestPublicationManifest } from "../lib/depeg-resolver-publication-store";
import { parseDepegResolverSnapshotRow } from "../lib/depeg-resolver-snapshot-cache";
import { DEWS_PUBLICATION_POINTER_CACHE_KEY, parseDewsPublishedGeneration } from "../lib/dews-publication-pointer";
import { dexLiquidityPublishedRowFilter, normalizeDexLiquidityEvidence } from "../lib/dex-liquidity";
import { admitDexPriceRow } from "../lib/dex-liquidity-response";
import { decodePegAnalyticsCacheRow, PEG_ANALYTICS_CACHE_KEY } from "../lib/peg-analytics-cache-decode";
import { mentoFpmmIds, nextMentoHour, projectMentoMarketPhase } from "../lib/redemption-backstop-capacity/mento-phase";
import {
  redemptionBackstopPhaseValidUntil,
  selectAdmittedRedemptionBackstopRun,
} from "../lib/redemption-backstops-store";
import { loadActiveSafetyScoreIndex } from "../lib/safety-score-index";
import {
  isSafetyScoreV9SnapshotFresh,
  SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC,
} from "../lib/safety-score-v9/consumer-freshness";
import { resolveMentoFxMarketReopen } from "../lib/stablecoin-publication-coverage";
import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "../lib/stablecoins-cache";
import {
  COMPLIANCE_REVIEW_BUDGET_SEC,
  loadComplianceIndex,
  resolveComplianceUpdatedAtSec,
  resolveGeniusRegimeEffective,
} from "./compliance";
import { cacheMatchesLatestManifest, decorateDdrResponse, staleSnapshotResponse } from "./depeg-resolver";
import { resolveContractDeployment } from "./resolve";

const DDR_SNAPSHOT_CACHE_KEY = "depeg-resolver:snapshot";
const CACHE_KEYS_FOR_RISK_CHECK = [
  "stablecoins",
  PEG_ANALYTICS_CACHE_KEY,
  DDR_SNAPSHOT_CACHE_KEY,
  DEWS_PUBLICATION_POINTER_CACHE_KEY,
] as const;

/**
 * Each dependency is graded by its owning route's freshness policy: the same
 * endpoint budget and policy identity that route hands to the shared helpers.
 */
interface DependencyPolicy {
  maxAgeSec: number;
  cacheKey: string;
  freshBudgetSec?: number;
  degradedBudgetSec?: number;
}

const STABLECOINS_POLICY: DependencyPolicy = { maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.stablecoins, cacheKey: "stablecoins" };
const PEG_SUMMARY_POLICY: DependencyPolicy = { maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.pegSummary, cacheKey: "peg-summary" };
const DEPEG_RESOLVER_POLICY: DependencyPolicy = {
  maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.depegResolver,
  cacheKey: "depeg-resolver",
};
const DEX_LIQUIDITY_POLICY: DependencyPolicy = { maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.dexLiquidity, cacheKey: "dex-liquidity" };
const REDEMPTION_BACKSTOPS_POLICY: DependencyPolicy = {
  maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.redemptionBackstops,
  cacheKey: "redemption-backstops",
};
const STRESS_SIGNALS_POLICY: DependencyPolicy = {
  maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.stressSignals,
  cacheKey: "dews",
  freshBudgetSec: API_FRESHNESS_MAX_AGE_SEC.stressSignals,
  degradedBudgetSec: STRESS_SIGNALS_DEGRADED_MAX_AGE_SEC,
};
const SAFETY_SCORE_POLICY: DependencyPolicy = {
  maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.reportCards,
  cacheKey: "report-cards",
  freshBudgetSec: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC,
  degradedBudgetSec: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC * 2,
};
const COMPLIANCE_POLICY: DependencyPolicy = {
  maxAgeSec: COMPLIANCE_REVIEW_BUDGET_SEC,
  cacheKey: "compliance",
  freshBudgetSec: COMPLIANCE_REVIEW_BUDGET_SEC,
  degradedBudgetSec: COMPLIANCE_REVIEW_BUDGET_SEC * 2,
};
/** `/api/depeg-events` dates active incidents by this producer's confirmed output. */
const DEPEG_EVENTS_PRODUCER_JOB = "sync-stablecoins";

interface RawCacheRow {
  key: string;
  value: string;
  updated_at: number;
}

interface SlimDexLiquidityRow {
  stablecoin_id: string;
  total_tvl_usd: number;
  total_volume_24h_usd: number;
  volume_availability_json: string | null;
  pool_count: number;
  liquidity_score: number | null;
  updated_at: number;
  coverage_class: string | null;
  coverage_confidence: number | null;
  effective_tvl_usd: number | null;
  balance_measured_tvl_usd: number | null;
  organic_measured_tvl_usd: number | null;
  publication_generation_id: string | null;
  dex_price_stablecoin_id: string | null;
  dex_price_usd: number | null;
  dex_price_updated_at: number | null;
  dex_price_sources_json: string | null;
}

interface DewsRow {
  stablecoin_id: string;
  score: number;
  band: string;
  computed_at: number;
}

interface ActiveDepegSummary {
  eventId: number;
  startedAt: number;
  direction: "above" | "below";
  peakDeviationBps: number;
}

interface GradedDependency {
  meta: ApiDependencyMeta;
  /** Kept beside the public verdict: dependency metadata carries only the fresh budget. */
  degradedBudgetSec: number | null;
}

/** Mirrors the edge-cache key for this route: trimmed, deduplicated, sorted. */
function canonicalCsvParam(raw: string | null): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((item) => item.trim()).filter((item) => item.length > 0))].sort();
}

function compareUnresolved(left: RiskCheckUnresolvedInput, right: RiskCheckUnresolvedInput): number {
  if (left.input !== right.input) return left.input < right.input ? -1 : 1;
  if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
  return 0;
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

function gradeDependency(
  policy: DependencyPolicy,
  updatedAt: number,
  nowSec: number,
  options: {
    generationId?: string | null;
    /** A producer-declared degradation that age alone would grade fresh. */
    degradedReason?: string | null;
    forced?: { status: ApiDependencyMeta["status"]; reason: string | null };
  } = {},
): GradedDependency {
  const freshness = buildFreshnessMeta(updatedAt, policy.maxAgeSec, policy.cacheKey, {
    assessedAt: nowSec,
    freshBudgetSec: policy.freshBudgetSec,
    degradedBudgetSec: policy.degradedBudgetSec,
  });
  const producerDegraded = freshness.status === "fresh" && options.degradedReason != null;
  const status = options.forced?.status ?? (producerDegraded ? "degraded" : freshness.status);
  const reason = options.forced
    ? options.forced.reason
    : producerDegraded
      ? options.degradedReason ?? null
      : freshness.status === "fresh"
        ? null
        : freshness.status === "degraded" && options.degradedReason != null
          ? options.degradedReason
          : `${policy.cacheKey}-${freshness.status}`;
  return {
    meta: {
      updatedAt: freshness.updatedAt,
      ageSeconds: freshness.ageSeconds,
      freshBudgetSec: freshness.freshBudgetSec,
      generationId: options.generationId ?? null,
      status,
      reason,
    },
    degradedBudgetSec: freshness.degradedBudgetSec,
  };
}

function unavailableDependency(
  policy: DependencyPolicy,
  reason: string,
  nowSec: number,
  generationId: string | null = null,
): GradedDependency {
  // The budget is the owning policy's, independent of any producer clock.
  const budget = buildFreshnessMeta(nowSec, policy.maxAgeSec, policy.cacheKey, {
    assessedAt: nowSec,
    freshBudgetSec: policy.freshBudgetSec,
    degradedBudgetSec: policy.degradedBudgetSec,
  });
  return {
    meta: {
      updatedAt: null,
      ageSeconds: null,
      freshBudgetSec: budget.freshBudgetSec,
      generationId,
      status: "unavailable",
      reason,
    },
    degradedBudgetSec: budget.degradedBudgetSec,
  };
}

/** Per-row quarantine: an unreadable row withholds its coin's verdict, never the request. */
function selectActiveDepegs(
  rows: readonly DepegRow[],
  projections: Parameters<typeof rowToPublicDepegEvent>[1],
): { byId: Map<string, ActiveDepegSummary>; unreadableIds: Set<string> } {
  const byId = new Map<string, ActiveDepegSummary>();
  const unreadableIds = new Set<string>();
  for (const row of rows) {
    let projected: ReturnType<typeof rowToPublicDepegEvent>;
    try {
      projected = rowToPublicDepegEvent(row, projections);
    } catch {
      unreadableIds.add(row.stablecoin_id);
      continue;
    }
    if (projected.provenance?.pegScoreEligible === false) continue;
    const candidate = {
      eventId: projected.id,
      startedAt: projected.startedAt,
      direction: projected.direction,
      peakDeviationBps: projected.peakDeviationBps,
    };
    const existing = byId.get(projected.stablecoinId);
    if (!existing || Math.abs(candidate.peakDeviationBps) > Math.abs(existing.peakDeviationBps)) {
      byId.set(projected.stablecoinId, candidate);
    }
  }
  for (const id of unreadableIds) byId.delete(id);
  return { byId, unreadableIds };
}

function unavailableDdrBlock(reason: string, stale: boolean | null = null): RiskCheckAsset["ddr"] {
  return {
    outlook: null,
    recoveryProbability24h: null,
    recoveryProbability7d: null,
    medianHours: null,
    stale,
    unavailableReason: reason,
  };
}

function unavailableLiquidityBlock(reason: string, updatedAt: number | null = null): RiskCheckAsset["liquidity"] {
  return {
    liquidityScore: null,
    totalTvlUsd: null,
    volume24hUsd: null,
    poolCount: null,
    dexPriceUsd: null,
    updatedAt,
    warning: null,
    unavailableReason: reason,
  };
}

export async function handleRiskCheck(db: D1Database, url: URL): Promise<Response> {
  // Canonicalized exactly like the edge-cache key, so every reordering or
  // duplication of one request yields the same body.
  const idInputs = canonicalCsvParam(url.searchParams.get("ids"));
  const contractInputs = canonicalCsvParam(url.searchParams.get("contracts"));
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

  const resolvedIdSet = new Set<string>();
  const unresolved: RiskCheckUnresolvedInput[] = [];

  for (const rawId of idInputs) {
    const meta = WORKER_TRACKED_META_BY_ID.get(rawId);
    if (!meta) {
      unresolved.push({ input: rawId, kind: "id", reason: "unknown-stablecoin" });
      continue;
    }
    resolvedIdSet.add(meta.id);
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
    resolvedIdSet.add(resolved.entry.coin.id);
  }
  unresolved.sort(compareUnresolved);
  const resolvedIds = [...resolvedIdSet].sort();

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

  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const idInClause = buildInClause(resolvedIds);
  const cacheInClause = buildInClause([...CACHE_KEYS_FOR_RISK_CHECK]);

  // Round 1: parallel D1 reads + lazy in-memory compliance index (0 D1 reads)
  const [
    cacheQueryResult,
    safetyIndex,
    activeDepegsRead,
    activeProjectionRaw,
    activeDepegsClock,
    dexRead,
    redemptionAdmission,
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
      .then((res) => ({ ok: true as const, res }))
      .catch(() => ({ ok: false as const })),
    getLatestSuccessfulCronTimestampResult(db, DEPEG_EVENTS_PRODUCER_JOB),
    db.prepare(
      `SELECT d.stablecoin_id, d.total_tvl_usd, d.total_volume_24h_usd, d.volume_availability_json, d.pool_count,
              d.liquidity_score, d.updated_at, d.coverage_class, d.coverage_confidence,
              d.effective_tvl_usd, d.balance_measured_tvl_usd, d.organic_measured_tvl_usd,
              d.publication_generation_id, p.stablecoin_id AS dex_price_stablecoin_id, p.dex_price_usd,
              p.updated_at AS dex_price_updated_at, p.price_sources_json AS dex_price_sources_json
         FROM dex_liquidity d
         LEFT JOIN dex_prices p ON p.stablecoin_id = d.stablecoin_id
        WHERE ${dexLiquidityPublishedRowFilter("d")}
          AND (d.stablecoin_id IN (${idInClause.sql}) OR d.stablecoin_id = '__global__')`,
    )
      .bind(...idInClause.binds)
      .all<SlimDexLiquidityRow>()
      .then((res) => ({ ok: true as const, rows: res.results ?? [] }))
      .catch(() => ({ ok: false as const, rows: [] as SlimDexLiquidityRow[] })),
    // The store's admission authority: latest complete run whose row census
    // matches, else the previous run. Only requested entries are retained.
    selectAdmittedRedemptionBackstopRun(db, resolvedIdSet)
      .then((admitted) => ({ ok: true as const, ...admitted }))
      .catch(() => ({ ok: false as const })),
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
    : { kind: "error" as const, reason: "cache-read-failed" as const, updatedAt: null };
  const stablecoinsUsable = hasUsableStablecoinsPayload(stablecoinsCache);

  const pegAnalytics = cacheQueryResult.ok
    ? decodePegAnalyticsCacheRow(cacheByKey.get(PEG_ANALYTICS_CACHE_KEY) ?? null, nowMs)
    : { kind: "miss" as const, reason: "cache-read-failed" as const };

  const ddrCacheLoad = cacheQueryResult.ok
    ? parseDepegResolverSnapshotRow(cacheByKey.get(DDR_SNAPSHOT_CACHE_KEY) ?? null)
    : { kind: "error" as const, reason: "cache-read-failed", updatedAt: null };

  const dewsPointer = cacheQueryResult.ok
    ? parseDewsPublishedGeneration(cacheByKey.get(DEWS_PUBLICATION_POINTER_CACHE_KEY) ?? null, nowSec)
    : { status: "read-failed" as const, error: "cache-read-failed" };

  // Decode only the projections of the requested coins' open events, so one
  // malformed projection for an unrelated coin cannot hide every peg section (R8).
  const requestedEventIds = new Set<unknown>(activeDepegsRead.rows.map((row) => row.id));
  const activeProjectionRead = activeProjectionRaw.ok
    ? decodeActiveIncidentProjections({
        ...activeProjectionRaw.res,
        results: (activeProjectionRaw.res.results ?? []).filter((row) =>
          requestedEventIds.has((row as { current_event_id?: unknown }).current_event_id)),
      })
    : { available: false as const, reason: "incident-projection-read-failed" as const };
  const activeDepegsAvailable = activeDepegsRead.ok && activeProjectionRead.available;
  const activeDepegsUnavailableReason = activeDepegsAvailable
    ? null
    : activeProjectionRead.available ? "active-depegs-read-failed" : activeProjectionRead.reason;
  const activeDepegs = activeDepegsAvailable
    ? selectActiveDepegs(activeDepegsRead.rows, activeProjectionRead.projections)
    : { byId: new Map<string, ActiveDepegSummary>(), unreadableIds: new Set<string>() };
  const coinsInIncident = new Set(activeDepegsRead.rows.map((row) => row.stablecoin_id));

  // DDR admission, as /api/depeg-resolver applies it: public cache contract,
  // then (only when a requested coin is in an incident) the manifest match,
  // expired-snapshot marking and the errata / lock-deferral overlays.
  const ddrContract = ddrCacheLoad.kind === "ok" ? validateDdrPublicCacheContract(ddrCacheLoad.payload) : null;
  const ddrSnapshot = ddrCacheLoad.kind === "ok" && ddrContract?.ok ? ddrCacheLoad.payload : null;
  const ddrContractReason = ddrContract && !ddrContract.ok ? ddrContract.reason : null;
  const ddrExpired = ddrSnapshot != null && nowSec > ddrSnapshot._meta.expiresAt;
  const requestedDdrSnapshot: DdrResponse | null = ddrSnapshot
    ? { ...ddrSnapshot, rows: ddrSnapshot.rows.filter((row) => resolvedIdSet.has(row.stablecoinId)) }
    : null;
  // Zero DDR overlay D1 reads in calm markets: no requested coin has a DDR row or an open incident.
  const ddrOverlayNeeded = requestedDdrSnapshot != null
    && (requestedDdrSnapshot.rows.length > 0 || coinsInIncident.size > 0);

  // Round 2: parallel conditioned reads (DEWS rows, conditional DDR overlay)
  const [dewsRowsRead, ddrOverlay] = await Promise.all([
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

    ddrOverlayNeeded && ddrSnapshot && requestedDdrSnapshot
      ? Promise.all([
          loadLatestPublicationManifest(db),
          (ddrExpired
            ? staleSnapshotResponse(db, requestedDdrSnapshot)
            : Promise.resolve(applyDurationStaleness(requestedDdrSnapshot, nowSec)))
            .then((base) => decorateDdrResponse(db, base)),
        ])
          .then(([manifest, decorated]) => {
            const manifestContract = cacheMatchesLatestManifest(ddrSnapshot, manifest);
            return manifestContract.ok
              ? { ok: true as const, payload: decorated }
              : { ok: false as const, reason: manifestContract.reason };
          })
          .catch(() => ({ ok: false as const, reason: "ddr-overlay-read-failed" }))
      : Promise.resolve(null),
  ]);

  // Index decoded Round 1 + Round 2 maps
  type CachedStablecoinAsset = NonNullable<Extract<
    typeof stablecoinsCache,
    { kind: "ok" | "degraded" }
  >["payload"]>["peggedAssets"][number];
  const stablecoinById = new Map<string, CachedStablecoinAsset>();
  if (stablecoinsUsable) {
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

  const dexRowById = new Map<string, SlimDexLiquidityRow>();
  let dexCohortUpdatedAt: number | null = null;
  let dexGenerationId: string | null = null;
  if (dexRead.ok) {
    for (const row of dexRead.rows) {
      if (row.updated_at > (dexCohortUpdatedAt ?? 0)) {
        dexCohortUpdatedAt = row.updated_at;
      }
      if (row.stablecoin_id === "__global__") {
        dexGenerationId = row.publication_generation_id;
      } else {
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

  const redemptionEntryById: Record<string, RedemptionBackstopEntry> = {};
  if (redemptionAdmission.ok) {
    for (const [id, entry] of Object.entries(redemptionAdmission.map)) {
      redemptionEntryById[id] = projectMentoMarketPhase(entry, nowSec);
    }
  }

  const ddrView = ddrOverlay?.ok ? ddrOverlay.payload : requestedDdrSnapshot;
  const ddrUnavailableReason = ddrCacheLoad.kind !== "ok"
    ? `ddr-${ddrCacheLoad.reason}`
    : ddrContractReason
      ? `ddr-${ddrContractReason}`
      : ddrOverlay && !ddrOverlay.ok ? ddrOverlay.reason : null;
  const ddrOverlayFailures = new Set(
    ddrView?._meta.degradedReason === "secondary-overlay-unavailable"
      ? (ddrView._meta.degradedReasonDetail ?? "").split(",")
      : [],
  );
  const ddrRowById = new Map<string, DdrV2ResponseRow>();
  for (const row of ddrView?.rows ?? []) {
    if (resolvedIdSet.has(row.stablecoinId) && !ddrRowById.has(row.stablecoinId)) {
      ddrRowById.set(row.stablecoinId, row);
    }
  }

  const complianceUpdatedAt = resolveComplianceUpdatedAtSec(complianceIndex.reviewTimestampsSec, nowSec);
  const geniusEffective = resolveGeniusRegimeEffective();

  // Assemble per-asset blocks
  const assets: Record<string, RiskCheckAsset> = {};
  let minMentoPhaseValidUntilSec = Infinity;

  for (const id of resolvedIds) {
    const meta = WORKER_TRACKED_META_BY_ID.get(id) as WorkerRuntimeStablecoinMeta;
    const scAsset = stablecoinById.get(id);
    const pegCoin = pegAnalytics.kind === "ok" ? pegAnalytics.pegDataById.get(id) : undefined;
    const safetyCard = safetyCardById.get(id);
    const rawPillars = safetySnapshot?.scorecardPillarsById?.[id];
    const dewsRow = dewsRowById.get(id);
    const activeDepeg = activeDepegs.byId.get(id) ?? null;
    const dexRow = dexRowById.get(id);
    const redemptionEntry = redemptionEntryById[id];
    const ddrRow = ddrRowById.get(id);
    const compRecord = complianceIndex.byId.get(id);

    // Safety slice
    const safetyPillars = safetyCard?.ratingStatus === "rated" && rawPillars
      ? {
          backing: rawPillars.backing?.score ?? null,
          exit: rawPillars.exit?.score ?? null,
          control: rawPillars.control?.score ?? null,
        }
      : null;
    let safetyUnavailableReason: string | null = null;
    if (safetyIndex.kind === "error") {
      safetyUnavailableReason = safetyIndex.reason;
    } else if (!safetyCard) {
      safetyUnavailableReason = "not-in-safety-index";
    } else if (safetyPublicationStatus === "held") {
      safetyUnavailableReason = "v9-publication-held";
    } else if (safetyPublicationStatus === "stale") {
      safetyUnavailableReason = SAFETY_SCORE_PUBLICATION_AGE_REASON;
    } else if (safetyCard.ratingStatus === "pipeline-gap") {
      safetyUnavailableReason = "pipeline-gap";
    } else if (safetyCard.ratingStatus === "not-rated") {
      safetyUnavailableReason = "not-rated";
    } else if (
      !safetyPillars
      || safetyPillars.backing == null
      || safetyPillars.exit == null
      || safetyPillars.control == null
    ) {
      safetyUnavailableReason = "scorecard-pillars-unavailable";
    }

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

    // Peg slice: every price field comes from one producer per asset (the live
    // stablecoins publication, else the peg-analytics row), never a field mix.
    const priceFields = scAsset
      ? {
          price: scAsset.price ?? null,
          priceSource: scAsset.priceSource ?? null,
          priceConfidence: scAsset.priceConfidence ?? null,
          priceObservedAt: scAsset.priceObservedAt ?? null,
          currentDeviationBps: scAsset.currentPeg?.currentDeviationBps ?? null,
          pegReferenceUnavailable: scAsset.currentPeg?.pegReferenceUnavailable === true,
        }
      : pegCoin
        ? {
            price: pegCoin.price ?? null,
            priceSource: pegCoin.priceSource ?? null,
            priceConfidence: pegCoin.priceConfidence ?? null,
            priceObservedAt: pegCoin.priceObservedAt ?? null,
            currentDeviationBps: pegCoin.currentDeviationBps,
            pegReferenceUnavailable: pegCoin.pegReferenceUnavailable === true,
          }
        : null;
    const pegScore = pegCoin?.pegScore ?? null;
    const pegPct = pegCoin?.pegPct ?? null;
    let pegUnavailableReason: string | null = null;
    if (activeDepegsUnavailableReason) {
      pegUnavailableReason = activeDepegsUnavailableReason;
    } else if (activeDepegs.unreadableIds.has(id)) {
      pegUnavailableReason = "active-depeg-row-unreadable";
    } else if (!priceFields) {
      pegUnavailableReason = stablecoinsUsable ? "price-row-not-published" : `stablecoins-${stablecoinsCache.reason}`;
    } else if (priceFields.price == null) {
      pegUnavailableReason = "price-unavailable";
    } else if (priceFields.currentDeviationBps == null) {
      pegUnavailableReason = priceFields.pegReferenceUnavailable ? "peg-reference-unavailable" : "deviation-unavailable";
    } else if (pegAnalytics.kind !== "ok") {
      pegUnavailableReason = `peg-analytics-${pegAnalytics.reason}`;
    } else if (!pegCoin) {
      pegUnavailableReason = "peg-analytics-row-not-published";
    } else if (pegScore == null || pegPct == null) {
      pegUnavailableReason = "peg-score-unavailable";
    }

    // DDR slice
    let ddrBlock: RiskCheckAsset["ddr"];
    if (ddrUnavailableReason) {
      ddrBlock = unavailableDdrBlock(ddrUnavailableReason);
    } else if (!ddrRow) {
      ddrBlock = unavailableDdrBlock(
        ddrOverlayFailures.has("lock-deferral-overlay-read-failed") ? "lock-deferral-overlay-read-failed" : "no-ddr-row",
      );
    } else if (
      ddrOverlayFailures.has("errata-overlay-read-failed")
      && (ddrRow.kind === "prediction" || ddrRow.kind === "no_call")
    ) {
      ddrBlock = unavailableDdrBlock("errata-overlay-read-failed", ddrRow.live.stale);
    } else if (ddrRow.kind === "invalidated_prediction") {
      ddrBlock = unavailableDdrBlock("prediction-invalidated", ddrRow.live.stale);
    } else if (ddrRow.kind === "pending") {
      ddrBlock = unavailableDdrBlock("prediction-pending", ddrRow.live.stale);
    } else if (ddrRow.kind === "no_call") {
      ddrBlock = unavailableDdrBlock("no-call", ddrRow.live.stale);
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

    // DEX liquidity slice: the dex-liquidity route's evidence quarantine,
    // price admission and stored-volume read contract (R1/R7/R8).
    let liquidityBlock: RiskCheckAsset["liquidity"];
    if (!dexRead.ok) {
      liquidityBlock = unavailableLiquidityBlock("dex-liquidity-read-failed");
    } else if (!dexRow) {
      liquidityBlock = unavailableLiquidityBlock("row-not-published");
    } else {
      let evidenceWarning: string | null = null;
      let evidenceValid = true;
      try {
        const evidence = normalizeDexLiquidityEvidence(dexRow);
        if (!evidence.hasMeasuredLiquidityEvidence) {
          evidenceWarning = "unmeasured-liquidity-evidence";
        }
      } catch {
        evidenceValid = false;
      }
      if (!evidenceValid) {
        liquidityBlock = unavailableLiquidityBlock("invalid-coverage-evidence", dexRow.updated_at);
      } else {
        const priceAdmission = admitDexPriceRow(
          dexRow.dex_price_stablecoin_id == null
            ? undefined
            : {
                updated_at: dexRow.dex_price_updated_at as number,
                price_sources_json: dexRow.dex_price_sources_json,
              },
          dexRow.updated_at,
          nowSec,
          `risk-check:${id}:price_sources_json`,
        );
        const volume24h = readStoredDexVolumeWindow(
          dexRow.total_volume_24h_usd,
          parseDexVolumeAvailabilityRecord(dexRow.volume_availability_json),
          "24h",
        );
        const dexPriceUsd = priceAdmission.unavailableReason == null ? dexRow.dex_price_usd : null;
        liquidityBlock = {
          liquidityScore: dexRow.liquidity_score,
          totalTvlUsd: dexRow.total_tvl_usd,
          volume24hUsd: volume24h.measuredUsd,
          poolCount: dexRow.pool_count,
          dexPriceUsd,
          updatedAt: dexRow.updated_at,
          warning: evidenceWarning,
          unavailableReason: dexRow.liquidity_score == null
            ? "liquidity-score-unavailable"
            : volume24h.measuredUsd == null
              ? `volume-24h-${volume24h.availability?.reason ?? "unavailable"}`
              : priceAdmission.unavailableReason != null
                ? `dex-price-${priceAdmission.unavailableReason}`
                : dexPriceUsd == null ? "dex-price-unavailable" : null,
        };
      }
    }

    // Redemption slice (store admission + Mento market phase)
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
    if (!redemptionAdmission.ok || !redemptionEntry) {
      redemptionBlock = {
        score: null,
        routeFamily: null,
        accessModel: null,
        immediateCapacityUsd: null,
        feeBps: null,
        marketPhase,
        capacitySemantics: null,
        eventualRedeemabilityScore: null,
        unavailableReason: !redemptionAdmission.ok ? "redemption-snapshot-unavailable" : "row-not-published",
      };
    } else {
      const redemptionUnavailableReason =
        redemptionEntry.resolutionState !== "resolved"
          ? redemptionEntry.resolutionState
          : redemptionEntry.score === null
            ? redemptionEntry.capacitySemantics === "eventual-only"
              ? "eventual-only"
              : "score-unavailable"
            : null;
      redemptionBlock = {
        score: redemptionEntry.score,
        routeFamily: redemptionEntry.routeFamily,
        accessModel: redemptionEntry.accessModel,
        immediateCapacityUsd: redemptionEntry.immediateCapacityUsd,
        feeBps: redemptionEntry.feeBps,
        marketPhase,
        capacitySemantics: redemptionEntry.capacitySemantics ?? null,
        eventualRedeemabilityScore: redemptionEntry.eventualRedeemabilityScore ?? null,
        unavailableReason: redemptionUnavailableReason,
      };
    }

    // Controls slice (in-memory)
    const freezeable = meta.blacklistabilityReview?.reviewedStatus ?? null;
    const controlsBlock: RiskCheckAsset["controls"] = {
      freezeable,
      blacklistabilityStatus: freezeable == null ? "unreviewed" : String(freezeable),
      liveFreezeTrackerCovered: BLACKLIST_TRACKED_STABLECOIN_IDS.has(id),
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
        price: priceFields?.price ?? null,
        priceSource: priceFields?.priceSource ?? null,
        priceConfidence: priceFields?.priceConfidence ?? null,
        priceObservedAt: priceFields?.priceObservedAt ?? null,
        currentDeviationBps: priceFields?.currentDeviationBps ?? null,
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

  // Per-producer dependency metadata (R3 / R4): each graded against its own budget.
  const safetyDep = safetySnapshot
    ? gradeDependency(SAFETY_SCORE_POLICY, safetySnapshot.updatedAt, nowSec, {
        generationId: safetySnapshot.safetyScoreIdentity.publicationGenerationId,
        forced: safetyPublicationStatus === "current"
          ? { status: "fresh", reason: null }
          : safetyPublicationStatus === "held"
            ? { status: "degraded", reason: "v9-publication-held" }
            : { status: "stale", reason: SAFETY_SCORE_PUBLICATION_AGE_REASON },
      })
    : unavailableDependency(
        SAFETY_SCORE_POLICY,
        safetyIndex.kind === "error" ? safetyIndex.reason : "safety-score-unavailable",
        nowSec,
      );

  const dewsDep = dewsPointer.status === "ok" && dewsRowsRead.ok
    ? gradeDependency(STRESS_SIGNALS_POLICY, dewsPointer.computedAt, nowSec, {
        generationId: `dews:${dewsPointer.computedAt}`,
      })
    : unavailableDependency(
        STRESS_SIGNALS_POLICY,
        !dewsRowsRead.ok
          ? "dews-read-failed"
          : dewsPointer.status === "no-pointer"
            ? "dews-pointer-missing"
            : "dews-pointer-unavailable",
        nowSec,
      );

  const stablecoinsDep = stablecoinsUsable && stablecoinsCache.updatedAt != null
    ? gradeDependency(STABLECOINS_POLICY, stablecoinsCache.updatedAt, nowSec, {
        degradedReason: stablecoinsCache.kind === "degraded" ? stablecoinsCache.reason : null,
      })
    : unavailableDependency(
        STABLECOINS_POLICY,
        stablecoinsUsable ? "missing-timestamp" : stablecoinsCache.reason,
        nowSec,
      );

  const pegAnalyticsDep = pegAnalytics.kind === "ok"
    ? gradeDependency(PEG_SUMMARY_POLICY, pegAnalytics.payload.computedAtSec, nowSec)
    : unavailableDependency(PEG_SUMMARY_POLICY, pegAnalytics.reason, nowSec);

  // Dated by the producer's confirmed output, as /api/depeg-events is; never the request clock.
  const activeDepegsFreshness = buildCronFreshnessMeta(activeDepegsClock, API_FRESHNESS_MAX_AGE_SEC.depegEvents);
  const activeDepegsDep: GradedDependency = !activeDepegsAvailable
    ? {
        meta: {
          updatedAt: activeDepegsFreshness.updatedAt,
          ageSeconds: activeDepegsFreshness.ageSeconds,
          freshBudgetSec: activeDepegsFreshness.freshBudgetSec,
          generationId: null,
          status: "unavailable",
          reason: activeDepegsUnavailableReason,
        },
        degradedBudgetSec: activeDepegsFreshness.degradedBudgetSec,
      }
    : {
        meta: {
          updatedAt: activeDepegsFreshness.updatedAt,
          ageSeconds: activeDepegsFreshness.ageSeconds,
          freshBudgetSec: activeDepegsFreshness.freshBudgetSec,
          generationId: null,
          status: activeDepegsFreshness.status === "unknown" ? "unavailable" : activeDepegsFreshness.status,
          reason: "reason" in activeDepegsFreshness && activeDepegsFreshness.reason != null
            ? activeDepegsFreshness.reason
            : activeDepegsFreshness.status === "fresh" ? null : `depeg-events-${activeDepegsFreshness.status}`,
        },
        degradedBudgetSec: activeDepegsFreshness.degradedBudgetSec,
      };

  const ddrDependencyReason = ddrCacheLoad.kind !== "ok"
    ? ddrCacheLoad.reason
    : ddrContractReason ?? (ddrOverlay && !ddrOverlay.ok ? ddrOverlay.reason : null);
  const ddrExpiresBudgetSec = ddrSnapshot
    ? Math.max(0, ddrSnapshot._meta.expiresAt - ddrSnapshot._meta.computedAt)
    : undefined;
  const ddrPolicy: DependencyPolicy = ddrExpiresBudgetSec != null
    ? {
        ...DEPEG_RESOLVER_POLICY,
        freshBudgetSec: Math.min(DEPEG_RESOLVER_POLICY.maxAgeSec * FRESHNESS_RATIOS.FRESH, ddrExpiresBudgetSec),
      }
    : DEPEG_RESOLVER_POLICY;
  const ddrDep = ddrSnapshot && ddrView && ddrDependencyReason == null
    ? gradeDependency(ddrPolicy, ddrSnapshot._meta.computedAt, nowSec, {
        generationId: ddrSnapshot._meta.snapshotGeneration != null ? String(ddrSnapshot._meta.snapshotGeneration) : null,
        degradedReason: ddrExpired
          ? "stale-cache"
          : ddrView._meta.degraded ? (ddrView._meta.degradedReason ?? "ddr-degraded") : null,
      })
    : unavailableDependency(DEPEG_RESOLVER_POLICY, ddrDependencyReason ?? "ddr-unavailable", nowSec);

  const dexDep = dexRead.ok && dexCohortUpdatedAt != null
    ? gradeDependency(DEX_LIQUIDITY_POLICY, dexCohortUpdatedAt, nowSec, { generationId: dexGenerationId })
    : unavailableDependency(
        DEX_LIQUIDITY_POLICY,
        !dexRead.ok ? "dex-liquidity-read-failed" : "dex-liquidity-empty",
        nowSec,
      );

  const redemptionDep = redemptionAdmission.ok && redemptionAdmission.run.max_updated_at != null
    ? gradeDependency(REDEMPTION_BACKSTOPS_POLICY, redemptionAdmission.run.max_updated_at, nowSec, {
        generationId: redemptionAdmission.run.run_id,
      })
    : unavailableDependency(
        REDEMPTION_BACKSTOPS_POLICY,
        redemptionAdmission.ok ? "missing-timestamp" : "redemption-snapshot-unavailable",
        nowSec,
        redemptionAdmission.ok ? redemptionAdmission.run.run_id : null,
      );

  const complianceDep = gradeDependency(COMPLIANCE_POLICY, complianceUpdatedAt, nowSec);

  const graded: Record<string, GradedDependency> = {
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
  const dependencies: Record<string, ApiDependencyMeta> = Object.fromEntries(
    Object.entries(graded).map(([name, dep]) => [name, dep.meta]),
  );

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
  const allD1Fresh = d1Dependencies.every((dep) => dep.meta.status === "fresh")
    && safetyPublicationStatus === "current";
  const nonFreshReasons = Object.entries(dependencies)
    .filter(([, dep]) => dep.status !== "fresh")
    .map(([name, dep]) => `${name}:${dep.reason ?? dep.status}`);

  const anyStaleOrUnavailable = d1Dependencies.some((dep) => dep.meta.status === "stale" || dep.meta.status === "unavailable");
  const overallStatus = allD1Fresh ? "fresh" : anyStaleOrUnavailable ? "stale" : "degraded";

  // The dependency whose fresh runway (updatedAt + its own budget) ends first
  // sets the response clock and budget; the oldest clock alone says nothing.
  let binding: GradedDependency | null = null;
  let bindingValidUntilSec = Infinity;
  for (const dep of d1Dependencies) {
    const { updatedAt, freshBudgetSec } = dep.meta;
    if (updatedAt == null || freshBudgetSec == null) continue;
    const validUntilSec = updatedAt + freshBudgetSec;
    if (validUntilSec < bindingValidUntilSec) {
      binding = dep;
      bindingValidUntilSec = validUntilSec;
    }
  }
  const bindingUpdatedAt = binding?.meta.updatedAt ?? null;
  const bindingFreshBudgetSec = binding?.meta.freshBudgetSec ?? null;

  const metaEnvelope: ApiMetaEnvelope = binding && bindingUpdatedAt != null && bindingFreshBudgetSec != null
    ? {
        updatedAt: bindingUpdatedAt,
        ageSeconds: binding.meta.ageSeconds ?? Math.max(0, nowSec - bindingUpdatedAt),
        assessedAt: nowSec,
        freshBudgetSec: bindingFreshBudgetSec,
        degradedBudgetSec: binding.degradedBudgetSec ?? bindingFreshBudgetSec,
        status: overallStatus,
        ...(nonFreshReasons.length > 0 ? { warning: `Degraded or stale dependencies: ${nonFreshReasons.join(", ")}` } : {}),
        dependencies,
      }
    : {
        updatedAt: null,
        ageSeconds: null,
        assessedAt: nowSec,
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

  if (allD1Fresh && bindingUpdatedAt != null && bindingFreshBudgetSec != null) {
    const cacheValidUntil = Math.min(
      bindingValidUntilSec,
      minMentoPhaseValidUntilSec,
      redemptionBackstopPhaseValidUntil(redemptionEntryById, nowSec),
    );
    headers = addFreshnessHeaders(
      { ...headers, "Cache-Control": CACHE_PROFILES.producerBacked },
      bindingUpdatedAt,
      bindingFreshBudgetSec,
      {
        assessedAt: nowSec,
        freshBudgetSec: bindingFreshBudgetSec,
        cacheValidUntil,
      },
    );
  } else {
    headers["Cache-Control"] = CACHE_PROFILES.noStore;
    headers["X-Data-Freshness"] = overallStatus;
    if (bindingUpdatedAt != null) {
      headers["X-Data-Updated-At"] = String(bindingUpdatedAt);
      headers["X-Data-Age"] = String(Math.max(0, nowSec - bindingUpdatedAt));
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
