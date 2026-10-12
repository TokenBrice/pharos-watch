import { formatCurrency } from "@shared/lib/format";
import { buildLiveHomepageHeroSnapshot, describeHomepageSupplyCoverage } from "@shared/lib/homepage-hero-snapshot";
import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import { formatActiveDepegs, loadActiveDepegCount, loadDisplayedPsiLabel } from "./market-state";
import { freshnessReason, settleSupport, unavailable, type OgPageLoader, OG_SOURCE_BUDGET_SEC } from "./types";

/** Homepage hero: total observed market cap of the core aggregate, as `home-alt-hero` shows it. */
export const loadHomeOgPage: OgPageLoader = async (db, nowSec) => {
  const stablecoins = await loadStablecoinsCache(db, { mode: "strict", contract: "published" });
  if (stablecoins.kind !== "ok") return unavailable("cache-missing");
  const budgetSec = OG_SOURCE_BUDGET_SEC.stablecoins;
  const stale = freshnessReason(nowSec, stablecoins.updatedAt, budgetSec);
  if (stale) return unavailable(stale);

  const snapshot = buildLiveHomepageHeroSnapshot(stablecoins.payload, stablecoins.updatedAt);
  if (snapshot.totalUsd == null) return unavailable("figure-null");
  // The page publishes a partial total as a labelled known subtotal; the card mirrors it.
  const coverageNote = describeHomepageSupplyCoverage(snapshot);

  const support = await settleSupport([
    loadDisplayedPsiLabel(db, nowSec),
    loadActiveDepegCount(db, nowSec).then((result) => (result.kind === "ok" ? formatActiveDepegs(result.count) : null)),
  ]);
  return {
    kind: "ok",
    hero: formatCurrency(snapshot.totalUsd, 1),
    context: coverageNote ? "known market cap subtotal of tracked stablecoins" : "total market cap of tracked stablecoins",
    support,
    ...(coverageNote ? { stampNote: coverageNote } : {}),
    asOfSec: stablecoins.updatedAt,
    budgetSec,
    generation: `stablecoins:${stablecoins.updatedAt}`,
  };
};
