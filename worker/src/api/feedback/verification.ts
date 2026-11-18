import { logWorkerEventArgs } from "../../lib/structured-log";
import { createCurrentPegReader, hasUsableCurrentPrice } from "../../lib/current-peg-observations";
import { projectCurrentPegDeviation } from "@shared/lib/current-peg-projection";
import { DEPEG_PRIMARY_PRICE_MAX_AGE_SEC } from "@shared/lib/depeg-config";
import { relativeBps } from "@shared/lib/depeg-signals";
import { formatCurrency } from "@shared/lib/format";
import { normalizePegType } from "@shared/lib/peg-rates";
import { pegTypeFromCurrency } from "@shared/lib/peg-taxonomy";
import { isReferenceDeviationHeld } from "@shared/lib/reference-market-hours";
import { WORKER_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { currentAdmissionUnavailableReason } from "@shared/lib/reference-admission";
import { ReferenceAdmissionSchema } from "@shared/types/reference-admission";
import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import type { VerificationResult } from "./types";
import { getDepegThresholdBps } from "../../lib/depeg-threshold-policy";

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
    const totalUsd = getCirculatingRawOrNull(coin);
    const now = Math.floor(Date.now() / 1000);
    const cacheAgeSec = now - stablecoinsCache.updatedAt;
    const pegType = normalizePegType(coin.pegType);
    const registryPegType = normalizePegType(pegTypeFromCurrency(meta?.flags.pegCurrency));
    const normalizedPegType = pegType ?? `pegged${meta?.flags.pegCurrency ?? "USD"}`;
    const thresholdBps = getDepegThresholdBps(normalizedPegType);
    const peg = createCurrentPegReader({ ...stablecoinsCache.payload, asOf: stablecoinsCache.updatedAt, now })(coin);
    const admission = ReferenceAdmissionSchema.safeParse(peg?.referenceAdmission).data;
    const quoteObservedAt = coin.priceObservedAt === undefined ? coin.priceUpdatedAt : coin.priceObservedAt;
    const hasQuoteClock = typeof quoteObservedAt === "number" && Number.isSafeInteger(quoteObservedAt)
      && quoteObservedAt > 0 && quoteObservedAt <= now;
    const pegRefEligible = meta != null && !meta.flags.navToken && registryPegType === pegType;
    const fixedUsd = registryPegType === "peggedUSD" && peg?.referenceAdmission == null;
    const pegRef = pegRefEligible && !peg?.pegReferenceUnavailable
      ? fixedUsd ? 1 : peg?.pegReference?.valueUsd
      : null;
    const pegRateSource = fixedUsd ? null : peg?.pegReference?.source;

    const hasPegRef = typeof pegRef === "number" && Number.isFinite(pegRef) && pegRef > 0;
    let deviationBps: number | null = null;
    let inconclusiveReason: string | null = null;
    if (pegRefEligible && hasUsableCurrentPrice(coin) && !peg?.currentPriceUnavailable) {
      const projected = projectCurrentPegDeviation(peg, fixedUsd, coin.priceObservedAt);
      if (fixedUsd && hasPegRef && projected != null) {
        const deviation = peg?.admittedDeviationBps === undefined
          ? relativeBps(coin.price, pegRef)?.rawBps
          : projected;
        if (deviation != null && Number.isFinite(deviation)) deviationBps = deviation;
      } else if (admission?.status === "admitted") {
        inconclusiveReason = currentAdmissionUnavailableReason(admission, meta.flags.pegCurrency,
          coin.priceObservedAtMode === "upstream" ? coin.priceObservedAt : null, now);
        if (!inconclusiveReason && hasPegRef && peg?.pegReference?.source === admission.kind &&
            peg.pegReference.asOf === admission.referenceObservedAtSec) deviationBps = projected;
      } else if (peg?.referenceAdmission === undefined && peg?.admittedDeviationBps === undefined &&
          projected != null && hasPegRef && hasQuoteClock) {
        if (cacheAgeSec < 0 || cacheAgeSec > DEPEG_PRIMARY_PRICE_MAX_AGE_SEC || now - quoteObservedAt > DEPEG_PRIMARY_PRICE_MAX_AGE_SEC) {
          inconclusiveReason = "quote-over-budget";
        } else if (isReferenceDeviationHeld(meta.flags.pegCurrency, quoteObservedAt, projected) ||
            isReferenceDeviationHeld(meta.flags.pegCurrency, now, projected)) {
          inconclusiveReason = "reference-market-closed";
        } else {
          deviationBps = projected;
        }
      } else {
        inconclusiveReason = admission?.reason ?? "reference-admission-unavailable";
      }
    }

    if (deviationBps == null) inconclusiveReason ??= hasUsableCurrentPrice(coin) ? "eligible-deviation-unavailable" : "price-unavailable";
    const confirmed = deviationBps != null && Math.abs(deviationBps) >= thresholdBps;
    const verifiedLabel = inconclusiveReason ? "verified: pending" : confirmed ? "verified: confirmed" : "verified: unconfirmed";
    const verificationSummary = inconclusiveReason
      ? `Inconclusive: ${inconclusiveReason}`
      : confirmed ? "\u26A0\uFE0F Confirmed" : "\u2705 Unconfirmed";
    const deviationStr = deviationBps == null ? "N/A" : `${deviationBps >= 0 ? "+" : ""}${(deviationBps / 100).toFixed(3)}%`;
    const block = [
      "**--- Auto-Verification Snapshot (at time of submission) ---**",
      price != null ? `**Cached price:** $${price.toFixed(6)}` : "**Cached price:** N/A",
      `**USD circulating market cap:** ${totalUsd === null ? "N/A (supply unavailable)" : formatCurrency(totalUsd)}`,
      `**Peg deviation:** ${deviationStr}`,
      `**Peg reference:** ${hasPegRef ? `$${pegRef.toFixed(6)}` : "N/A"}${hasPegRef && pegRateSource ? ` (${pegRateSource === "fx" ? "FX" : pegRateSource})` : ""}`,
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
