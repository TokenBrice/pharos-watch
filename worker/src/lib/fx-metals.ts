import { logWorkerEventArgs } from "./structured-log";
import { derivePegRates } from "@shared/lib/peg-rates";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { validatePayloadWithSchema } from "./api-schema";
import { USER_AGENT } from "./constants";
import { fetchJsonWithRetry } from "./fetch-retry";
import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "./stablecoins-cache";
import { z } from "zod";

export type MetalPegKey = "peggedGOLD" | "peggedSILVER";

type MetalResolutionSource = "gold-api.com" | "commodity-peer-median" | "cached";

interface CommodityPeerMedianReference {
  rates: Partial<Record<MetalPegKey, number>>;
  updatedAt: number | null;
}

interface ResolvedMetalRate {
  rate: number;
  source: MetalResolutionSource;
  updatedAt: number | null;
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
});

function relativeDivergence(candidate: number, reference: number): number {
  return Math.abs(candidate - reference) / reference;
}

function deriveCommodityPeerMedianRates(
  peggedAssets: Parameters<typeof derivePegRates>[0],
): Partial<Record<MetalPegKey, number>> {
  const { rates } = derivePegRates(peggedAssets, TRACKED_META_BY_ID);
  const commodityRates: Partial<Record<MetalPegKey, number>> = {};

  for (const pegKey of ["peggedGOLD", "peggedSILVER"] as const) {
    const rate = rates[pegKey];
    if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
      commodityRates[pegKey] = Number(rate.toFixed(6));
    }
  }

  return commodityRates;
}

export async function loadCommodityPeerMedianReference(
  db: D1Database,
  syncStartSec: number,
): Promise<CommodityPeerMedianReference> {
  const stablecoinsCacheResult = await loadStablecoinsCache(db, { mode: "lenient" });
  if (!hasUsableStablecoinsPayload(stablecoinsCacheResult)) {
    return { rates: {}, updatedAt: null };
  }

  const updatedAt =
    typeof stablecoinsCacheResult.updatedAt === "number" && stablecoinsCacheResult.updatedAt > 0
      ? Math.min(syncStartSec, stablecoinsCacheResult.updatedAt)
      : null;

  return {
    rates: deriveCommodityPeerMedianRates(stablecoinsCacheResult.payload.peggedAssets),
    updatedAt,
  };
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
    commodityPeerMedian,
    syncStartSec,
    signal,
    validateRate,
  }: {
    prevRates: Record<string, number>;
    commodityPeerMedian: CommodityPeerMedianReference;
    syncStartSec: number;
    signal?: AbortSignal;
    validateRate: (pegKey: MetalPegKey, rate: number, prevRate: number | undefined) => boolean;
  },
): Promise<MetalsResolution> {
  const resolvedByPeg: Partial<Record<MetalPegKey, ResolvedMetalRate>> = {};

  const resolvePeerMedian = (pegKey: MetalPegKey): ResolvedMetalRate | null => {
    const rate = commodityPeerMedian.rates[pegKey];
    if (typeof rate !== "number" || rate <= 0) {
      return null;
    }
    if (!validateRate(pegKey, rate, prevRates[pegKey])) {
      return null;
    }
    return {
      rate,
      source: "commodity-peer-median",
      updatedAt: commodityPeerMedian.updatedAt ?? syncStartSec,
    };
  };

  const resolveCached = (pegKey: MetalPegKey): ResolvedMetalRate | null => {
    const rate = prevRates[pegKey];
    if (typeof rate !== "number" || rate <= 0) {
      return null;
    }
    return { rate, source: "cached", updatedAt: null };
  };

  const resolveMetal = (pegKey: MetalPegKey, candidateRate: number | undefined): ResolvedMetalRate | null => {
    const peerMedian = resolvePeerMedian(pegKey);
    if (typeof candidateRate === "number" && candidateRate > 0 && validateRate(pegKey, candidateRate, prevRates[pegKey])) {
      if (peerMedian) {
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
        updatedAt: syncStartSec,
      };
    }
    return peerMedian ?? resolveCached(pegKey);
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

    resolvedByPeg.peggedGOLD = resolveMetal("peggedGOLD", goldValidation.ok ? goldValidation.data.price : undefined) ?? undefined;
    resolvedByPeg.peggedSILVER = resolveMetal("peggedSILVER", silverValidation.ok ? silverValidation.data.price : undefined) ?? undefined;
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
