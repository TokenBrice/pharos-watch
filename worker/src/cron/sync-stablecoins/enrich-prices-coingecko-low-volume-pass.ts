import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { fetchCoingeckoSimplePrices } from "../../lib/coingecko-simple-price";
import { recordOutcomeSafe, shouldAttemptFetch } from "../../lib/circuit-breaker";
import { isSuccessfulOutcome } from "../../lib/fetcher-result";
import {
  applyResolvedPrice,
  hasMissingPrice,
  type PeggedAsset,
} from "./enrich-prices-shared";
import {
  type EnrichPassResult,
  isFreshFallbackObservedAt,
  isUsableFallbackPrice,
} from "./enrich-prices-pass-common";

const COINGECKO_LOW_VOLUME_SOURCE = "coingecko-low-volume";

// Explicitly scoped to assets identified by reviewed missing-price audits,
// including CG-only rows whose fresh price outlives supplemental supply admission.
// This avoids turning every stale CoinGecko row into a fallback price.
// Membership is guarded by enrich-prices-coingecko-low-volume-pass.test.ts, which
// fails if any ID here is no longer present in the active registry (ACTIVE_META_BY_ID).
export const LOW_VOLUME_CG_FALLBACK_IDS = new Set([
  "deuro-deuro",
  "usdn-smardex",
  "cadm-mento",
  "tryb-bilira",
  "btcusd-btcfi",
  "dllr-sovryn",
  "gbpm-mento",
  "audm-mento",
  "copm-mento",
  "chfm-mento",
  "hchf-hedera-swiss-franc",
  // 2026-09-28 missing-price audit: DefiLlama dropped MONEY's list price and
  // coins entries (second episode in two days) and it has no DEX, CMC or CEX lane.
  "money-defi-money",
  // 2026-09-30: HBD's low-volume quote remains inside the existing seven-day
  // budget, but CG-only intake rejects its stale market cap and carries supply.
  "hbd-hive",
  // 2026-10-06: observed CG quotes remain within the seven-day budget,
  // while strict primary freshness rejects these low-volume tickers.
  "usdkg-gold-dollar",
  "fusd-freedom-dollar",
  "chfau-allunity",
]);

export async function runCoingeckoLowVolumePass(
  assets: PeggedAsset[],
  coingeckoApiKey: string | null | undefined,
  fxRates: Record<string, number> | undefined,
  db?: D1Database,
  signal?: AbortSignal,
): Promise<EnrichPassResult> {
  let resolved = 0;
  const failures: string[] = [];

  const candidates = assets
    .map((asset, index) => ({ asset, index }))
    .filter(({ asset }) => {
      if (!hasMissingPrice(asset)) return false;
      if (!LOW_VOLUME_CG_FALLBACK_IDS.has(asset.id)) return false;
      const meta = ACTIVE_META_BY_ID.get(asset.id);
      return typeof meta?.geckoId === "string" && meta.geckoId.length > 0;
    });

  if (candidates.length === 0) {
    return { resolved, failures };
  }

  if (db && !(await shouldAttemptFetch(db, CIRCUIT_SOURCE.CG_PRICES))) {
    return { resolved, failures };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const geckoIds = [...new Set(candidates.map(({ asset }) => ACTIVE_META_BY_ID.get(asset.id)!.geckoId!))];
  const outcome = await fetchCoingeckoSimplePrices(
    geckoIds,
    coingeckoApiKey ?? null,
    signal,
    nowSec,
    { sourceKey: COINGECKO_LOW_VOLUME_SOURCE },
  );

  if (db) {
    await recordOutcomeSafe(db, CIRCUIT_SOURCE.CG_PRICES, isSuccessfulOutcome(outcome));
  }
  if (outcome.kind === "upstream-error") {
    failures.push(COINGECKO_LOW_VOLUME_SOURCE);
  }

  for (const { asset, index } of candidates) {
    const geckoId = ACTIVE_META_BY_ID.get(asset.id)?.geckoId;
    const quote = geckoId ? outcome.value.get(geckoId) : undefined;
    if (!quote) continue;
    if (!isUsableFallbackPrice(asset, quote.price, fxRates)) continue;
    if (quote.observedAt != null && (
      quote.observedAt <= 0 ||
      !isFreshFallbackObservedAt(
        quote.observedAt,
        getPricingSourceRegistryEntry(COINGECKO_LOW_VOLUME_SOURCE)!.maxTrustedAgeSec!,
        nowSec,
      )
    )) continue;

    applyResolvedPrice(
      assets[index],
      quote.price,
      COINGECKO_LOW_VOLUME_SOURCE,
      "fallback",
      quote.observedAt ?? nowSec,
      quote.observedAtMode ?? "local_fetch",
    );
    resolved++;
  }

  return { resolved, failures };
}
