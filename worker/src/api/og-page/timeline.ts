import { loadActiveDepegCount } from "./market-state";
import { type OgPageLoader, OG_SOURCE_BUDGET_SEC } from "./types";

/**
 * `/timeline` card: the open depeg incidents. Counted over the full open set
 * the homepage and `/depeg` read (`/api/peg-summary`), not the feed's 7-day
 * event page, so an incident opened before the window still counts (ADR-34).
 */
export const loadTimelineOgPage: OgPageLoader = async (db, nowSec) => {
  const depegs = await loadActiveDepegCount(db, nowSec);
  if (depegs.kind !== "ok") return depegs;
  return {
    kind: "ok",
    hero: String(depegs.count),
    context: `open depeg ${depegs.count === 1 ? "incident" : "incidents"} across tracked stablecoins`,
    support: [],
    asOfSec: depegs.asOfSec,
    budgetSec: OG_SOURCE_BUDGET_SEC.pegSummary,
    generation: `peg-summary:${depegs.asOfSec}`,
  };
};
