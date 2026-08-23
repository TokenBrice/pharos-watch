import { derivePegRates } from "@shared/lib/peg-rates";
import { PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import type { PegAssetBase } from "@shared/types/core";
import {
  DEX_FRESHNESS_SEC,
  POOL_CHALLENGE_MIN_TVL,
} from "../../lib/constants";
import { throwIfAborted } from "../../lib/abort";
import {
  DEPEG_EVENTS_DEPEGROW_COLUMNS,
  loadDexPoolChallengers,
  loadDexPriceRows,
  loadDexPriceSources,
} from "../../lib/depeg-helpers";
import {
  fetchCurrentNativePegQuotes,
  type NativePegQuoteSession,
} from "../../lib/native-peg-quotes";
import { logWorkerEvent } from "../../lib/structured-log";
import type { DepegDetectionRow, HydratedDepegDetection } from "./types";

/** Bound open-event hydration so one detection pass cannot materialize an unbounded set. */
export const MAX_OPEN_DEPEG_EVENTS = 200;

export async function hydrateDepegDetection(
  db: D1Database,
  assets: PegAssetBase[],
  fxFallbackRates?: Record<string, number>,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
  nativePegSession?: NativePegQuoteSession,
): Promise<HydratedDepegDetection & { openRowsLimitReached: boolean }> {
  const {
    rates: pegRates,
    sources: pegRateSources,
    counts: pegRateCounts,
  } = derivePegRates(assets, PSI_ELIGIBLE_META_BY_ID, fxFallbackRates);
  const syncStart = Math.floor(Date.now() / 1000);
  const now = syncStart;

  throwIfAborted(signal);
  const dexPriceRows = await loadDexPriceRows(db);
  throwIfAborted(signal);
  const dexPriceSources = await loadDexPriceSources(db);
  throwIfAborted(signal);
  const dexPoolChallengers = await loadDexPoolChallengers(db, POOL_CHALLENGE_MIN_TVL, DEX_FRESHNESS_SEC, now);
  throwIfAborted(signal);
  const nativePegQuotes = await fetchCurrentNativePegQuotes(
    assets.map((asset) => {
      const meta = PSI_ELIGIBLE_META_BY_ID.get(asset.id);
      return {
        stablecoinId: asset.id,
        geckoId: meta?.geckoId ?? null,
        pegCurrency: meta?.flags.pegCurrency ?? null,
      };
    }),
    signal,
    coingeckoApiKey,
    undefined,
    nativePegSession,
  );

  throwIfAborted(signal);
  const openResult = await db
    .prepare(`SELECT ${DEPEG_EVENTS_DEPEGROW_COLUMNS}, recovery_last_seen_at FROM depeg_events WHERE ended_at IS NULL LIMIT ?`)
    .bind(MAX_OPEN_DEPEG_EVENTS)
    .all<DepegDetectionRow>();
  const openRows = openResult.results ?? [];
  const openRowsLimitReached = openRows.length >= MAX_OPEN_DEPEG_EVENTS;
  if (openRowsLimitReached) {
    logWorkerEvent({
      scope: "handler",
      level: "warn",
      event: "depeg_open_event_limit_reached",
      message: "Skipped depeg detection because the open-event query reached its limit",
      status: "degraded",
      metadata: { pass: "detection", maxOpenDepegEvents: MAX_OPEN_DEPEG_EVENTS },
    });
  }

  return {
    now,
    syncStart,
    pegRates,
    pegRateSources,
    pegRateCounts,
    dexPriceRows,
    dexPriceSources,
    dexPoolChallengers,
    nativePegQuotes,
    openRows: openRowsLimitReached ? [] : openRows,
    openRowsLimitReached,
  };
}
