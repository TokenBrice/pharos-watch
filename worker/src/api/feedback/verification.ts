import { logWorkerEventArgs } from "../../lib/structured-log";
import { relativeBps } from "@shared/lib/depeg-signals";
import { formatCurrency } from "@shared/lib/format";
import { derivePegRates, getPegReference, normalizePegType } from "@shared/lib/peg-rates";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { getCirculatingRaw } from "@shared/lib/supply";
import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import type { VerificationResult } from "./types";
import { getDepegThresholdBps } from "../../lib/constants";

export async function verifyDataCorrection(
  db: D1Database,
  stablecoinId: string,
): Promise<VerificationResult> {
  try {
    const stablecoinsCache = await loadStablecoinsCache(db, { mode: "strict" });
    if (stablecoinsCache.kind !== "ok") {
      throw new Error(`stablecoins cache ${stablecoinsCache.reason}`);
    }

    const coin = stablecoinsCache.payload.peggedAssets.find((asset) => asset.id === stablecoinId);
    if (!coin) throw new Error(`coin ${stablecoinId} not found in cache`);

    const meta = TRACKED_META_BY_ID.get(stablecoinId);
    const price = coin.price ?? null;
    const totalUsd = getCirculatingRaw(coin);
    const cacheAgeSec = Math.floor(Date.now() / 1000) - stablecoinsCache.updatedAt;
    const pegRates = derivePegRates(
      stablecoinsCache.payload.peggedAssets,
      TRACKED_META_BY_ID,
      stablecoinsCache.payload.fxFallbackRates,
    );
    const pegRef = getPegReference(coin.pegType, pegRates.rates, meta?.commodityOunces);
    const normalizedPegType = normalizePegType(coin.pegType) ?? `pegged${meta?.flags.pegCurrency ?? "USD"}`;
    const thresholdBps = getDepegThresholdBps(normalizedPegType);
    const pegRateSource = pegRates.sources[normalizedPegType] ?? null;

    let deviationStr = "N/A";
    let verifiedLabel: VerificationResult["verifiedLabel"] = "verified: unconfirmed";

    if (price != null && price > 0 && pegRef != null) {
      const deviation = relativeBps(price, pegRef);
      if (deviation != null) {
        const deviationPct = deviation.rawBps / 100;
        deviationStr = `${deviation.rawBps >= 0 ? "+" : ""}${deviationPct.toFixed(3)}%`;
        if (deviation.absRawBps >= thresholdBps) verifiedLabel = "verified: confirmed";
      }
    }

    const verificationSummary = verifiedLabel === "verified: confirmed" ? "⚠️ Confirmed" : "✅ Unconfirmed";
    const block = [
      "**--- Auto-Verification Snapshot (at time of submission) ---**",
      price != null ? `**Cached price:** $${price.toFixed(6)}` : "**Cached price:** N/A",
      totalUsd > 0 ? `**USD circulating market cap:** ${formatCurrency(totalUsd)}` : "",
      `**Peg deviation:** ${deviationStr}`,
      `**Peg reference:** ${pegRef != null ? `$${pegRef.toFixed(6)}` : "N/A"}${pegRateSource ? ` (${pegRateSource === "fx" ? "FX" : pegRateSource})` : ""}`,
      `**Depeg threshold:** ${thresholdBps} bps`,
      `**Cache age:** ${cacheAgeSec}s`,
      `**Verification result:** ${verificationSummary}`,
    ]
      .filter(Boolean)
      .join("\n");

    return { block, verifiedLabel };
  } catch (err) {
    logWorkerEventArgs("api", "warn", "[feedback] Auto-verification failed:", err);
    return {
      block: "**Verification:** pending (cache unavailable at submission time)",
      verifiedLabel: "verified: pending",
    };
  }
}
