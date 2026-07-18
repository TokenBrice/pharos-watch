import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
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
  isUsableFallbackPrice,
} from "./enrich-prices-pass-common";

const COINGECKO_LOW_VOLUME_SOURCE = "coingecko-low-volume";

// Explicitly scoped to DL-listed assets identified by reviewed missing-price
// audits. This avoids turning every stale CoinGecko row into a fallback price.
// Membership is guarded by enrich-prices-coingecko-low-volume-pass.test.ts, which
// fails if any ID here is no longer present in the active registry (ACTIVE_META_BY_ID).
export const LOW_VOLUME_CG_FALLBACK_IDS = new Set([
  "deuro-deuro",
  "usdn-smardex",
  "cadm-mento",
  "tryb-bilira",
  "btcusd-btcfi",
  "dllr-sovryn",
  "ebusd-ebisu",
  "gbpm-mento",
  "audm-mento",
  "copm-mento",
  "chfm-mento",
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
