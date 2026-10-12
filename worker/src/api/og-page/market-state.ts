import { API_PATHS } from "@shared/lib/api-endpoints";
import { PSI_HEX_COLORS } from "@shared/lib/classification";
import type { OgRouteSupportItem } from "@shared/lib/og-route-cards";
import { getDisplayedPsi } from "@shared/lib/psi-view-model";
import { selectActiveDepegCoins } from "@shared/lib/active-depegs";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { PegSummaryResponseSchema } from "@shared/types/market";
import { StabilityIndexResponseSchema } from "@shared/types/stability";
import { handlePegSummary } from "../peg-summary";
import { handleStabilityIndex } from "../stability-index";
import { freshnessReason, ownerUrl, readOwnerJson, unavailable, type OgPageUnavailable, OG_SOURCE_BUDGET_SEC } from "./types";

export interface ActiveDepegCount {
  kind: "ok";
  count: number;
  asOfSec: number;
}

/**
 * Active depegs as the homepage market-state line counts them: `/api/peg-summary`
 * coins with `activeDepeg` over the active registry — the full open set, not a
 * windowed event page.
 */
export async function loadActiveDepegCount(db: D1Database, nowSec: number): Promise<ActiveDepegCount | OgPageUnavailable> {
  const body = await readOwnerJson(await handlePegSummary(db), PegSummaryResponseSchema);
  if (!body) return unavailable("owner-error");
  const asOfSec = body.methodology.asOf;
  const stale = freshnessReason(nowSec, asOfSec, OG_SOURCE_BUDGET_SEC.pegSummary);
  if (stale) return unavailable(stale);
  const count = selectActiveDepegCoins(body.coins, ACTIVE_IDS).length;
  return { kind: "ok", count, asOfSec };
}

export function formatActiveDepegs(count: number): string {
  return `${count} active ${count === 1 ? "depeg" : "depegs"}`;
}

/**
 * The displayed PSI (24h average where published) as "PSI Steady 92.4" with its
 * band swatch — read this render, so the colour is a current claim — or `null` when not fresh.
 */
export async function loadDisplayedPsiLabel(db: D1Database, nowSec: number): Promise<OgRouteSupportItem | null> {
  const body = await readOwnerJson(await handleStabilityIndex(db, ownerUrl(API_PATHS.stabilityIndex())), StabilityIndexResponseSchema);
  const current = body?.current;
  if (!current || freshnessReason(nowSec, current.computedAt, OG_SOURCE_BUDGET_SEC.stabilityIndex)) return null;
  const psi = getDisplayedPsi(current);
  const text = `PSI ${psi.band.charAt(0)}${psi.band.slice(1).toLowerCase()} ${psi.score.toFixed(1)}`;
  const swatchHex = (PSI_HEX_COLORS as Record<string, string>)[psi.band];
  return swatchHex ? { text, swatchHex } : text;
}
