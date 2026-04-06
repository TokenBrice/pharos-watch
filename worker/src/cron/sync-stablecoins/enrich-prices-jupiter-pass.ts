import {
  CIRCUIT_SOURCE,
  USER_AGENT,
} from "../../lib/constants";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { cancelResponseBodyQuietly } from "../../lib/response-body";
import { shouldAttemptFetch, recordOutcomeSafe } from "../../lib/circuit-breaker";
import {
  buildPriceReasonablenessOptions,
  isReasonablePrice,
} from "../../lib/price-validation";
import {
  applyResolvedPrice,
  hasMissingPrice,
  type PeggedAsset,
} from "./enrich-prices-shared";
import {
  type EnrichPassResult,
  SOLANA_MINT_BY_ID,
} from "./enrich-prices-pass-common";

const JUPITER_PRICE_API = "https://lite-api.jup.ag/price/v3";
const JUPITER_MAX_IDS_PER_REQUEST = 50;
const JUPITER_REQUEST_TIMEOUT_MS = 5_000;
const JUPITER_MAX_RETRIES = 0;
const JUPITER_MIN_LIQUIDITY_USD = 50_000;

interface JupiterPriceEntry {
  usdPrice?: number;
  liquidity?: number;
  createdAt?: string | number;
}

export async function runJupiterPass(
  assets: PeggedAsset[],
  fxRates: Record<string, number> | undefined,
  db: D1Database | undefined,
  signal?: AbortSignal,
): Promise<EnrichPassResult> {
  let resolved = 0;
  const candidates = assets.flatMap((asset, index) => {
    const mint = SOLANA_MINT_BY_ID.get(asset.id);
    return hasMissingPrice(asset) && mint ? [{ asset, index, mint }] : [];
  });
  if (candidates.length === 0) {
    return { resolved, failures: [] };
  }

  const jupiterAllowed = db != null ? await shouldAttemptFetch(db, CIRCUIT_SOURCE.JUPITER_PRICES) : true;
  if (!jupiterAllowed) {
    console.warn("[enrich] Jupiter circuit open — skipping pass 3");
    return { resolved, failures: [] };
  }

  let successfulCalls = 0;
  for (let index = 0; index < candidates.length; index += JUPITER_MAX_IDS_PER_REQUEST) {
    const batch = candidates.slice(index, index + JUPITER_MAX_IDS_PER_REQUEST);
    const ids = batch.map((entry) => entry.mint);

    const res = await fetchWithRetry(
      `${JUPITER_PRICE_API}?ids=${encodeURIComponent(ids.join(","))}`,
      { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal },
      JUPITER_MAX_RETRIES,
      { timeoutMs: JUPITER_REQUEST_TIMEOUT_MS },
    );
    if (!res?.ok) {
      await cancelResponseBodyQuietly(res);
      console.warn(`[enrich] Jupiter returned ${res?.status ?? "no response"} for batch of ${ids.length}`);
      continue;
    }

    successfulCalls += 1;
    const data = (await res.json()) as Record<string, JupiterPriceEntry>;
    for (const entry of batch) {
      const payload = data[entry.mint];
      const usdPrice = payload?.usdPrice;
      const liquidity = payload?.liquidity;
      if (usdPrice == null || !Number.isFinite(usdPrice) || usdPrice <= 0) continue;
      if (liquidity == null || !Number.isFinite(liquidity) || liquidity < JUPITER_MIN_LIQUIDITY_USD) continue;

      if (!isReasonablePrice(
        usdPrice,
        entry.asset.pegType as string | undefined,
        fxRates,
        buildPriceReasonablenessOptions(entry.asset),
      )) {
        continue;
      }

      applyResolvedPrice(assets[entry.index], usdPrice, "jupiter", "fallback");
      resolved += 1;
    }
  }

  if (db) {
    await recordOutcomeSafe(db, CIRCUIT_SOURCE.JUPITER_PRICES, successfulCalls > 0);
  }

  return { resolved, failures: [] };
}
