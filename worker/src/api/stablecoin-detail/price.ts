import { LEGACY_SOLOMON_USDV_ID, isSolomonPriceIdentityAllowed } from "../../lib/solomon-usdv-identity";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { admitSupplyBuckets } from "@shared/lib/supply";
import { parseDetailSnapshotSourceClock } from "@shared/lib/detail-snapshot-inputs";
import { addFreshnessHeaders } from "../../lib/api-freshness-headers";
import { loadStablecoinsCache, type StablecoinsCacheLoadResult } from "../../lib/stablecoins-cache";
import { logWorkerEventArgs } from "../../lib/structured-log";

/** Enrich the response only; historical detail cache generations stay provider-owned. */
export async function enrichMissingDetailPrice(
  db: D1Database,
  stablecoinId: string,
  response: Response,
  publication?: StablecoinsCacheLoadResult,
): Promise<Response> {
  if (!response.ok) return response;

  try {
    const detail = await response.clone().json() as Record<string, unknown> | null;
    if (!detail || typeof detail !== "object" || Array.isArray(detail)) return response;
    // Only the admitted canonical publication can set restoration provenance.
    if ("currentSupplyRestored" in detail) {
      delete detail.currentSupplyRestored;
      const headers = new Headers(response.headers);
      headers.delete("Content-Length");
      response = new Response(JSON.stringify(detail), { status: response.status, statusText: response.statusText, headers });
    }
    if (stablecoinId === LEGACY_SOLOMON_USDV_ID) {
      delete detail.price;
      delete detail.gecko_id;
      delete detail.geckoId;
      const headers = new Headers(response.headers);
      headers.delete("Content-Length");
      response = new Response(JSON.stringify(detail), { status: response.status, statusText: response.statusText, headers });
    }
    if (!isObservedPrice({
      priceSource: typeof detail.priceSource === "string" ? detail.priceSource : null,
      priceObservedAtMode: typeof detail.priceObservedAtMode === "string" ? detail.priceObservedAtMode : null,
    })) {
      detail.price = null;
      detail.priceConfidence = null;
      detail.priceObservedAt = null;
      const headers = new Headers(response.headers);
      headers.delete("Content-Length");
      response = new Response(JSON.stringify(detail), { status: response.status, statusText: response.statusText, headers });
    }
    const hasDetailPrice = typeof detail.price === "number" && Number.isFinite(detail.price) && detail.price > 0;

    // Read the publication, not price_cache: a last-good replay could resurrect
    // a quote that the current pricing pipeline deliberately withheld.
    const canonical = publication ?? await loadStablecoinsCache(db, { mode: "strict", contract: "published" });
    if (canonical.kind !== "ok") return response;
    const now = Math.floor(Date.now() / 1000);
    const cacheAge = now - canonical.updatedAt;
    if (!Number.isFinite(cacheAge) || canonical.updatedAt <= 0 || cacheAge < 0) return response;

    const coin = canonical.payload.peggedAssets.find((asset) => asset.id === stablecoinId);
    // Reuse the already-read publication: current USD supply must match the list,
    // even when a provider's daily history is older or its own price is unavailable.
    const hasCurrentSupply = coin != null && !coin.frozen && stablecoinId !== LEGACY_SOLOMON_USDV_ID &&
      admitSupplyBuckets(coin.circulating).status === "observed";
    if (hasCurrentSupply) {
      detail.currentCirculatingUSD = coin.circulating;
      detail.currentSupplyRestored = coin.supplyRestored === true;
      detail.currentCirculatingPrevDayUSD = admitSupplyBuckets(coin.circulatingPrevDay).status === "observed"
        ? coin.circulatingPrevDay : {};
      const supplyObservedAt = coin.supplyObservedAt;
      detail.currentSupplyObservedAt = typeof supplyObservedAt === "number" && Number.isFinite(supplyObservedAt) &&
        supplyObservedAt > 0 && supplyObservedAt <= now ? supplyObservedAt : canonical.updatedAt;
    }
    if (coin?.nominalPriceReference) detail.nominalPriceReference = coin.nominalPriceReference;
    const observedAt = coin?.priceObservedAt ?? coin?.priceUpdatedAt;
    const canEnrichPrice = !hasDetailPrice && coin != null && !coin.frozen && isObservedPrice(coin) &&
      isSolomonPriceIdentityAllowed(stablecoinId, coin.priceSource, coin.agreeSources) &&
      typeof coin.price === "number" && Number.isFinite(coin.price) && coin.price > 0 &&
      !!coin.priceSource && coin.priceSource !== "cached" &&
      (coin.priceConfidence === "high" || coin.priceConfidence === "single-source") &&
      typeof observedAt === "number" && Number.isFinite(observedAt) && observedAt > 0 && observedAt <= now;
    if (!hasCurrentSupply && !coin?.nominalPriceReference && !canEnrichPrice) return response;

    const headers = new Headers(response.headers);
    // Detail display follows the current publication, not the stricter observation
    // window for triggering depeg events. Preserve the quote's original timestamp.
    const remaining = Math.max(0, Math.floor(API_FRESHNESS_MAX_AGE_SEC.stablecoins - cacheAge));
    const priceFreshness = addFreshnessHeaders({}, canonical.updatedAt, API_FRESHNESS_MAX_AGE_SEC.stablecoins);
    headers.set("X-Data-Age", String(Math.max(cacheAge, Number(headers.get("X-Data-Age") ?? 0))));
    const detailUpdatedAt = headers.get("X-Data-Updated-At");
    const detailSourceClock = detailUpdatedAt === null ? null : parseDetailSnapshotSourceClock(detailUpdatedAt);
    if (detailSourceClock !== null) {
      headers.set("X-Data-Updated-At", String(Math.min(canonical.updatedAt, detailSourceClock)));
    }
    if (priceFreshness.Warning) headers.append("Warning", priceFreshness.Warning);
    if (priceFreshness["Cache-Control"] === "no-store") headers.set("Cache-Control", "no-store");
    // Bound both browser and edge reuse without clearing stale-history warnings
    // or replacing a no-store policy with a fresh cache policy.
    const cacheControl = headers.get("Cache-Control");
    if (cacheControl) {
      headers.set("Cache-Control", cacheControl.replace(
        /\b(s-maxage|max-age)=(\d+)/g,
        (_, directive: string, seconds: string) => `${directive}=${Math.min(Number(seconds), remaining)}`,
      ));
    }
    headers.delete("Content-Length");
    return new Response(JSON.stringify({
      ...detail,
      ...(canEnrichPrice && coin ? {
        price: coin.price,
        priceSource: coin.priceSource,
        priceConfidence: coin.priceConfidence,
        priceUpdatedAt: coin.priceUpdatedAt,
        priceObservedAt: observedAt,
        priceObservedAtMode: coin.priceObservedAtMode,
        priceSyncedAt: coin.priceSyncedAt,
        consensusSources: coin.consensusSources,
        agreeSources: coin.agreeSources,
        priceSourceConfidenceProfile: coin.priceSourceConfidenceProfile,
      } : {}),
    }), { status: response.status, statusText: response.statusText, headers });
  } catch (error) {
    logWorkerEventArgs("api", "warn", `[detail] canonical price unavailable stablecoin=${stablecoinId}`, error);
    return response;
  }
}
