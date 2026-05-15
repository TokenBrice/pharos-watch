import { PSI_ELIGIBLE_STABLECOINS, PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import { DAY_MS } from "@shared/lib/time-constants";
import { derivePegRates, getPegReference } from "@shared/lib/peg-rates";
import { getCirculatingRaw } from "@shared/lib/supply";
import { cancelResponseBodyQuietly } from "../lib/response-body";
import {
  DEFILLAMA_BASE,
  RUB_FALLBACK,
  USER_AGENT,
} from "../lib/constants";
import { jsonResponse } from "../lib/api-utils";
import { cgUrl, cgHeaders } from "../lib/coingecko";
import { fetchWithRetry } from "../lib/fetch-retry";
import { RATE_LIMITS } from "../lib/rate-limit";
import type { D1Database } from "@cloudflare/workers-types";
import type { StablecoinMeta } from "@shared/types/core";
import { selectBackfillCoins } from "../lib/backfill-query";
import { buildAdminJobSummary, noAdminTargetsResponse, runAdminJob } from "../lib/admin-job";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";

// ── Imports from extracted modules (used in this file) ──────────────
import {
  type FxTimeSeries,
  PEG_TO_FX,
  SECONDARY_PEG_TO_FX,
  OTHER_COIN_FX,
  COMMODITY_PEGS,
  fetchHistoricalFxRates,
  fetchHistoricalSecondaryFxRates,
  buildCommodityMedianSeriesFromCg,
  buildFxLookup,
  type CommodityPeg,
} from "./backfill-fx";

import {
  buildBackfillDeleteStmt,
  parseOptionalDayWindow,
  type BackfillReplayWindow,
} from "./backfill-depegs-window";
import {
  parseSupplyData,
  type SupplyPoint,
  type SupplySnapshot,
} from "./backfill-depegs-extraction";
import {
  buildBackfillReplayPreview,
  loadExistingReplayRows,
  type BackfillReplayPreview,
} from "./backfill-depegs-preview";
import { backfillCoin } from "./backfill-depegs-replay";

const BATCH_SIZE = 3;
const BATCH_CHUNK_SIZE = 100;
const BACKFILL_REPLAY_VERSION = "depeg-backfill-v6.0";
/** Per-coin detail from /stablecoin/:id — includes gecko_id and historical supply */
interface CoinDetail {
  gecko_id?: string;
  address?: string;
  tokens?: SupplyPoint[];
}

interface PreparedBackfillCoin {
  meta: StablecoinMeta;
  geckoId?: string;
  supplyByDate: SupplySnapshot[];
  currentSupplyUsd: number | null;
}

type BackfillConfidenceTier = "high" | "medium" | "low";

interface BackfillEventProvenanceInput {
  replayRunId: string;
  replayVersion: string;
  sourceKind: "market" | "authoritative";
  sourcePriceProviders: string[];
  quoteMode: string | null;
  pegReferenceSource: string;
  supplySource: string;
  confirmationPolicy: string;
  confirmationPointCount: number;
  marketDiagnostics: Record<string, unknown> | null;
  policyAdjustments: unknown[];
  confidenceTier: BackfillConfidenceTier;
  auditVerdict: "confirmed" | "disputed" | "false_positive" | "no_data" | "repaired" | null;
}

interface BackfillRunInput {
  runId: string;
  sourceType: "market" | "authoritative";
  expectedFingerprint: string;
  expectedEventCount: number;
  removedCount: number;
  addedCount: number;
  replayWindow: BackfillReplayWindow | null;
}

function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function buildBackfillEventsFingerprint(events: Array<{
  direction: string;
  peakDeviationBps: number;
  startedAt: number;
  endedAt: number | null;
  startPrice: number;
  peakPrice: number;
  recoveryPrice: number | null;
  pegRef: number;
}>): string {
  return stableHash(JSON.stringify(events.map((event) => ({
    direction: event.direction,
    peakDeviationBps: event.peakDeviationBps,
    startedAt: event.startedAt,
    endedAt: event.endedAt,
    startPrice: event.startPrice,
    peakPrice: event.peakPrice,
    recoveryPrice: event.recoveryPrice,
    pegRef: event.pegRef,
  }))));
}

function buildReplayRunId(stablecoinId: string): string {
  const now = Date.now();
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stablecoinId}:${now}:${suffix}`;
}

function inferBackfillConfidence(input: {
  sourceKind: "market" | "authoritative";
  quoteMode: string | null;
  sourceCount: number;
  policyAdjustmentCount: number;
}): BackfillConfidenceTier {
  if (input.sourceKind === "authoritative") return "high";
  if (input.quoteMode === "native-peg" && input.sourceCount > 0 && input.policyAdjustmentCount === 0) return "high";
  if (input.sourceCount >= 2 && input.policyAdjustmentCount <= 1) return "medium";
  return "low";
}

function buildPublicProvenance(input: BackfillEventProvenanceInput, updatedAt: number): Record<string, unknown> {
  return {
    sourceKind: input.sourceKind,
    replayRunId: input.replayRunId,
    replayVersion: input.replayVersion,
    sourcePriceProviders: input.sourcePriceProviders,
    quoteMode: input.quoteMode,
    pegReferenceSource: input.pegReferenceSource,
    supplySource: input.supplySource,
    confirmationPolicy: input.confirmationPolicy,
    confirmationPointCount: input.confirmationPointCount,
    confidenceTier: input.confidenceTier,
    auditVerdict: input.auditVerdict,
    pegScoreEligible: input.auditVerdict !== "false_positive" && input.auditVerdict !== "disputed",
    updatedAt,
  };
}

function buildUpsertBackfillRunStmt(
  db: D1Database,
  meta: { id: string },
  run: BackfillRunInput,
  status: "started" | "complete" | "incomplete",
  nowSec: number,
  insertedCount: number,
  error: string | null,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO depeg_backfill_runs (
         run_id, stablecoin_id, start_day, end_day, context_days, source_type,
         expected_event_count, expected_fingerprint, removed_count, added_count,
         inserted_count, status, error, started_at, finished_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         inserted_count = excluded.inserted_count,
         status = excluded.status,
         error = excluded.error,
         finished_at = excluded.finished_at`,
    )
    .bind(
      run.runId,
      meta.id,
      run.replayWindow?.startDay ?? null,
      run.replayWindow?.endDay ?? null,
      run.replayWindow?.contextDays ?? null,
      run.sourceType,
      run.expectedEventCount,
      run.expectedFingerprint,
      run.removedCount,
      run.addedCount,
      insertedCount,
      status,
      error,
      nowSec,
      status === "started" ? null : nowSec,
    );
}

function buildInsertProvenanceStmt(
  db: D1Database,
  meta: { id: string },
  event: { startedAt: number },
  provenance: BackfillEventProvenanceInput,
  nowSec: number,
): D1PreparedStatement {
  const publicJson = JSON.stringify(buildPublicProvenance(provenance, nowSec));
  return db
    .prepare(
      `INSERT OR REPLACE INTO depeg_event_provenance (
         event_id, source_kind, replay_run_id, replay_version, source_price_providers,
         quote_mode, peg_reference_source, supply_source, confirmation_policy,
         confirmation_point_count, market_diagnostics_json, policy_adjustments_json,
         confidence_tier, audit_verdict, public_json, created_at, updated_at
       )
       SELECT
         id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       FROM depeg_events
       WHERE stablecoin_id = ? AND source = 'backfill' AND started_at = ?`,
    )
    .bind(
      provenance.sourceKind,
      provenance.replayRunId,
      provenance.replayVersion,
      JSON.stringify(provenance.sourcePriceProviders),
      provenance.quoteMode,
      provenance.pegReferenceSource,
      provenance.supplySource,
      provenance.confirmationPolicy,
      provenance.confirmationPointCount,
      JSON.stringify(provenance.marketDiagnostics),
      JSON.stringify(provenance.policyAdjustments),
      provenance.confidenceTier,
      provenance.auditVerdict,
      publicJson,
      nowSec,
      nowSec,
      meta.id,
      event.startedAt,
    );
}

export async function applyBackfillEvents(
  db: D1Database,
  meta: { id: string; symbol: string },
  events: Array<{
    pegType: string;
    direction: string;
    peakDeviationBps: number;
    startedAt: number;
    endedAt: number | null;
    startPrice: number;
    peakPrice: number;
    recoveryPrice: number | null;
    pegRef: number;
    provenance?: BackfillEventProvenanceInput;
  }>,
  replayWindow: BackfillReplayWindow | null,
  run?: BackfillRunInput,
): Promise<void> {
  const deleteStmt = buildBackfillDeleteStmt(db, meta.id, replayWindow);
  const nowSec = Math.floor(Date.now() / 1000);
  if (run) {
    await buildUpsertBackfillRunStmt(db, meta, run, "started", nowSec, 0, null).run();
  }
  let insertedCount = 0;
  try {
    if (events.length === 0) {
      await db.batch([deleteStmt]);
      if (run) {
        await buildUpsertBackfillRunStmt(db, meta, run, "complete", Math.floor(Date.now() / 1000), 0, null).run();
      }
      return;
    }
    const insertStmts = events.map((e) =>
      db
        .prepare(
          `INSERT INTO depeg_events (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'backfill')`,
        )
        .bind(
          meta.id,
          meta.symbol,
          e.pegType,
          e.direction,
          e.peakDeviationBps,
          e.startedAt,
          e.endedAt,
          e.startPrice,
          e.peakPrice,
          e.recoveryPrice,
          e.pegRef,
        ),
    );
    // First batch: delete + first chunk of inserts so partial crashes cannot leave the coin event-less.
    // D1 limits each batch to 100 statements. Reserve one slot for the delete so the first batch
    // never exceeds the limit; remaining inserts ship in full BATCH_CHUNK_SIZE (100) batches.
    const firstChunkSize = Math.min(insertStmts.length, BATCH_CHUNK_SIZE - 1);
    await db.batch([deleteStmt, ...insertStmts.slice(0, firstChunkSize)]);
    insertedCount += firstChunkSize;
    for (let i = firstChunkSize; i < insertStmts.length; i += BATCH_CHUNK_SIZE) {
      const chunk = insertStmts.slice(i, i + BATCH_CHUNK_SIZE);
      await db.batch(chunk);
      insertedCount += chunk.length;
    }
    const provenanceStmts = events
      .filter((event): event is typeof event & { provenance: BackfillEventProvenanceInput } => event.provenance != null)
      .map((event) => buildInsertProvenanceStmt(db, meta, event, event.provenance, Math.floor(Date.now() / 1000)));
    for (let i = 0; i < provenanceStmts.length; i += BATCH_CHUNK_SIZE) {
      await db.batch(provenanceStmts.slice(i, i + BATCH_CHUNK_SIZE));
    }
    if (run) {
      await buildUpsertBackfillRunStmt(
        db,
        meta,
        run,
        "complete",
        Math.floor(Date.now() / 1000),
        insertedCount,
        null,
      ).run();
    }
  } catch (error) {
    if (run) {
      try {
        await buildUpsertBackfillRunStmt(
          db,
          meta,
          run,
          "incomplete",
          Math.floor(Date.now() / 1000),
          insertedCount,
          error instanceof Error ? error.message : String(error),
        ).run();
      } catch (markError) {
        console.error(`[backfill-depegs] failed to mark incomplete run ${run.runId}:`, markError);
      }
    }
    throw error;
  }
}

export async function handleBackfillDepegs(
  db: D1Database,
  url: URL,
  trustedAdmin?: boolean,
  request?: Request,
  coingeckoApiKey?: string | null,
): Promise<Response> {
  return runAdminJob(
    { request, trustedAdmin, url },
    async (context) => {
      const { dryRun } = context;
      const window = parseOptionalDayWindow(url, {
        includeContextDays: true,
        includeReplayWindow: true,
      });
      if (window instanceof Response) return window;
      const replayWindow = window.replayWindow;

      const selection = selectBackfillCoins(url, PSI_ELIGIBLE_STABLECOINS, {
        defaultBatchSize: BATCH_SIZE,
        allowBatchSizeOverride: false,
      });
      if ("response" in selection) {
        return selection.response;
      }
      const coins = selection.coins;

      if (coins.length === 0) {
        return noAdminTargetsResponse();
      }

      // Get peg rates from cached stablecoin data
      let pegRates: Record<string, number> = { peggedUSD: 1 };
      let fxRates: Record<string, number> | undefined;
      const currentSupplyById = new Map<string, number>();

      const stablecoinsCache = await loadStablecoinsCache(db, { mode: "lenient", allowLegacyArray: true });
      if (stablecoinsCache.kind !== "ok") {
        console.warn(`[backfill-depegs] stablecoins cache ${stablecoinsCache.kind} (${stablecoinsCache.reason})`);
      }
      const stablecoinsPayload =
        stablecoinsCache.kind === "ok" || (stablecoinsCache.kind === "degraded" && stablecoinsCache.payload)
          ? stablecoinsCache.payload
          : null;
      if (stablecoinsPayload) {
        const metaById = new Map(PSI_ELIGIBLE_STABLECOINS.map((s) => [s.id, s]));
        ({ rates: pegRates } = derivePegRates(
          stablecoinsPayload.peggedAssets,
          metaById,
          stablecoinsPayload.fxFallbackRates,
        ));
        fxRates = stablecoinsPayload.fxFallbackRates;
        for (const asset of stablecoinsPayload.peggedAssets) {
          currentSupplyById.set(asset.id, getCirculatingRaw(asset));
        }
      }

      // Filter to processable coins (skip NAV tokens)
      const processable = coins.filter((m) => !m.flags.navToken);

      // Manual overrides for coins where DefiLlama has wrong/missing geckoId

      let totalEvents = 0;
      const errors: string[] = [];
      const skipped: string[] = [];
      const previews: BackfillReplayPreview[] = [];

      // Collect coin details and historical FX currencies needed by this batch
      const neededFxCurrencies = new Set<string>();
      const neededSecondaryFxCurrencies = new Set<string>();
      const neededCommodityPegs = new Set<CommodityPeg>();
      const preparedCoins: PreparedBackfillCoin[] = [];

      // Fetch historical FX rates only as far back as the oldest supply snapshot in this batch.
      // If supply history is missing, fall back to 10 years to preserve current behavior.
      const tenYearsAgoMs = Date.now() - 10 * 365 * DAY_MS;
      const defaultStartDate = new Date(tenYearsAgoMs).toISOString().slice(0, 10);
      const endDate = new Date().toISOString().slice(0, 10);
      let historicalFxStartDate = endDate;

      for (const meta of processable) {
        let detail: CoinDetail | null = null;
        const dlId = meta.llamaId ?? meta.id;
        try {
          const res = await fetchWithRetry(
            `${DEFILLAMA_BASE}/stablecoin/${encodeURIComponent(dlId)}`,
            { headers: { "User-Agent": USER_AGENT } },
            1,
            { timeoutMs: 10_000 },
          );
          if (res?.ok) {
            const raw = await res.json();
            if (raw && typeof raw === "object") {
              detail = raw as CoinDetail;
            }
          } else {
            await cancelResponseBodyQuietly(res);
          }
        } catch (err) {
          console.error(`[backfill-depegs] Failed to fetch detail for ${meta.symbol}:`, err);
        }

        const trackedMeta = PSI_ELIGIBLE_META_BY_ID.get(meta.id);
        const geckoId = trackedMeta?.geckoId ?? detail?.gecko_id;
        const supplyByDate = parseSupplyData(detail?.tokens ?? []);
        preparedCoins.push({
          meta,
          geckoId,
          supplyByDate,
          currentSupplyUsd: currentSupplyById.get(meta.id) ?? null,
        });

        const peg = meta.flags.pegCurrency;
        if (peg === "USD") continue;

        let earliestDate: string;
        if (supplyByDate[0]) {
          earliestDate = new Date(supplyByDate[0].ts * 1000).toISOString().slice(0, 10);
        } else if (SECONDARY_PEG_TO_FX[peg] && geckoId) {
          // Secondary FX coins with no DL supply data would otherwise default to 10 years,
          // triggering ~3,600 per-day CDN fetches for the cold-start FX cache build.
          // Fetch the CG ATL/genesis date to anchor the window to the coin's actual inception.
          try {
            await new Promise((r) => setTimeout(r, RATE_LIMITS.COINGECKO_BACKFILL_MS));
            const cgRes = await fetchWithRetry(
              cgUrl(
                `/coins/${geckoId}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`,
                coingeckoApiKey ?? null,
              ),
              { headers: cgHeaders({ "User-Agent": USER_AGENT }, coingeckoApiKey ?? null) },
              1,
              { timeoutMs: 10_000 },
            );
            if (cgRes?.ok) {
              const cgData = (await cgRes.json()) as {
                genesis_date?: string | null;
                market_data?: { atl_date?: Record<string, string> };
              };
              const inceptionStr = cgData.genesis_date ?? cgData.market_data?.atl_date?.["usd"];
              if (inceptionStr) {
                const d = new Date(inceptionStr);
                d.setUTCDate(d.getUTCDate() - 7); // 7-day buffer
                earliestDate = d.toISOString().slice(0, 10);
              } else {
                earliestDate = defaultStartDate;
              }
            } else {
              await cancelResponseBodyQuietly(cgRes);
              earliestDate = defaultStartDate;
            }
          } catch {
            earliestDate = defaultStartDate;
          }
        } else {
          earliestDate = defaultStartDate;
        }
        if (earliestDate < historicalFxStartDate) {
          historicalFxStartDate = earliestDate;
        }

        if (COMMODITY_PEGS.has(peg)) {
          neededCommodityPegs.add(peg as CommodityPeg);
        } else {
          const secondaryFx = SECONDARY_PEG_TO_FX[peg];
          if (secondaryFx) {
            neededSecondaryFxCurrencies.add(secondaryFx);
            continue;
          }

          const fx = PEG_TO_FX[peg] ?? OTHER_COIN_FX[meta.id];
          if (fx) {
            neededFxCurrencies.add(fx);
          }
        }
      }

      // Fetch FX rates and commodity peer-median series in parallel.
      // Commodity peg reference is derived from the median of all tracked gold/silver
      // token CG prices — same approach as derivePegRates() in the live system.
      const fxPromise =
        neededFxCurrencies.size > 0
          ? fetchHistoricalFxRates([...neededFxCurrencies], historicalFxStartDate, endDate)
          : Promise.resolve({} as Record<string, FxTimeSeries[]>);

      const secondaryFxPromise =
        neededSecondaryFxCurrencies.size > 0
          ? fetchHistoricalSecondaryFxRates(db, [...neededSecondaryFxCurrencies], historicalFxStartDate, endDate)
          : Promise.resolve({} as Record<string, FxTimeSeries[]>);

      const commodityRange = replayWindow
        ? {
            startSec: replayWindow.replayStartSec,
            endSec: replayWindow.replayEndSec,
          }
        : undefined;
      const commodityPegs = [...neededCommodityPegs].sort();
      const commodityPromise = commodityPegs.length > 0
        ? buildCommodityMedianSeriesFromCg(commodityRange, coingeckoApiKey ?? null, commodityPegs)
        : Promise.resolve({} as Record<string, FxTimeSeries[]>);

      const [fxSeriesPrimary, fxSeriesSecondary, commoditySeries] = await Promise.all([
        fxPromise,
        secondaryFxPromise,
        commodityPromise,
      ]);
      const fxSeries = { ...fxSeriesPrimary, ...fxSeriesSecondary };

      // Process coins sequentially — each still needs CG price history fetch.
      // Serializing avoids memory pressure from parsing multiple large JSON responses.
      for (const { meta, geckoId, supplyByDate, currentSupplyUsd } of preparedCoins) {
        if (!geckoId) {
          skipped.push(meta.symbol);
          continue;
        }

        // Build time-varying peg reference function for this coin
        const peg = meta.flags.pegCurrency;
        const pegType = `pegged${peg}`;
        const currentPegRef = getPegReference(pegType, pegRates, meta.commodityOunces);
        let getPegRef: (timestamp: number) => number;

        if (peg === "USD") {
          getPegRef = () => 1;
        } else if (COMMODITY_PEGS.has(peg)) {
          // Commodity peg (gold/silver): use historical spot price series
          const series = commoditySeries[peg] ?? [];
          const fallback = currentPegRef > 0 ? currentPegRef : 1;
          const spotLookup = buildFxLookup(series, fallback);
          if (meta.commodityOunces && meta.commodityOunces > 0) {
            const oz = meta.commodityOunces;
            getPegRef = (ts) => spotLookup(ts) * oz;
          } else {
            getPegRef = spotLookup;
          }
        } else {
          const fxCode = PEG_TO_FX[peg] ?? SECONDARY_PEG_TO_FX[peg] ?? OTHER_COIN_FX[meta.id];
          const series = fxCode ? (fxSeries[fxCode] ?? []) : [];
          const fallbackRate = fxRates?.[pegType];
          const fallback =
            typeof fallbackRate === "number" && fallbackRate > 0
              ? fallbackRate
              : currentPegRef > 0
                ? currentPegRef
                : peg === "RUB"
                  ? RUB_FALLBACK
                  : 1;
          const fxLookup = buildFxLookup(series, fallback);
          getPegRef = fxLookup;
        }

        try {
          const replay = await backfillCoin({
            meta,
            geckoId,
            getPegRef,
            supplyByDate,
            fxRates,
            replayWindow,
            coingeckoApiKey: coingeckoApiKey ?? null,
            missingSupplyUsd: currentSupplyUsd,
          });
          const events = replay.events;

          if (dryRun) {
            const existingRows = await loadExistingReplayRows(db, meta.id, replayWindow);
            previews.push(buildBackfillReplayPreview({
              meta,
              sourceKind: replay.sourceKind,
              authoritativeSource: replay.authoritativeSource,
              marketDiagnostics: replay.marketDiagnostics,
              existingRows,
              events,
            }));
            if (events === null) {
              skipped.push(meta.symbol);
              continue;
            }
            totalEvents += events.length;
            continue;
          }

          // null = no trusted historical source available -> preserve existing rows
          if (events === null) {
            skipped.push(meta.symbol);
            continue;
          }

          // Only replace backfill-sourced events; preserve live-cron-detected events
          // (live cron catches brief intraday depegs that daily backfill data misses).
          const existingRows = await loadExistingReplayRows(db, meta.id, replayWindow);
          const preview = buildBackfillReplayPreview({
            meta,
            sourceKind: replay.sourceKind,
            authoritativeSource: replay.authoritativeSource,
            marketDiagnostics: replay.marketDiagnostics,
            existingRows,
            events,
          });
          const runId = buildReplayRunId(meta.id);
          const sourceKind = replay.sourceKind === "authoritative" ? "authoritative" : "market";
          const sourceProviders = sourceKind === "authoritative"
            ? [replay.authoritativeSource ?? "authoritative"]
            : replay.marketDiagnostics?.sourcesUsed ?? [];
          const quoteMode = replay.marketDiagnostics?.quoteMode ?? (meta.flags.pegCurrency === "USD" ? "usd" : null);
          const confidenceTier = inferBackfillConfidence({
            sourceKind,
            quoteMode,
            sourceCount: sourceProviders.length,
            policyAdjustmentCount: replay.marketDiagnostics?.policyAdjustments.length ?? 0,
          });
          const provenance: BackfillEventProvenanceInput = {
            replayRunId: runId,
            replayVersion: BACKFILL_REPLAY_VERSION,
            sourceKind,
            sourcePriceProviders: sourceProviders,
            quoteMode,
            pegReferenceSource: quoteMode === "native-peg"
              ? "native-peg-history"
              : meta.flags.pegCurrency === "USD"
                ? "fixed-usd"
                : "historical-fx-or-current-fallback",
            supplySource: supplyByDate.length > 0 ? "defillama-history" : "stablecoins-cache-current",
            confirmationPolicy: quoteMode === "native-peg" ? "two-point-36h-or-extreme" : "threshold-crossing",
            confirmationPointCount: quoteMode === "native-peg" ? 2 : 1,
            marketDiagnostics: replay.marketDiagnostics ? {
              sourcesUsed: replay.marketDiagnostics.sourcesUsed,
              mergeReasons: replay.marketDiagnostics.mergeReasons,
              quoteMode: replay.marketDiagnostics.quoteMode,
              quoteCurrency: replay.marketDiagnostics.quoteCurrency,
            } : null,
            policyAdjustments: replay.marketDiagnostics?.policyAdjustments ?? [],
            confidenceTier,
            auditVerdict: events.length > 0 ? "confirmed" : "no_data",
          };
          const replayEvents = events.map((e) => ({
            pegType: e.pegType,
            direction: e.direction,
            peakDeviationBps: e.peakDeviationBps,
            startedAt: e.startedAt,
            endedAt: e.endedAt,
            startPrice: e.startPrice,
            peakPrice: e.peakPrice,
            recoveryPrice: e.recoveryPrice,
            pegRef: e.pegRef,
            provenance,
          }));
          await applyBackfillEvents(db, { id: meta.id, symbol: meta.symbol }, replayEvents, replayWindow, {
            runId,
            sourceType: sourceKind,
            expectedEventCount: events.length,
            expectedFingerprint: buildBackfillEventsFingerprint(replayEvents),
            removedCount: preview.removedBackfillEventCount,
            addedCount: preview.addedBackfillEventCount,
            replayWindow,
          });
          totalEvents += events.length;
        } catch (err) {
          errors.push(`${meta.symbol}: ${err}`);
        }
      }

      if (dryRun) {
        return jsonResponse(buildAdminJobSummary({
          dryRun: true,
          coinsProcessed: coins.length,
          recomputedBackfillEvents: totalEvents,
          startDay: replayWindow?.startDay ?? null,
          endDay: replayWindow?.endDay ?? null,
          contextDays: replayWindow?.contextDays ?? null,
          previews,
          skipped,
          errors,
          commodities: commodityPegs.length > 0
            ? {
                goldDataPoints: commoditySeries["GOLD"]?.length ?? 0,
                silverDataPoints: commoditySeries["SILVER"]?.length ?? 0,
              }
            : undefined,
        }));
      }

      return jsonResponse(buildAdminJobSummary({
        coinsProcessed: coins.length,
        eventsCreated: totalEvents,
        skipped,
        errors,
        commodities: commodityPegs.length > 0
          ? {
              goldDataPoints: commoditySeries["GOLD"]?.length ?? 0,
              silverDataPoints: commoditySeries["SILVER"]?.length ?? 0,
            }
          : undefined,
      }));
    },
  );
}
