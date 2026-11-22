import { LEGACY_SOLOMON_USDV_ID, isSolomonPriceIdentityAllowed } from "../../lib/solomon-usdv-identity";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { isKinesisWrapperSupplyCutoverActive } from "@shared/lib/supply-perimeter-changes";
import { isKinesisWrapperSupplyId, prefersOnChainSupplyMcap } from "@shared/lib/onchain-supply-probe";
import { admitSupplyBuckets, getUsdMarketCapBaselineOrNull, projectUsdMarketCapBaselineBuckets, type SupplyChangeBaselines } from "@shared/lib/supply";
import { parseDetailSnapshotSourceClock } from "@shared/lib/detail-snapshot-inputs";
import { addFreshnessHeaders } from "../../lib/api-freshness-headers";
import { loadStablecoinsCache, type StablecoinsCacheLoadResult } from "../../lib/stablecoins-cache";
import { hasUsableCurrentPrice } from "../../lib/current-peg-observations";
import { logWorkerEventArgs } from "../../lib/structured-log";
import { applyWrapperDetailHistoryFreshness, createWrapperDetailUnavailableResponse, hasCurrentCommodityHistory } from "./shared";

/** Enrich the response only; historical detail cache generations stay provider-owned. */
export async function overlayCanonicalDetail(
  db: D1Database,
  stablecoinId: string,
  response: Response,
  publication?: StablecoinsCacheLoadResult,
): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const wrapper = isKinesisWrapperSupplyCutoverActive(stablecoinId, now);
  if (!response.ok && !(wrapper && response.status === 503)) return response;

  try {
    let detail = response.ok ? await response.clone().json() as Record<string, unknown> | null : { tokens: [] };
    if (!detail || typeof detail !== "object" || Array.isArray(detail)) return response;
    const currentHistory = hasCurrentCommodityHistory(stablecoinId, detail);
    let hasWrapperHistory = false;
    if (!currentHistory || wrapper) {
      const headers = new Headers(response.headers);
      headers.delete("Content-Length");
      hasWrapperHistory = wrapper && currentHistory && applyWrapperDetailHistoryFreshness(detail, headers, now);
      if (wrapper && !hasWrapperHistory) {
        detail = { tokens: [] };
        response = createWrapperDetailUnavailableResponse();
      } else {
        if (!currentHistory) {
          detail = { tokens: [] };
          headers.delete("X-Data-Updated-At");
          headers.delete("X-Data-Age");
          headers.set("Cache-Control", "no-store");
        }
        response = new Response(JSON.stringify(detail), { status: response.status, statusText: response.statusText, headers });
      }
    }
    // Only the admitted publication can set canonical checkpoints and provenance.
    if ("currentSupplyRestored" in detail || "currentSupplyUnavailableReason" in detail || "currentSupplyExcludedChains" in detail
      || "currentSupplyComparisonExcludedChains" in detail
      || "currentCirculatingPrevWeekUSD" in detail || "currentCirculatingPrevMonthUSD" in detail
      || "currentCirculatingNative" in detail || "supplyChangeBaselines" in detail || "priceDerivation" in detail || "nominalPriceReference" in detail || "currentPeg" in detail) {
      delete detail.currentPeg;
      delete detail.priceDerivation;
      delete detail.nominalPriceReference;
      delete detail.currentSupplyRestored;
      delete detail.currentSupplyUnavailableReason;
      delete detail.currentSupplyExcludedChains;
      delete detail.currentSupplyComparisonExcludedChains;
      delete detail.currentCirculatingNative;
      delete detail.currentCirculatingPrevWeekUSD;
      delete detail.currentCirculatingPrevMonthUSD;
      delete detail.supplyChangeBaselines;
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
    if (response.ok && !isObservedPrice({
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
    // Read the publication, not price_cache: a last-good replay could resurrect
    // a quote that the current pricing pipeline deliberately withheld.
    const canonical = publication ?? await loadStablecoinsCache(db, { mode: "strict", contract: "published" });
    if (canonical.kind !== "ok") return response;
    const cacheAge = now - canonical.updatedAt;
    if (!Number.isFinite(cacheAge) || canonical.updatedAt <= 0 || cacheAge < 0) return response;

    const coin = canonical.payload.peggedAssets.find((asset) => asset.id === stablecoinId);
    // Reuse the already-read publication: current USD supply must match the list,
    // even when a provider's daily history is older or its own price is unavailable.
    const wrapperSupplyClock = coin?.supplyObservedAt;
    const wrapperSupplyUnverified = (isKinesisWrapperSupplyId(stablecoinId) && wrapper !== (coin?.supplySource === "onchain-total-supply")) || (wrapper && (
      typeof wrapperSupplyClock !== "number" || !Number.isSafeInteger(wrapperSupplyClock) ||
      wrapperSupplyClock <= 0 || wrapperSupplyClock > now || now - wrapperSupplyClock > API_FRESHNESS_MAX_AGE_SEC.stablecoins));
    const hasCurrentSupply = coin != null && !coin.frozen && !wrapperSupplyUnverified && stablecoinId !== LEGACY_SOLOMON_USDV_ID &&
      !coin.supplyUnavailableReason && admitSupplyBuckets(coin.circulating).status === "observed";
    if (hasCurrentSupply) {
      detail.currentCirculatingUSD = coin.circulating;
      if (coin.circulatingNative !== undefined) detail.currentCirculatingNative = coin.circulatingNative;
      detail.currentSupplyRestored = coin.supplyRestored === true;
      if (coin.supplyChainGuard?.partialCoverage === true) {
        detail.currentSupplyExcludedChains = coin.supplyChainGuard.chains
          .filter((chain) => chain.resolution === "unavailable").map((chain) => chain.chainLabel);
      }
      const matchedPerimeter = coin.supplyChainGuard?.partialCoverage !== true && coin.supplyChainGuard?.matchedComparisonWindows != null;
      if (matchedPerimeter) detail.currentSupplyComparisonExcludedChains = coin.supplyChainGuard!.chains.map((chain) => chain.chainLabel);
      const historicalBuckets = (window: keyof SupplyChangeBaselines, previous: Record<string, number>) =>
        getUsdMarketCapBaselineOrNull(coin, window) == null ? {} : projectUsdMarketCapBaselineBuckets(coin, window, previous);
      if (coin.supplyChangeBaselines !== undefined) detail.supplyChangeBaselines = coin.supplyChangeBaselines;
      detail.currentCirculatingPrevDayUSD = historicalBuckets("day", coin.circulatingPrevDay);
      // Provider history can carry a different valuation from the admitted non-USD close, and still counts
      // the chains a matched comparison perimeter excludes (Pricing v6.90).
      if (coin.pegType !== "peggedUSD" || matchedPerimeter) {
        detail.currentCirculatingPrevWeekUSD = historicalBuckets("week", coin.circulatingPrevWeek);
        detail.currentCirculatingPrevMonthUSD = historicalBuckets("month", coin.circulatingPrevMonth);
      }
      const supplyObservedAt = coin.supplyObservedAt;
      detail.currentSupplyObservedAt = typeof supplyObservedAt === "number" && Number.isFinite(supplyObservedAt) &&
        supplyObservedAt > 0 && supplyObservedAt <= now ? supplyObservedAt : canonical.updatedAt;
    }
    // A canonical producer refusal must not be resurrected from provider history.
    const supplyUnavailableReason = coin?.supplyUnavailableReason
      ?? (coin?.supplyChainGuard?.status === "unavailable" ? coin.supplyChainGuard.reason : undefined);
    const preferredSupplyUnavailable = coin != null && prefersOnChainSupplyMcap(coin) &&
      coin.supplySource === "onchain-supply-withheld" && admitSupplyBuckets(coin.circulating).status !== "observed";
    const supplyUnavailable = coin != null && !coin.frozen && stablecoinId !== LEGACY_SOLOMON_USDV_ID &&
      !hasCurrentSupply && (supplyUnavailableReason != null || preferredSupplyUnavailable || wrapperSupplyUnverified);
    if (supplyUnavailable) {
      detail.currentCirculatingNative = null;
      detail.currentSupplyUnavailableReason = supplyUnavailableReason;
      if (supplyUnavailableReason == null) detail.currentCirculatingUSD = {};
      else delete detail.currentCirculatingUSD;
      delete detail.currentCirculatingPrevDayUSD;
      delete detail.currentSupplyObservedAt;
      delete detail.currentSupplyRestored;
    }
    if (coin?.nominalPriceReference) detail.nominalPriceReference = coin.nominalPriceReference;
    const observedAt = coin?.priceObservedAt === undefined ? coin?.priceUpdatedAt : coin.priceObservedAt;
    // A new publication carries unavailable/nominal observations too, so provider
    // fallback cannot put a different quote beside its current peg fields.
    const canEnrichPrice = coin != null && !coin.frozen && (coin.currentPeg != null || hasUsableCurrentPrice(coin)) &&
      isSolomonPriceIdentityAllowed(stablecoinId, coin.priceSource, coin.agreeSources);
    if (!hasCurrentSupply && !supplyUnavailable && !coin?.nominalPriceReference && !canEnrichPrice) return response;
    const wrapperCurrentOnly = wrapper && !hasWrapperHistory;
    if (wrapperCurrentOnly) {
      const currentPrice = canEnrichPrice && coin != null && hasUsableCurrentPrice(coin) && typeof observedAt === "number" &&
        observedAt > 0 && observedAt <= now && now - observedAt <= API_FRESHNESS_MAX_AGE_SEC.stablecoins;
      if (cacheAge > API_FRESHNESS_MAX_AGE_SEC.stablecoins || (!hasCurrentSupply && !currentPrice)) return response;
    }

    const headers = new Headers(response.headers);
    // Detail display follows the current publication, not the stricter observation
    // window for triggering depeg events. Preserve the quote's original timestamp.
    const remaining = Math.max(0, Math.floor(API_FRESHNESS_MAX_AGE_SEC.stablecoins - cacheAge));
    const priceFreshness = addFreshnessHeaders({}, canonical.updatedAt, API_FRESHNESS_MAX_AGE_SEC.stablecoins);
    if (wrapperCurrentOnly) {
      headers.set("X-Data-Updated-At", String(canonical.updatedAt));
      headers.set("X-Data-Age", String(cacheAge));
      headers.delete("X-Data-Freshness");
      headers.delete("X-Data-Freshness-Reason");
    } else if (!hasWrapperHistory) {
      headers.set("X-Data-Age", String(Math.max(cacheAge, Number(headers.get("X-Data-Age") ?? 0))));
      const detailUpdatedAt = headers.get("X-Data-Updated-At");
      const detailSourceClock = detailUpdatedAt === null ? null : parseDetailSnapshotSourceClock(detailUpdatedAt);
      if (detailSourceClock !== null) {
        headers.set("X-Data-Updated-At", String(Math.min(canonical.updatedAt, detailSourceClock)));
      } else if (!currentHistory) {
        headers.set("X-Data-Updated-At", String(canonical.updatedAt));
      }
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
        ...(coin.currentPeg ? { currentPeg: coin.currentPeg } : {}),
        priceSource: coin.priceSource,
        priceConfidence: coin.priceConfidence,
        priceUpdatedAt: coin.priceUpdatedAt,
        priceObservedAt: observedAt,
        priceObservedAtMode: coin.priceObservedAtMode,
        priceSyncedAt: coin.priceSyncedAt,
        consensusSources: coin.consensusSources,
        agreeSources: coin.agreeSources,
        priceSourceConfidenceProfile: coin.priceSourceConfidenceProfile,
        ...(coin.priceDerivation ? { priceDerivation: coin.priceDerivation } : {}),
      } : {}),
    }), {
      status: wrapperCurrentOnly ? 200 : response.status,
      statusText: wrapperCurrentOnly ? undefined : response.statusText,
      headers,
    });
  } catch (error) {
    logWorkerEventArgs("api", "warn", `[detail] canonical price unavailable stablecoin=${stablecoinId}`, error);
    return response;
  }
}
