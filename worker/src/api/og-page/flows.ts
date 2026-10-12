import { API_PATHS } from "@shared/lib/api-endpoints";
import { formatCurrency, formatSignedCurrency } from "@shared/lib/format";
import { aggregateCoinFlows24h } from "@shared/lib/mint-burn-coin-helpers";
import { combineMintBurnValuationCompleteness } from "@shared/lib/mint-burn-valuation";
import { formatMintBurnVolume } from "@shared/lib/mint-burn-valuation-display";
import { MintBurnFlowsResponseSchema } from "@shared/types/mint-burn";
import { handleMintBurnFlows } from "../mint-burn-flows";
import { freshnessReason, ownerUrl, readOwnerJson, unavailable, type OgPageLoader, OG_SOURCE_BUDGET_SEC } from "./types";

/**
 * `/flows` card: the 24h net mint/burn the overview sums with
 * `aggregateCoinFlows24h`. A signed net is published only for a complete
 * window; a partial window shows its known gross subtotal as a lower bound,
 * never a signed partial net. No pressure verdict: a share card states the
 * figure, not a reading of it.
 */
export const loadFlowsOgPage: OgPageLoader = async (db, nowSec) => {
  const body = await readOwnerJson(await handleMintBurnFlows(db, ownerUrl(API_PATHS.mintBurnFlows({ hours: 24 }))), MintBurnFlowsResponseSchema);
  if (!body) return unavailable("owner-error");
  const budgetSec = OG_SOURCE_BUDGET_SEC.mintBurnFlows;
  const stale = freshnessReason(nowSec, body.updatedAt, budgetSec);
  if (stale) return unavailable(stale);

  const flows = aggregateCoinFlows24h(body.coins);
  const generation = `mint-burn-flows:${body.updatedAt}`;
  const volume = (value: number) => formatCurrency(value, 1);
  if (flows.net.valueUsd != null && flows.net.completeness === "complete") {
    return {
      kind: "ok",
      hero: formatSignedCurrency(flows.net.valueUsd, 1),
      context: "net mint/burn on tracked issuance chains, last 24h",
      support: [],
      visual: {
        kind: "pair-bars",
        bars: [
          { label: "printed", value: flows.mintVolumeUsd, text: `Printed ${formatMintBurnVolume(flows.mintVolumeUsd, flows.mintCompleteness, volume)}` },
          { label: "shredded", value: flows.burnVolumeUsd, text: `Shredded ${formatMintBurnVolume(flows.burnVolumeUsd, flows.burnCompleteness, volume)}` },
        ],
      },
      asOfSec: body.updatedAt,
      budgetSec,
      generation,
    };
  }
  const grossCompleteness = combineMintBurnValuationCompleteness(flows.mintCompleteness, flows.burnCompleteness);
  if (grossCompleteness !== "partial") return unavailable("incomplete-coverage");
  return {
    kind: "ok",
    hero: formatMintBurnVolume(flows.mintVolumeUsd + flows.burnVolumeUsd, grossCompleteness, volume),
    context: "gross mint + burn on tracked issuance chains, last 24h (known subtotal)",
    support: [],
    asOfSec: body.updatedAt,
    budgetSec,
    generation,
  };
};
