import { API_PATHS } from "@shared/lib/api-endpoints";
import { formatCompactUsd } from "@shared/lib/format";
import { buildLiveHomepageHeroSnapshot, describeHomepageSupplyCoverage } from "@shared/lib/homepage-hero-snapshot";
import { ChainsResponseSchema } from "@shared/types/chains";
import { handleChains } from "../chains";
import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import { freshnessReason, ownerUrl, readOwnerJson, unavailable, type OgPageLoader, OG_SOURCE_BUDGET_SEC } from "./types";

/** `/chains` hero: total stablecoin supply and chain count from the `/api/chains` body. */
export const loadChainsOgPage: OgPageLoader = async (db, nowSec) => {
  const body = await readOwnerJson(await handleChains(db, ownerUrl(API_PATHS.chains())), ChainsResponseSchema);
  if (!body) return unavailable("owner-error");
  const budgetSec = OG_SOURCE_BUDGET_SEC.chains;
  const stale = freshnessReason(nowSec, body.updatedAt, budgetSec);
  if (stale) return unavailable(stale);
  // `globalTotalUsd` is the core-aggregate total, so completeness is the homepage verdict over the same
  // stablecoins generation (it also counts members absent from the cache, which `supplyCoverage` cannot).
  const stablecoins = await loadStablecoinsCache(db, { mode: "strict", contract: "published" });
  if (stablecoins.kind !== "ok" || stablecoins.updatedAt !== body.updatedAt) return unavailable("owner-error");
  const coverageNote = describeHomepageSupplyCoverage(buildLiveHomepageHeroSnapshot(stablecoins.payload, stablecoins.updatedAt));

  // Chain shares exclude unavailable chain observations, so they only support the card when complete.
  const top = (body.supplyCoverage?.chainUnavailableObservationCount ?? 0) > 0
    ? []
    : [...body.chains].sort((a, b) => b.totalUsd - a.totalUsd).slice(0, 3);
  const topShares = top.map((chain) => chain.dominanceShare);
  // Chain rows can over-attribute supply (shares summing above 1); then no single bar can be truthful.
  const shareSum = topShares.reduce((sum, share) => sum + share, 0);
  return {
    kind: "ok",
    hero: formatCompactUsd(body.globalTotalUsd),
    // `globalTotalUsd` is the core-aggregate supply total (the homepage figure); chain rows only split it.
    context: `${coverageNote ? "known market cap subtotal" : "total market cap"} of tracked stablecoins, on ${body.chains.length} chains`,
    support: top.map((chain) => `${chain.name} ${(chain.dominanceShare * 100).toFixed(1)}%`),
    ...(top.length > 0 && shareSum <= 1 ? { visual: { kind: "share-bar" as const, shares: topShares } } : {}),
    asOfSec: body.updatedAt,
    budgetSec,
    generation: `stablecoins:${body.updatedAt}`,
    ...(coverageNote ? { stampNote: coverageNote } : {}),
  };
};
