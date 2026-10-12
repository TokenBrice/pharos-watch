import { buildBlacklistStatusBuckets } from "@shared/lib/blacklist-status-buckets";
import { formatCurrency } from "@shared/lib/format";
import { computeFreezableSummary, formatShare } from "@shared/lib/freezewatch/freezable-summary";
import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import { freshnessReason, unavailable, type OgPageLoader, OG_SOURCE_BUDGET_SEC } from "./types";

/** `/freezewatch` hero: the freezable share of tracked supply, from the same buckets and summary as the page. */
export const loadFreezewatchOgPage: OgPageLoader = async (db, nowSec) => {
  const stablecoins = await loadStablecoinsCache(db, { mode: "strict", contract: "published" });
  if (stablecoins.kind !== "ok") return unavailable("cache-missing");
  const budgetSec = OG_SOURCE_BUDGET_SEC.stablecoins;
  const stale = freshnessReason(nowSec, stablecoins.updatedAt, budgetSec);
  if (stale) return unavailable(stale);

  const summary = computeFreezableSummary(buildBlacklistStatusBuckets(stablecoins.payload.peggedAssets));
  if (summary.coverage === "unavailable" || summary.freezableShare == null) return unavailable("figure-null");
  // A partial share covers observed supply only; the page labels it, a share card cannot.
  if (summary.coverage === "partial") return unavailable("incomplete-coverage");
  return {
    kind: "ok",
    hero: formatShare(summary.freezableShare),
    context: "of tracked stablecoin market cap is under issuer freeze control",
    support: [
      `${formatCurrency(summary.freezableMarketCap, 1)} freezable`,
      `${summary.freezableCount} stablecoins`,
    ],
    visual: { kind: "share-bar", shares: [summary.freezableShare / 100] },
    asOfSec: stablecoins.updatedAt,
    budgetSec,
    generation: `stablecoins:${stablecoins.updatedAt}`,
  };
};
