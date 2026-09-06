import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { addFreshnessHeaders } from "../../lib/api-freshness-headers";
import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import { logWorkerEventArgs } from "../../lib/structured-log";

/** Enrich the response only; historical detail cache generations stay provider-owned. */
export async function enrichMissingDetailPrice(
  db: D1Database,
  stablecoinId: string,
  response: Response,
): Promise<Response> {
  if (!response.ok) return response;

  try {
    const detail = await response.clone().json() as Record<string, unknown> | null;
    if (!detail || typeof detail !== "object" || Array.isArray(detail)) return response;
    if (typeof detail.price === "number" && Number.isFinite(detail.price) && detail.price > 0) return response;

    // Read the publication, not price_cache: a last-good replay could resurrect
    // a quote that the current pricing pipeline deliberately withheld.
    const canonical = await loadStablecoinsCache(db, { mode: "strict", contract: "published" });
    if (canonical.kind !== "ok") return response;
    const now = Math.floor(Date.now() / 1000);
    const cacheAge = now - canonical.updatedAt;
    if (!Number.isFinite(cacheAge) || canonical.updatedAt <= 0 || cacheAge < 0) return response;

    const coin = canonical.payload.peggedAssets.find((asset) => asset.id === stablecoinId);
    const observedAt = coin?.priceObservedAt ?? coin?.priceUpdatedAt;
    if (
      !coin || coin.frozen ||
      typeof coin.price !== "number" || !Number.isFinite(coin.price) || coin.price <= 0 ||
      !coin.priceSource || coin.priceSource === "cached" ||
      (coin.priceConfidence !== "high" && coin.priceConfidence !== "single-source") ||
      typeof observedAt !== "number" || !Number.isFinite(observedAt) || observedAt <= 0 ||
      observedAt > now
    ) return response;

    const headers = new Headers(response.headers);
    // Detail display follows the current publication, not the stricter observation
    // window for triggering depeg events. Preserve the quote's original timestamp.
    const remaining = Math.max(0, Math.floor(API_FRESHNESS_MAX_AGE_SEC.stablecoins - cacheAge));
    const priceFreshness = addFreshnessHeaders({}, canonical.updatedAt, API_FRESHNESS_MAX_AGE_SEC.stablecoins);
    headers.set("X-Data-Age", String(Math.max(cacheAge, Number(headers.get("X-Data-Age") ?? 0))));
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
    }), { status: response.status, statusText: response.statusText, headers });
  } catch (error) {
    logWorkerEventArgs("api", "warn", `[detail] canonical price unavailable stablecoin=${stablecoinId}`, error);
    return response;
  }
}
