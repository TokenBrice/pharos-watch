import { logWorkerEventArgs } from "./structured-log";
import { derivePegRates, normalizePegType } from "@shared/lib/peg-rates";
import { MIN_PEER_MEDIAN_CONTRIBUTORS } from "@shared/lib/peg-reference-trust";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { validatePayloadWithSchema } from "./api-schema";
import { USER_AGENT } from "./constants";
import { MAX_FX_RATE_DELTA_PCT } from "./fx-config";
import { fetchJsonWithRetry } from "./fetch-retry";
import { isFreshFxObservation } from "./fx-rate-state";
import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "./stablecoins-cache";
import { z } from "zod";
import { validateCompositePricingSourceFreshness } from "./pricing-source-freshness";
import type { FxMedianContributor } from "./fx-observations";

export type MetalPegKey = "peggedGOLD" | "peggedSILVER";

type MetalResolutionSource = "gold-api.com" | "commodity-peer-median" | "cached";

interface CommodityPeerMedianReference {
  rates: Partial<Record<MetalPegKey, number>>;
  counts: Partial<Record<MetalPegKey, number>>;
  contributorsByPeg: Partial<Record<MetalPegKey, FxMedianContributor[]>>;
}

interface ResolvedMetalRate {
  rate: number;
  source: MetalResolutionSource;
  updatedAt: number | null;
  contributors?: FxMedianContributor[];
}

interface MetalSourceSummary {
  "gold-api.com": "ok" | "partial" | "error";
  "commodity-peer-median": "ok" | "partial" | "unavailable";
}

export interface MetalsResolution {
  resolvedByPeg: Partial<Record<MetalPegKey, ResolvedMetalRate>>;
  sources: MetalSourceSummary;
}

const METAL_CROSS_CHECK_MAX_DIVERGENCE = 0.05;

const MetalPriceSchema = z.object({
  price: z.number(),
  updatedAt: z.string().optional(),
});

function relativeDivergence(candidate: number, reference: number): number {
  return Math.abs(candidate - reference) / reference;
}

export async function loadCommodityPeerMedianReference(
  db: D1Database,
  syncStartSec: number,
): Promise<CommodityPeerMedianReference> {
  const stablecoinsCacheResult = await loadStablecoinsCache(db, { mode: "lenient" });
  if (!hasUsableStablecoinsPayload(stablecoinsCacheResult)) {
    return { rates: {}, counts: {}, contributorsByPeg: {} };
  }

  const quoteClocks = new Map<string, number>();
  const peers = stablecoinsCacheResult.payload.peggedAssets.filter((asset) => {
    const pegKey = normalizePegType(asset.pegType);
    if (pegKey !== "peggedGOLD" && pegKey !== "peggedSILVER") return false;
    const freshness = validateCompositePricingSourceFreshness({
      source: asset.priceSource ?? "",
      observedAt: asset.priceObservedAt === undefined ? asset.priceUpdatedAt : asset.priceObservedAt,
      observedAtMode: asset.priceObservedAtMode,
      nowSec: syncStartSec,
      requireObservedAt: true,
      maxFutureSkewSec: 0,
    });
    if (!freshness.accepted || freshness.observedAt == null) return false;
    quoteClocks.set(asset.id, freshness.observedAt);
    return true;
  });
  const selected = derivePegRates(peers, TRACKED_META_BY_ID);
  const result: CommodityPeerMedianReference = { rates: {}, counts: {}, contributorsByPeg: {} };
  for (const peg of ["peggedGOLD", "peggedSILVER"] as const) {
    const members = selected.contributors?.[peg];
    if (!members?.length) continue;
    const contributors = members.flatMap((member) =>
      member.assetId ? [{ ...member, assetId: member.assetId, observedAtSec: member.observedAtSec ?? quoteClocks.get(member.assetId) ?? null }] : []);
    if (contributors.length !== members.length) continue;
    result.rates[peg] = selected.rates[peg];
    result.counts[peg] = contributors.length;
    result.contributorsByPeg[peg] = contributors;
  }
  return result;
}

function summarizeMetalSources(
  resolvedByPeg: Partial<Record<MetalPegKey, ResolvedMetalRate>>,
): MetalSourceSummary {
  const resolved = Object.values(resolvedByPeg);
  const goldApiCount = resolved.filter((entry) => entry?.source === "gold-api.com").length;
  const commodityCount = resolved.filter((entry) => entry?.source === "commodity-peer-median").length;

  return {
    "gold-api.com": goldApiCount === 2 ? "ok" : goldApiCount > 0 ? "partial" : "error",
    "commodity-peer-median": commodityCount === 2 ? "ok" : commodityCount > 0 ? "partial" : "unavailable",
  };
}

export async function resolveMetalReferenceRates(
  {
    prevRates,
    prevRateIsFresh = () => true,
    commodityPeerMedian,
    freshChainlinkRates = {},
    syncStartSec,
    signal,
    validateRate,
  }: {
    prevRates: Record<string, number>;
    /**
     * Whether the previous per-peg observation is young enough to veto a
     * replacement. A stale or unknown-clock incumbent may still bound a
     * move within the delta limit, but a larger move needs an independent
     * fresh corroborator (see `freshChainlinkRates`).
     */
    prevRateIsFresh?: (pegKey: MetalPegKey) => boolean;
    commodityPeerMedian: CommodityPeerMedianReference;
    /**
     * Fresh, provider-dated Chainlink metal rounds fetched by the caller in
     * this run. A quote that jumps more than the prior-value delta limit
     * against a non-fresh incumbent is admitted only when one of these
     * independent rounds confirms it within the cross-check bound.
     */
    freshChainlinkRates?: Partial<Record<MetalPegKey, number>>;
    syncStartSec: number;
    signal?: AbortSignal;
    validateRate: (pegKey: MetalPegKey, rate: number, prevRate: number | undefined) => boolean;
  },
): Promise<MetalsResolution> {
  const resolvedByPeg: Partial<Record<MetalPegKey, ResolvedMetalRate>> = {};

  const isFreshProviderDated = (pegKey: MetalPegKey, updatedAt: number | null): boolean =>
    updatedAt != null &&
    isFreshFxObservation(updatedAt, "live", syncStartSec, { pegKey, cadence: "intraday" });

  const getPeerClock = (pegKey: MetalPegKey): number | null => {
    const contributors = commodityPeerMedian.contributorsByPeg[pegKey];
    if (!contributors?.length || contributors.length !== commodityPeerMedian.counts[pegKey] ||
        new Set(contributors.map(({ assetId }) => assetId)).size !== contributors.length) return null;
    const clocks = contributors.flatMap(({ observedAtSec }) =>
      observedAtSec != null && Number.isSafeInteger(observedAtSec) && observedAtSec > 0 && observedAtSec <= syncStartSec
        ? [observedAtSec] : []);
    return clocks.length === contributors.length ? Math.min(...clocks) : null;
  };

  const hasFreshCorroboration = (pegKey: MetalPegKey, candidateRate: number): boolean => {
    const chainlinkRate = freshChainlinkRates[pegKey];
    if (
      typeof chainlinkRate === "number" &&
      Number.isFinite(chainlinkRate) &&
      chainlinkRate > 0 &&
      relativeDivergence(candidateRate, chainlinkRate) <= METAL_CROSS_CHECK_MAX_DIVERGENCE
    ) {
      return true;
    }
    const medianRate = commodityPeerMedian.rates[pegKey];
    const medianCount = commodityPeerMedian.counts[pegKey] ?? 0;
    return typeof medianRate === "number" &&
      medianRate > 0 &&
      medianCount >= MIN_PEER_MEDIAN_CONTRIBUTORS &&
      isFreshProviderDated(pegKey, getPeerClock(pegKey)) &&
      relativeDivergence(candidateRate, medianRate) <= METAL_CROSS_CHECK_MAX_DIVERGENCE;
  };

  const resolvePeerMedian = (pegKey: MetalPegKey): ResolvedMetalRate | null => {
    const rate = commodityPeerMedian.rates[pegKey];
    const count = commodityPeerMedian.counts[pegKey] ?? 0;
    if (typeof rate !== "number" || rate <= 0 || count < MIN_PEER_MEDIAN_CONTRIBUTORS) {
      return null;
    }
    if (!validateRate(pegKey, rate, prevRateIsFresh(pegKey) ? prevRates[pegKey] : undefined)) {
      return null;
    }
    return {
      rate,
      source: "commodity-peer-median",
      updatedAt: getPeerClock(pegKey),
      contributors: commodityPeerMedian.contributorsByPeg[pegKey],
    };
  };

  const resolveCached = (pegKey: MetalPegKey): ResolvedMetalRate | null => {
    const rate = prevRates[pegKey];
    if (
      typeof rate !== "number"
      || rate <= 0
      || !validateRate(pegKey, rate, undefined)
    ) {
      return null;
    }
    return { rate, source: "cached", updatedAt: null };
  };

  const resolveMetal = (pegKey: MetalPegKey, candidate: z.infer<typeof MetalPriceSchema> | undefined): ResolvedMetalRate | null => {
    const candidateRate = candidate?.price;
    const peerMedian = resolvePeerMedian(pegKey);
    const providerTimeMs = candidate?.updatedAt == null ? NaN : Date.parse(candidate.updatedAt);
    if (typeof candidateRate !== "number" || !(candidateRate > 0) || providerTimeMs > syncStartSec * 1000) {
      return peerMedian ?? resolveCached(pegKey);
    }

    const incumbentRate = prevRates[pegKey];
    const hasIncumbent = typeof incumbentRate === "number" && Number.isFinite(incumbentRate) && incumbentRate > 0;
    const candidateUpdatedAt = Number.isFinite(providerTimeMs) && providerTimeMs >= 1000 ? Math.floor(providerTimeMs / 1000) : null;
    const candidateIsProviderDated = candidateUpdatedAt != null;
    // An undated quote is not provider-dated evidence: it may never use the
    // stale-incumbent exemption (docs: a fresh, bounded, provider-dated quote).
    const incumbentCanVeto = !hasIncumbent || prevRateIsFresh(pegKey) || !candidateIsProviderDated;

    if (!validateRate(pegKey, candidateRate, incumbentCanVeto ? incumbentRate : undefined)) {
      return peerMedian ?? resolveCached(pegKey);
    }

    if (hasIncumbent && !incumbentCanVeto) {
      const move = relativeDivergence(candidateRate, incumbentRate);
      if (move > MAX_FX_RATE_DELTA_PCT && !hasFreshCorroboration(pegKey, candidateRate)) {
        logWorkerEventArgs("lib", "warn",
          `[sync-fx-rates] Kept stale ${pegKey} incumbent ${incumbentRate} because ` +
          `${candidateRate} moved ${(move * 100).toFixed(1)}% without fresh corroboration`,
        );
        return peerMedian ?? resolveCached(pegKey);
      }
    }

    const spotInBudget = isFreshProviderDated(pegKey, candidateUpdatedAt);
    if (peerMedian && !spotInBudget && peerMedian.updatedAt != null &&
        (candidateUpdatedAt == null || peerMedian.updatedAt >= candidateUpdatedAt)) return peerMedian;
    if (peerMedian && isFreshProviderDated(pegKey, peerMedian.updatedAt)) {
      const divergence = relativeDivergence(candidateRate, peerMedian.rate);
      if (divergence > METAL_CROSS_CHECK_MAX_DIVERGENCE) {
        logWorkerEventArgs("lib", "warn",
          `[sync-fx-rates] Rejected gold-api.com ${pegKey} rate ${candidateRate} because it diverged ` +
          `${Number((divergence * 100).toFixed(1))}% from commodity peer median ${peerMedian.rate}`,
        );
        return peerMedian;
      }
    }
    return {
      rate: candidateRate,
      source: "gold-api.com",
      updatedAt: candidateUpdatedAt,
    };
  };

  try {
    const [goldRes, silverRes] = await Promise.all([
      fetchJsonWithRetry("https://api.gold-api.com/price/XAU", { headers: { "User-Agent": USER_AGENT }, signal }, 2, { returnFinalResponse: true }),
      fetchJsonWithRetry("https://api.gold-api.com/price/XAG", { headers: { "User-Agent": USER_AGENT }, signal }, 2, { returnFinalResponse: true }),
    ]);
    const goldPayload = goldRes?.response.ok ? goldRes.body : null;
    const silverPayload = silverRes?.response.ok ? silverRes.body : null;
    const goldValidation = goldPayload == null
      ? { ok: false as const, issues: "missing gold payload" }
      : validatePayloadWithSchema(MetalPriceSchema, goldPayload, "sync-fx-rates:gold");
    const silverValidation = silverPayload == null
      ? { ok: false as const, issues: "missing silver payload" }
      : validatePayloadWithSchema(MetalPriceSchema, silverPayload, "sync-fx-rates:silver");

    if (!goldValidation.ok) {
      logWorkerEventArgs("lib", "warn", `[sync-fx-rates] Gold payload invalid: ${goldValidation.issues}`);
    }
    if (!silverValidation.ok) {
      logWorkerEventArgs("lib", "warn", `[sync-fx-rates] Silver payload invalid: ${silverValidation.issues}`);
    }

    resolvedByPeg.peggedGOLD = resolveMetal("peggedGOLD", goldValidation.ok ? goldValidation.data : undefined) ?? undefined;
    resolvedByPeg.peggedSILVER = resolveMetal("peggedSILVER", silverValidation.ok ? silverValidation.data : undefined) ?? undefined;
  } catch (err) {
    logWorkerEventArgs("lib", "warn", "[sync-fx-rates] Gold/silver API failed, falling back to peer median or cached values:", err);
    resolvedByPeg.peggedGOLD = resolvePeerMedian("peggedGOLD") ?? resolveCached("peggedGOLD") ?? undefined;
    resolvedByPeg.peggedSILVER = resolvePeerMedian("peggedSILVER") ?? resolveCached("peggedSILVER") ?? undefined;
  }

  return {
    resolvedByPeg,
    sources: summarizeMetalSources(resolvedByPeg),
  };
}
