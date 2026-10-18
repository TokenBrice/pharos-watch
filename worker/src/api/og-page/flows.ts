import { API_PATHS } from "@shared/lib/api-endpoints";
import { GAUGE_BAND_LABELS } from "@shared/lib/classification";
import { assessGaugeBandSettlement } from "@shared/lib/mint-burn-gauge-bands";
import { formatBankRunGaugeScore, resolvePublishedGaugeBand } from "@shared/lib/mint-burn-signals";
import { MintBurnFlowsResponseSchema } from "@shared/types/mint-burn";
import { handleMintBurnFlows } from "../mint-burn-flows";
import { freshnessReason, ownerUrl, readOwnerJson, unavailable, type OgPageLoader, OG_SOURCE_BUDGET_SEC } from "./types";

/**
 * `/flows` card: the Bank Run Gauge and its published band, the page's beam.
 * A null score is unavailable (timeless card), never 0. When valuation withheld
 * weighted coins, the score is re-weighted over the rest and the stamp says so;
 * when that weight could carry it across a band edge the band is not printed.
 * No net figure: the gauge is the page's one answer.
 */
export const loadFlowsOgPage: OgPageLoader = async (db, nowSec) => {
  const body = await readOwnerJson(await handleMintBurnFlows(db, ownerUrl(API_PATHS.mintBurnFlows({ hours: 24 }))), MintBurnFlowsResponseSchema);
  if (!body) return unavailable("owner-error");
  const budgetSec = OG_SOURCE_BUDGET_SEC.mintBurnFlows;
  const stale = freshnessReason(nowSec, body.updatedAt, budgetSec);
  if (stale) return unavailable(stale);

  const { score, partialValuationInputs } = body.gauge;
  const band = resolvePublishedGaugeBand(body.gauge.band, score);
  if (score == null || band == null) return unavailable("figure-null");
  // One authority with the digest and the page: a band that withheld weight could move is not printed.
  const { settled } = assessGaugeBandSettlement(body.gauge);
  const withheld = `${partialValuationInputs} weighted ${partialValuationInputs === 1 ? "coin" : "coins"} withheld`;
  return {
    kind: "ok",
    hero: formatBankRunGaugeScore(score),
    context: settled
      ? `Bank Run Gauge · ${GAUGE_BAND_LABELS[band]} · pressure vs each coin's 30-day norm`
      : "Bank Run Gauge · pressure vs each coin's 30-day norm",
    support: [],
    asOfSec: body.updatedAt,
    budgetSec,
    generation: `mint-burn-flows:${body.updatedAt}`,
    ...(!settled
      ? { stampNote: `band unsettled: ${withheld}` }
      : partialValuationInputs
        ? { stampNote: `partial: ${withheld}` }
        : {}),
  };
};
