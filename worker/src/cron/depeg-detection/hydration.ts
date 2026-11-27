import type { FxRateState } from "../../lib/fx-rate-state";
import {
  DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC,
  DEX_PROTOCOL_SOURCE_FRESHNESS_SEC,
  DEX_FRESHNESS_SEC,
} from "@shared/lib/depeg-config";
import { PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import type { PegAssetBase } from "@shared/types/price";
import { MAX_OPEN_DEPEG_EVENTS } from "../../lib/depeg-threshold-policy";
import { POOL_CHALLENGE_MIN_TVL } from "../../lib/price-depeg-voting-policy";
import { throwIfAborted } from "../../lib/abort";
import { toErrorMessage } from "@shared/lib/error-utils";
import {
  loadDexPoolChallengers,
  loadDexPrices,
  logOpenDepegEventLimitReached,
} from "../../lib/depeg-helpers";
import { logWorkerEventArgs } from "../../lib/structured-log";
import {
  fetchCurrentNativePegQuotes,
  type NativePegQuoteSession,
} from "../../lib/native-peg-quotes";
import type { DepegDetectionRow, HydratedDepegDetection } from "./types";
import {
  applyHydratedEscalationMetadata,
  OPEN_DEPEG_EVENTS_BASE_SELECT,
  OPEN_DEPEG_EVENTS_HYDRATION_SELECT,
  type HydratedOpenEventRawRow,
} from "./escalation";
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
  let rawOpenRows: HydratedOpenEventRawRow[];
  let usedBaseFallback = false;
  try {
    const openResult = await db
      .prepare(OPEN_DEPEG_EVENTS_HYDRATION_SELECT)
      .bind(DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC, DDR_INCIDENT_REOPEN_MERGE_WINDOW_SEC, MAX_OPEN_DEPEG_EVENTS)
      .all<HydratedOpenEventRawRow>();
    rawOpenRows = openResult.results ?? [];
  } catch (err) {
    // Any auxiliary metadata failure (missing table, malformed JSON/BLOB in DDR tables)
    // falls back to the base open-event query without marking onset as canonically hydrated,
    // so display-only escalation metadata never aborts detection or wipes carried state.
    if (toErrorMessage(err).toLowerCase().includes("depeg_events")) throw err;
    logWorkerEventArgs(
      "handler",
      "warn",
      "[depeg-hydration] Enriched open-event metadata read failed; falling back to base open-event query:",
      toErrorMessage(err),
    );
    usedBaseFallback = true;
    const fallbackResult = await db
      .prepare(OPEN_DEPEG_EVENTS_BASE_SELECT)
      .bind(MAX_OPEN_DEPEG_EVENTS)
      .all<DepegDetectionRow>();
    rawOpenRows = fallbackResult.results ?? [];
  }
  const openRows = usedBaseFallback
    ? rawOpenRows.map((row) => ({ ...row, escalation_metadata_hydrated: false }))
    : rawOpenRows.map(applyHydratedEscalationMetadata);
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
