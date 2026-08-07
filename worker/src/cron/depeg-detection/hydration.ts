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
  type DepegRow,
} from "../../lib/depeg-helpers";
import {
  fetchCurrentNativePegQuotes,
  type NativePegQuoteSession,
} from "../../lib/native-peg-quotes";
import type { HydratedDepegDetection } from "./types";

export async function hydrateDepegDetection(
  db: D1Database,
  assets: PegAssetBase[],
  fxFallbackRates?: Record<string, number>,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
  nativePegSession?: NativePegQuoteSession,
): Promise<HydratedDepegDetection> {
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
    .prepare(`SELECT ${DEPEG_EVENTS_DEPEGROW_COLUMNS} FROM depeg_events WHERE ended_at IS NULL`)
    .all<DepegRow>();

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
    openRows: openResult.results ?? [],
  };
}
