import { API_PATHS } from "@shared/lib/api-endpoints";
import { formatChainShare } from "@shared/lib/chain-share-format";
import { formatCompactUsd } from "@shared/lib/format";
import { buildLiveHomepageHeroSnapshot, describeHomepageSupplyCoverage } from "@shared/lib/homepage-hero-snapshot";
import { ChainsResponseSchema } from "@shared/types/chains";
import { handleChains } from "../chains";
import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import { freshnessReason, ownerUrl, readOwnerJson, unavailable, type OgPageLoader, OG_SOURCE_BUDGET_SEC } from "./types";

/** `/chains` hero: the largest chain's share of observed global supply (max `dominanceShare`), as on the page. */
export const loadChainsOgPage: OgPageLoader = async (db, nowSec) => {
  const body = await readOwnerJson(await handleChains(db, ownerUrl(API_PATHS.chains())), ChainsResponseSchema);
  if (!body) return unavailable("owner-error");
  const budgetSec = OG_SOURCE_BUDGET_SEC.chains;
  const stale = freshnessReason(nowSec, body.updatedAt, budgetSec);
  if (stale) return unavailable(stale);
  // `globalTotalUsd` (the share denominator) is the core-aggregate total, so completeness is the homepage verdict
  // over the same stablecoins generation (it also counts members absent from the cache, which `supplyCoverage` cannot).
  const stablecoins = await loadStablecoinsCache(db, { mode: "strict", contract: "published" });
  if (stablecoins.kind !== "ok" || stablecoins.updatedAt !== body.updatedAt) return unavailable("owner-error");
  const coverageNote = describeHomepageSupplyCoverage(buildLiveHomepageHeroSnapshot(stablecoins.payload, stablecoins.updatedAt));

  const top = [...body.chains].sort((a, b) => b.dominanceShare - a.dominanceShare).slice(0, 3);
  const leader = top[0];
  if (!leader || !(body.globalTotalUsd > 0)) return unavailable("figure-null");
  // An unobserved row on the leader or the runner-up could change which chain is largest: the identity claim itself is
  // unproven, so the card goes timeless. Gaps elsewhere keep the figure, labelled partial as on the page's beam.
  const excludedObservations = body.supplyCoverage?.chainUnavailableObservationCount ?? 0;
  const unobservedChainIds = new Set(body.supplyCoverage?.chainIdsWithUnavailableObservations ?? []);
  if (top.slice(0, 2).some((chain) => unobservedChainIds.has(chain.id))) return unavailable("incomplete-coverage");
  const topShares = top.map((chain) => chain.dominanceShare);
  // Chain rows can over-attribute supply (shares summing above 1); then no single bar can be truthful.
  const shareSum = topShares.reduce((sum, share) => sum + share, 0);
  const observationNote = excludedObservations > 0
    ? `${excludedObservations} chain ${excludedObservations === 1 ? "observation" : "observations"} unavailable`
    : null;
  // One "Partial" prefix even when both gaps apply (the homepage verdict already opens with it).
  const stampNote = coverageNote
    ? [coverageNote, ...(observationNote ? [observationNote] : [])].join(" · ")
    : observationNote ? `Partial · ${observationNote}` : "";
  return {
    kind: "ok",
    hero: formatChainShare(leader.dominanceShare),
    context: `of observed supply is on ${leader.name}, the largest of ${body.chains.length} chains${excludedObservations > 0 ? " · partial" : ""}`,
    support: [
      ...top.slice(1).map((chain) => `${chain.name} ${formatChainShare(chain.dominanceShare)}`),
      `${formatCompactUsd(body.globalTotalUsd)} ${coverageNote ? "known supply subtotal" : "observed supply"}`,
    ],
    ...(shareSum <= 1 ? { visual: { kind: "share-bar" as const, shares: topShares } } : {}),
    asOfSec: body.updatedAt,
    budgetSec,
    generation: `stablecoins:${body.updatedAt}`,
    ...(stampNote ? { stampNote } : {}),
  };
};
