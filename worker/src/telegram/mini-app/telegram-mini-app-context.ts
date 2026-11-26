import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { isThreatBand } from "@shared/lib/classification/risk";
import { deriveDepegSignal } from "@shared/lib/depeg-signals";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { TELEGRAM_PRESET_IDS } from "@shared/lib/telegram-presets";
import type {
  TelegramMiniAppActiveDepeg,
  TelegramMiniAppCoinSignal,
  TelegramMiniAppCoinsContext,
  TelegramMiniAppContext,
  TelegramMiniAppContextProvenance,
  TelegramMiniAppContextRequest,
  TelegramMiniAppPresetsContext,
} from "@shared/lib/telegram-mini-app-contract";
import type { StablecoinData } from "@shared/types/supply";
import { isPairedDepegPeak } from "../../lib/depeg-helpers";
import { readAdmittedPeerOnset, readAdmittedPeerPeak, readPendingObservationReceipt } from "../../lib/depeg-pending";
import { readDewsPublishedGenerationResult } from "../../lib/dews-publication-pointer";
import { loadActiveSafetyScoreIndex } from "../../lib/safety-score-index";
import { loadStablecoinsCache, type StablecoinsCacheLoadResult } from "../../lib/stablecoins-cache";
import {
  loadStressSignalCurrentRowForCoin,
  loadStressSignalCurrentRows,
  type StressSignalCurrentRow,
} from "../../lib/stress-signals-current-rows";
import { resolveTelegramPresetTargets } from "../common/presets";
import { isSubscribableCoin } from "../store/subscription-eligibility";

type ContextDepegRow = Parameters<typeof readAdmittedPeerPeak>[0] & {
  direction: string;
  peg_reference: number;
};

function okProvenance(
  source: string,
  assessedAt: number,
  observedAt: number | null,
  generation: string | null,
  budgetSec: number,
): TelegramMiniAppContextProvenance {
  return { status: "ok", source, assessedAt, observedAt, generation, budgetSec };
}

function nonOkProvenance(
  status: "stale" | "unavailable",
  source: string,
  assessedAt: number,
  observedAt: number | null,
  generation: string | null,
  budgetSec: number,
  reason: string,
): TelegramMiniAppContextProvenance {
  return { status, source, assessedAt, observedAt, generation, budgetSec, reason };
}

function stablecoinsGeneration(cache: Extract<StablecoinsCacheLoadResult, { kind: "ok" }>): string {
  return cache.payload.fxAdmissionCoverageGeneration ?? `stablecoins:${cache.updatedAt}`;
}

function depegComparisonBasis(row: ContextDepegRow): Pick<
  TelegramMiniAppActiveDepeg,
  "peerRelative" | "peerOpening" | "peakBasisUnavailable"
> {
  if (!row.peer_basis_json) return {};
  const opening = readAdmittedPeerOnset(row) ? { peerOpening: true as const } : {};
  if (readAdmittedPeerPeak(row)) return { ...opening, peerRelative: true as const };
  const peak = readPendingObservationReceipt(row.peer_basis_json)?.peak;
  const knownPeak = peak && peak.basis !== "peer-relative" && peak.observedAt >= row.started_at
    && peak.price === row.peak_price && peak.pegReference === row.peak_peg_reference
    && isPairedDepegPeak(peak.price, peak.pegReference, row.peak_deviation_bps);
  return (opening.peerOpening || peak?.basis === "peer-relative") && !knownPeak
    ? { ...opening, peakBasisUnavailable: true as const }
    : opening;
}

export function validateContextRequestCoinIds(stablecoinIds: readonly string[]): boolean {
  return stablecoinIds.every((stablecoinId) => isSubscribableCoin(stablecoinId));
}

async function loadScopedOpenDepegs(
  db: D1Database,
  stablecoinIds: readonly string[],
): Promise<{ ok: true; rows: ContextDepegRow[] } | { ok: false; reason: string }> {
  if (stablecoinIds.length === 0) return { ok: true, rows: [] };
  const placeholders = stablecoinIds.map(() => "?").join(", ");
  try {
    // SAFETY: placeholders match bounded 1..20 validated stablecoinIds; values use D1 binds.
    const result = await db
      .prepare(
        `SELECT stablecoin_id, direction, peak_deviation_bps, started_at, peg_reference, peg_type,
                start_price, peak_price, peak_peg_reference, peak_quote_domain, peer_basis_json
           FROM depeg_events
          WHERE ended_at IS NULL AND stablecoin_id IN (${placeholders})
          ORDER BY started_at DESC`,
      )
      .bind(...stablecoinIds)
      .all<ContextDepegRow>();
    return { ok: true, rows: result.results ?? [] };
  } catch {
    return { ok: false, reason: "depeg-events-read-failed" };
  }
}

interface DewsLoadState {
  pointerStatus: "ok" | "unavailable";
  pointerReason: string | null;
  generation: string | null;
  readFailed: boolean;
  rowsById: Map<string, Pick<StressSignalCurrentRow, "band" | "score" | "computed_at">>;
}

async function loadScopedDews(
  db: D1Database,
  stablecoinIds: readonly string[],
  nowSec: number,
): Promise<DewsLoadState> {
  const pointer = await readDewsPublishedGenerationResult(db, nowSec);
  if (pointer.status !== "ok") {
    const reason = pointer.status === "no-pointer"
      ? "dews-publication-missing"
      : pointer.status === "invalid-pointer"
        ? "dews-pointer-invalid"
        : "dews-pointer-read-failed";
    return { pointerStatus: "unavailable", pointerReason: reason, generation: null, readFailed: false, rowsById: new Map() };
  }
  const generation = `dews:${pointer.computedAt}`;
  let readFailed = false;
  let unavailableReason: string | null = null;
  const rowsById = new Map<string, Pick<StressSignalCurrentRow, "band" | "score" | "computed_at">>();
  const staleAfterSec = API_FRESHNESS_MAX_AGE_SEC.stressSignals;
  const options = {
    staleAfterSec,
    onReadError: () => {
      readFailed = true;
    },
    onGenerationUnavailable: (reason: string) => {
      unavailableReason = reason;
    },
  };
  try {
    if (stablecoinIds.length === 1) {
      const id = stablecoinIds[0]!;
      const row = await loadStressSignalCurrentRowForCoin(db, id, nowSec, options);
      if (row) rowsById.set(id, row);
    } else {
      const requestedSet = new Set(stablecoinIds);
      const { results } = await loadStressSignalCurrentRows(db, nowSec, options);
      for (const row of results) {
        if (requestedSet.has(row.stablecoin_id)) rowsById.set(row.stablecoin_id, row);
      }
    }
  } catch {
    readFailed = true;
  }
  if (unavailableReason) {
    return { pointerStatus: "unavailable", pointerReason: "dews-pointer-invalid", generation: null, readFailed, rowsById: new Map() };
  }
  return { pointerStatus: "ok", pointerReason: null, generation, readFailed, rowsById };
}

function buildPriceSignal(
  asset: StablecoinData | undefined,
  stablecoinsCache: StablecoinsCacheLoadResult,
  nowSec: number,
): TelegramMiniAppCoinSignal["price"] {
  const budgetSec = API_FRESHNESS_MAX_AGE_SEC.stablecoins;
  if (stablecoinsCache.kind !== "ok") {
    return {
      provenance: nonOkProvenance("unavailable", "stablecoins-cache", nowSec, null, null, budgetSec, stablecoinsCache.reason),
      priceUsd: null,
    };
  }
  const generation = stablecoinsGeneration(stablecoinsCache);
  const pubUpdatedAt = stablecoinsCache.updatedAt;
  if (!Number.isInteger(pubUpdatedAt) || pubUpdatedAt <= 0 || pubUpdatedAt > nowSec) {
    return {
      provenance: nonOkProvenance("unavailable", "stablecoins-cache", nowSec, null, generation, budgetSec, "invalid-publication-clock"),
      priceUsd: null,
    };
  }
  if (!asset) {
    return {
      provenance: nonOkProvenance("unavailable", "stablecoins-cache", nowSec, pubUpdatedAt, generation, budgetSec, "asset-not-in-publication"),
      priceUsd: null,
    };
  }
  if (!isObservedPrice(asset)) {
    return {
      provenance: nonOkProvenance("unavailable", "stablecoins-cache", nowSec, pubUpdatedAt, generation, budgetSec, "price-not-observed"),
      priceUsd: null,
    };
  }
  if (typeof asset.price !== "number" || !Number.isFinite(asset.price) || asset.price <= 0) {
    return {
      provenance: nonOkProvenance("unavailable", "stablecoins-cache", nowSec, pubUpdatedAt, generation, budgetSec, "price-missing"),
      priceUsd: null,
    };
  }
  const rawObservedAt = asset.priceObservedAt ?? asset.priceUpdatedAt ?? null;
  if (typeof rawObservedAt !== "number" || !Number.isFinite(rawObservedAt) || rawObservedAt <= 0 || rawObservedAt > nowSec) {
    return {
      provenance: nonOkProvenance("unavailable", "stablecoins-cache", nowSec, null, generation, budgetSec, "price-clock-invalid"),
      priceUsd: null,
    };
  }
  const observedAt = Math.floor(rawObservedAt);
  if (nowSec - observedAt > budgetSec || nowSec - pubUpdatedAt > budgetSec) {
    return {
      provenance: nonOkProvenance("stale", "stablecoins-cache", nowSec, observedAt, generation, budgetSec, "price-stale"),
      priceUsd: asset.price,
    };
  }
  return {
    provenance: okProvenance("stablecoins-cache", nowSec, observedAt, generation, budgetSec),
    priceUsd: asset.price,
  };
}

function buildDewsSignal(
  stablecoinId: string,
  dewsState: DewsLoadState,
  nowSec: number,
): TelegramMiniAppCoinSignal["dews"] {
  const budgetSec = API_FRESHNESS_MAX_AGE_SEC.stressSignals;
  if (dewsState.pointerStatus !== "ok") {
    return {
      provenance: nonOkProvenance("unavailable", "stress_signals", nowSec, null, null, budgetSec, dewsState.pointerReason ?? "dews-unavailable"),
      band: null,
      score: null,
    };
  }
  const row = dewsState.rowsById.get(stablecoinId);
  if (!row) {
    return {
      provenance: nonOkProvenance(
        "unavailable",
        "stress_signals",
        nowSec,
        null,
        dewsState.generation,
        budgetSec,
        dewsState.readFailed ? "dews-read-failed" : "dews-unobserved",
      ),
      band: null,
      score: null,
    };
  }
  if (
    !isThreatBand(row.band)
    || typeof row.score !== "number"
    || !Number.isFinite(row.score)
    || row.score < 0
    || row.score > 100
    || !Number.isInteger(row.computed_at)
    || row.computed_at <= 0
    || row.computed_at > nowSec
  ) {
    return {
      provenance: nonOkProvenance("unavailable", "stress_signals", nowSec, null, dewsState.generation, budgetSec, "dews-row-invalid"),
      band: null,
      score: null,
    };
  }
  const generation = `dews:${row.computed_at}`;
  if (nowSec - row.computed_at > budgetSec) {
    return {
      provenance: nonOkProvenance("stale", "stress_signals", nowSec, row.computed_at, generation, budgetSec, "dews-stale"),
      band: row.band,
      score: row.score,
    };
  }
  return {
    provenance: okProvenance("stress_signals", nowSec, row.computed_at, generation, budgetSec),
    band: row.band,
    score: row.score,
  };
}

function buildSafetySignal(
  stablecoinId: string,
  safetyIndex: Awaited<ReturnType<typeof loadActiveSafetyScoreIndex>>,
  cardsById: ReadonlyMap<string, Extract<Awaited<ReturnType<typeof loadActiveSafetyScoreIndex>>, { kind: "v9" | "held" }>["snapshot"]["cards"][number]>,
  nowSec: number,
): TelegramMiniAppCoinSignal["safety"] {
  const budgetSec = API_FRESHNESS_MAX_AGE_SEC.reportCards;
  if (safetyIndex.kind === "error") {
    return {
      provenance: nonOkProvenance("unavailable", "safety-score-index", nowSec, null, null, budgetSec, safetyIndex.reason),
      ratingStatus: null,
      grade: null,
      score: null,
      held: false,
      methodologyVersion: null,
      publicationId: null,
    };
  }
  const held = safetyIndex.kind === "held";
  const snapshot = safetyIndex.snapshot;
  const observedAt = Number.isInteger(snapshot.updatedAt) && snapshot.updatedAt > 0 ? snapshot.updatedAt : null;
  const publicationId = snapshot.safetyScoreIdentity.publicationGenerationId;
  const methodologyVersion = snapshot.safetyScoreIdentity.methodologyVersion;
  const card = cardsById.get(stablecoinId);
  if (!card) {
    return {
      provenance: nonOkProvenance("unavailable", "safety-score-index", nowSec, observedAt, publicationId, budgetSec, "safety-card-missing"),
      ratingStatus: null,
      grade: null,
      score: null,
      held,
      methodologyVersion,
      publicationId,
    };
  }
  // R8 per-asset quarantine: validate ratingStatus / grade / score coherence per coin.
  const validRated = card.ratingStatus === "rated"
    && typeof card.grade === "string"
    && card.grade.length > 0
    && typeof card.score === "number"
    && Number.isFinite(card.score)
    && card.score >= 0
    && card.score <= 100;
  const validNotRated = card.ratingStatus === "not-rated" && card.grade === "NR" && card.score === null;
  const validPipelineGap = card.ratingStatus === "pipeline-gap" && card.grade === null && card.score === null;
  if (!validRated && !validNotRated && !validPipelineGap) {
    return {
      provenance: nonOkProvenance("unavailable", "safety-score-index", nowSec, observedAt, publicationId, budgetSec, "safety-card-invalid"),
      ratingStatus: null,
      grade: null,
      score: null,
      held,
      methodologyVersion,
      publicationId,
    };
  }
  if (held) {
    return {
      provenance: nonOkProvenance("stale", "safety-score-index", nowSec, observedAt, publicationId, budgetSec, safetyIndex.reason),
      ratingStatus: card.ratingStatus,
      grade: card.grade,
      score: card.score,
      held: true,
      methodologyVersion,
      publicationId,
    };
  }
  if (observedAt == null || observedAt > nowSec || nowSec - observedAt > budgetSec) {
    return {
      provenance: nonOkProvenance(
        observedAt == null || observedAt > nowSec ? "unavailable" : "stale",
        "safety-score-index",
        nowSec,
        observedAt != null && observedAt <= nowSec ? observedAt : null,
        publicationId,
        budgetSec,
        observedAt == null || observedAt > nowSec ? "invalid-publication-clock" : "safety-publication-stale",
      ),
      ratingStatus: card.ratingStatus,
      grade: card.grade,
      score: card.score,
      held: false,
      methodologyVersion,
      publicationId,
    };
  }
  return {
    provenance: okProvenance("safety-score-index", nowSec, observedAt, publicationId, budgetSec),
    ratingStatus: card.ratingStatus,
    grade: card.grade,
    score: card.score,
    held: false,
    methodologyVersion,
    publicationId,
  };
}

function buildActiveDepegsLane(
  depegRead: Awaited<ReturnType<typeof loadScopedOpenDepegs>>,
  stablecoinsCache: StablecoinsCacheLoadResult,
  priceSignalById: ReadonlyMap<string, TelegramMiniAppCoinSignal["price"]>,
  nowSec: number,
): TelegramMiniAppCoinsContext["activeDepegs"] {
  const budgetSec = API_FRESHNESS_MAX_AGE_SEC.depegEvents;
  if (!depegRead.ok) {
    return {
      provenance: nonOkProvenance("unavailable", "depeg_events", nowSec, null, null, budgetSec, depegRead.reason),
      events: [],
    };
  }
  if (stablecoinsCache.kind !== "ok") {
    return {
      provenance: nonOkProvenance("unavailable", "depeg_events", nowSec, null, null, budgetSec, stablecoinsCache.reason),
      events: [],
    };
  }
  const observedAt = stablecoinsCache.updatedAt;
  const generation = stablecoinsGeneration(stablecoinsCache);
  if (!Number.isInteger(observedAt) || observedAt <= 0 || observedAt > nowSec) {
    return {
      provenance: nonOkProvenance("unavailable", "depeg_events", nowSec, null, generation, budgetSec, "invalid-publication-clock"),
      events: [],
    };
  }

  const seenIds = new Set<string>();
  const events: TelegramMiniAppActiveDepeg[] = [];
  for (const row of depegRead.rows) {
    if (seenIds.has(row.stablecoin_id)) continue;
    if (
      (row.direction !== "above" && row.direction !== "below")
      || !Number.isFinite(row.peak_deviation_bps)
      || !Number.isInteger(row.started_at)
      || row.started_at < 0
    ) {
      continue;
    }
    seenIds.add(row.stablecoin_id);
    const priceSignal = priceSignalById.get(row.stablecoin_id);
    const livePriceUsd = priceSignal?.provenance.status === "ok" ? priceSignal.priceUsd : null;
    const pegReference = typeof row.peg_reference === "number" && Number.isFinite(row.peg_reference) && row.peg_reference > 0
      ? row.peg_reference
      : null;
    const isFixedUsd = row.peg_type === "peggedUSD";
    let currentDeviationBps: number | null = null;
    if (isFixedUsd && livePriceUsd != null) {
      currentDeviationBps = deriveDepegSignal(livePriceUsd, 1)?.bps ?? null;
    } else {
      const latestBps = readPendingObservationReceipt(row.peer_basis_json)?.latest?.bps;
      if (typeof latestBps === "number" && Number.isFinite(latestBps)) {
        currentDeviationBps = Math.round(latestBps);
      }
    }
    events.push({
      stablecoinId: row.stablecoin_id,
      direction: row.direction,
      peakDeviationBps: row.peak_deviation_bps,
      currentDeviationBps,
      priceUsd: livePriceUsd,
      pegReference,
      startedAt: row.started_at,
      ...depegComparisonBasis(row),
    });
  }

  const provenance = nowSec - observedAt > budgetSec
    ? nonOkProvenance("stale", "depeg_events", nowSec, observedAt, generation, budgetSec, "depeg-source-stale")
    : okProvenance("depeg_events", nowSec, observedAt, generation, budgetSec);
  return { provenance, events };
}

async function loadCoinsContext(
  db: D1Database,
  stablecoinIds: readonly string[],
  nowSec: number,
): Promise<TelegramMiniAppCoinsContext> {
  const [stablecoinsCache, depegRead, dewsState, safetyIndex] = await Promise.all([
    loadStablecoinsCache(db, { mode: "strict" }),
    loadScopedOpenDepegs(db, stablecoinIds),
    loadScopedDews(db, stablecoinIds, nowSec),
    loadActiveSafetyScoreIndex(db),
  ]);

  const assetById = new Map<string, StablecoinData>();
  if (stablecoinsCache.kind === "ok") {
    const requestedSet = new Set(stablecoinIds);
    for (const asset of stablecoinsCache.payload.peggedAssets) {
      if (requestedSet.has(asset.id)) assetById.set(asset.id, asset);
    }
  }
  const safetyCardsById = new Map(
    safetyIndex.kind === "error"
      ? []
      : safetyIndex.snapshot.cards.map((card) => [card.id, card] as const),
  );

  const priceSignalById = new Map<string, TelegramMiniAppCoinSignal["price"]>();
  const coinSignals: Record<string, TelegramMiniAppCoinSignal> = {};
  for (const stablecoinId of stablecoinIds) {
    const price = buildPriceSignal(assetById.get(stablecoinId), stablecoinsCache, nowSec);
    priceSignalById.set(stablecoinId, price);
    coinSignals[stablecoinId] = {
      price,
      dews: buildDewsSignal(stablecoinId, dewsState, nowSec),
      safety: buildSafetySignal(stablecoinId, safetyIndex, safetyCardsById, nowSec),
    };
  }

  return {
    kind: "coins",
    activeDepegs: buildActiveDepegsLane(depegRead, stablecoinsCache, priceSignalById, nowSec),
    coinSignals,
  };
}

async function loadPresetsContext(
  db: D1Database,
  nowSec: number,
): Promise<TelegramMiniAppPresetsContext> {
  const budgetSec = API_FRESHNESS_MAX_AGE_SEC.stablecoins;
  const cacheResult = await loadStablecoinsCache(db, { mode: "strict" });
  if (cacheResult.kind !== "ok") {
    return {
      kind: "presets",
      provenance: nonOkProvenance("unavailable", "stablecoins-cache", nowSec, null, null, budgetSec, cacheResult.reason),
      presets: [],
    };
  }
  const observedAt = cacheResult.updatedAt;
  const generation = stablecoinsGeneration(cacheResult);
  if (!Number.isInteger(observedAt) || observedAt <= 0 || observedAt > nowSec) {
    return {
      kind: "presets",
      provenance: nonOkProvenance("unavailable", "stablecoins-cache", nowSec, null, generation, budgetSec, "invalid-publication-clock"),
      presets: [],
    };
  }
  const resolved = await resolveTelegramPresetTargets(db, TELEGRAM_PRESET_IDS, {
    getStablecoinsCacheResult: () => Promise.resolve(cacheResult),
  });
  if (resolved.kind !== "ok") {
    return {
      kind: "presets",
      provenance: nonOkProvenance("unavailable", "stablecoins-cache", nowSec, observedAt, generation, budgetSec, resolved.reason),
      presets: [],
    };
  }
  const provenance = nowSec - observedAt > budgetSec
    ? nonOkProvenance("stale", "stablecoins-cache", nowSec, observedAt, generation, budgetSec, "stablecoins-publication-stale")
    : okProvenance("stablecoins-cache", nowSec, observedAt, generation, budgetSec);
  return {
    kind: "presets",
    provenance,
    presets: resolved.presets.map((preset) => ({
      id: preset.definition.id,
      memberCount: preset.stablecoinIds.length,
      topSymbols: preset.coins.slice(0, 3).map((coin) => coin.symbol),
    })),
  };
}

export async function loadTelegramMiniAppContext(
  db: D1Database,
  request: TelegramMiniAppContextRequest,
  nowSec: number,
): Promise<TelegramMiniAppContext> {
  if (request.kind === "presets") {
    return loadPresetsContext(db, nowSec);
  }
  return loadCoinsContext(db, request.stablecoinIds, nowSec);
}
