import { buildNonUsdMarketSnapshot, formatNonUsdShare } from "@shared/lib/alt-peg-snapshot";
import { PEG_LABELS_SHORT } from "@shared/lib/classification";
import { formatCurrency } from "@shared/lib/format";
import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import { freshnessReason, unavailable, type OgPageLoader, OG_SOURCE_BUDGET_SEC } from "./types";

/** `/alt-pegs` hero: non-USD market cap of the core universe, from the same reducer as the page. */
export const loadAltPegsOgPage: OgPageLoader = async (db, nowSec) => {
  const stablecoins = await loadStablecoinsCache(db, { mode: "strict", contract: "published" });
  if (stablecoins.kind !== "ok") return unavailable("cache-missing");
  const budgetSec = OG_SOURCE_BUDGET_SEC.stablecoins;
  const stale = freshnessReason(nowSec, stablecoins.updatedAt, budgetSec);
  if (stale) return unavailable(stale);

  const snapshot = buildNonUsdMarketSnapshot(stablecoins.payload.peggedAssets);
  if (snapshot.altMarketCap == null) return unavailable("figure-null");
  // The page publishes a partial total as a labelled known subtotal and withholds shares; the card mirrors both.
  const partial = snapshot.altSupplyUnavailableCount > 0;
  const top = partial ? [] : snapshot.pegs.slice(0, 3);
  return {
    kind: "ok",
    hero: formatCurrency(snapshot.altMarketCap, 1),
    context: partial ? "known market cap subtotal of non-USD stablecoins" : "market cap of non-USD stablecoins",
    support: top.map((entry) => `${PEG_LABELS_SHORT[entry.peg] ?? entry.peg} ${formatNonUsdShare(entry.sharePct)}`),
    ...(top.length > 0 ? { visual: { kind: "share-bar" as const, shares: top.map((entry) => entry.sharePct! / 100) } } : {}),
    asOfSec: stablecoins.updatedAt,
    budgetSec,
    generation: `stablecoins:${stablecoins.updatedAt}`,
    ...(partial
      ? { stampNote: `Partial · ${snapshot.altSupplyObservedCount}/${snapshot.altCoinCount} non-USD coins observed` }
      : {}),
  };
};
