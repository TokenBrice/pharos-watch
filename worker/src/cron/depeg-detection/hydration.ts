import type { FxRateState } from "../../lib/fx-rate-state";
import { DEX_PROTOCOL_SOURCE_FRESHNESS_SEC, DEX_FRESHNESS_SEC } from "@shared/lib/depeg-config";
import { PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import type { PegAssetBase } from "@shared/types/price";
import { MAX_OPEN_DEPEG_EVENTS } from "../../lib/depeg-threshold-policy";
import { POOL_CHALLENGE_MIN_TVL } from "../../lib/price-depeg-voting-policy";
import { throwIfAborted } from "../../lib/abort";
import {
  loadDexPoolChallengers,
  loadDexPrices,
  logOpenDepegEventLimitReached,
} from "../../lib/depeg-helpers";
import {
  fetchCurrentNativePegQuotes,
  type NativePegQuoteSession,
} from "../../lib/native-peg-quotes";
import type { DepegDetectionRow, HydratedDepegDetection } from "./types";
import { deriveDetectionPegRates } from "./reference-policy";
import { persistActiveNativeEventQuotes } from "../../lib/native-peg-quote-cache";

export async function hydrateDepegDetection(
  db: D1Database,
  assets: PegAssetBase[],
  fxFallbackRates?: Record<string, number>,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
  nativePegSession?: NativePegQuoteSession,
  detectionFxState?: FxRateState | null,
): Promise<HydratedDepegDetection & { openRowsLimitReached: boolean }> {
  const syncStart = Math.floor(Date.now() / 1000);
  const now = syncStart;

  throwIfAborted(signal);
  const { dexPriceRows, dexPriceSources } = await loadDexPrices(db, now, DEX_PROTOCOL_SOURCE_FRESHNESS_SEC);
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
    .prepare(`SELECT open_event.*, COALESCE(provenance.quote_mode,
      CASE WHEN open_event.source = 'live' AND open_event.pending_reason IS NOT NULL
        THEN CASE WHEN instr('+' || open_event.pending_reason || '+', '+native-origin+') > 0 THEN 'native-peg' ELSE 'usd' END
      END) AS quote_mode
      FROM (
        SELECT * FROM depeg_events WHERE ended_at IS NULL LIMIT ?
      ) AS open_event
      LEFT JOIN depeg_event_provenance AS provenance ON provenance.event_id = open_event.id`)
    .bind(MAX_OPEN_DEPEG_EVENTS)
    .all<DepegDetectionRow>();
  const openRows = openResult.results ?? [];
  const openRowsLimitReached = openRows.length >= MAX_OPEN_DEPEG_EVENTS;
  if (openRowsLimitReached) {
    logOpenDepegEventLimitReached("detection");
  }
  if (!openRowsLimitReached) {
    await persistActiveNativeEventQuotes(db, nativePegQuotes, signal);
  }

  throwIfAborted(signal);
  const { rates: pegRates, sources: pegRateSources, counts: pegRateCounts, referenceContext } = await deriveDetectionPegRates(
    db, openRowsLimitReached ? [] : assets, PSI_ELIGIBLE_META_BY_ID,
    new Set(openRows.map((row) => row.stablecoin_id)), fxFallbackRates, detectionFxState, now,
  );

  return {
    now,
    syncStart,
    pegRates,
    pegRateSources,
    pegRateCounts,
    referenceContext,
    dexPriceRows,
    dexPriceSources,
    dexPoolChallengers,
    nativePegQuotes,
    openRows: openRowsLimitReached ? [] : openRows,
    openRowsLimitReached,
  };
}
