/**
 * Price consensus engine — selects the most trustworthy price from multiple
 * sources using a maximal-clique agreement algorithm (Bron-Kerbosch).
 *
 * Algorithm:
 * 1. Build agreement graph: sources whose prices agree within `thresholdBps`.
 * 2. Find all maximal cliques (sets of mutually agreeing sources).
 * 3. Pick the best cluster by: largest size → highest total weight → strongest
 *    trust tier → tightest spread → closest to pegRef → alphabetical tiebreak.
 * 4. Return the median price of the winning cluster with confidence metadata.
 *
 * Pairwise agreement is required (not transitive) to prevent a chain like
 * 1.000 / 1.004 / 1.008 from being treated as a single high-confidence cluster
 * when the endpoints disagree materially.
 *
 * @see docs/pricing-pipeline.md for pipeline-level context.
 */
import type { PriceConfidence, PriceObservedAtMode } from "@shared/types/core";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import { isHardPricingTrustTier } from "@shared/lib/pricing-source-policy";
import { median } from "@shared/lib/stats";
import {
  buildObservedAtModeRecord,
  buildObservedAtRecord,
  pickConservativeObservedAt,
  pickConservativeObservedAtMode,
} from "./pricing-types";
import { midDivergenceBps, pricesAgreeWithinBps } from "./price-divergence";

export interface SourcePrice {
  source: string;
  price: number;
  weight: number;
  observedAt?: number | null;
  observedAtMode?: PriceObservedAtMode | null;
  metadata?: Record<string, unknown>;
}

export interface ConsensusResult {
  price: number;
  source: string;
  selectedSource: string;
  priceEstimator: "selected_source" | "cluster_median";
  confidence: PriceConfidence;
  agreeSources: string[];
  disagreeSources: string[];
  allPrices: Record<string, number>;
  observedAt: number | null;
  observedAtMode: PriceObservedAtMode | null;
  observedAtBySource: Record<string, number | null>;
  observedAtModeBySource: Record<string, PriceObservedAtMode | null>;
}

export interface ConsensusOptions {
  mode?: "fixed" | "nav";
}

function independentSourceFamily(source: SourcePrice): string {
  return getPricingSourceRegistryEntry(source.source)?.depegSourceFamily ?? `source:${source.source}`;
}

function collapseRepeatedSourceQuotes(sources: readonly SourcePrice[]): SourcePrice[] {
  const bySource = new Map<string, SourcePrice[]>();
  for (const source of sources) {
    const entries = bySource.get(source.source) ?? [];
    entries.push(source);
    bySource.set(source.source, entries);
  }

  return [...bySource.values()].map((entries) => {
    if (entries.length === 1) return entries[0]!;
    const observedAtValues = entries
      .map((entry) => entry.observedAt)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const observedAtModes = new Set(entries.map((entry) => entry.observedAtMode ?? null));
    const representative = entries.reduce((best, candidate) => (candidate.weight > best.weight ? candidate : best));
    return {
      ...representative,
      price: median(entries.map((entry) => entry.price)) ?? representative.price,
      weight: Math.max(...entries.map((entry) => entry.weight)),
      observedAt: observedAtValues.length > 0 ? Math.min(...observedAtValues) : null,
      observedAtMode: observedAtModes.size === 1 ? (entries[0]?.observedAtMode ?? null) : "unknown",
      metadata: {
        ...representative.metadata,
        collapsedQuoteCount: entries.length,
      },
    };
  });
}

function pickIndependentFamilyRepresentative(sources: readonly SourcePrice[], pegRef: number | null): SourcePrice {
  return sources.reduce((best, candidate) => {
    const candidateTrust = getSourceTrustPriority(candidate.source);
    const bestTrust = getSourceTrustPriority(best.source);
    if (candidateTrust !== bestTrust) return candidateTrust < bestTrust ? candidate : best;
    if (candidate.weight !== best.weight) return candidate.weight > best.weight ? candidate : best;
    if (pegRef != null && pegRef > 0) {
      const candidateDistance = Math.abs(candidate.price - pegRef);
      const bestDistance = Math.abs(best.price - pegRef);
      if (candidateDistance !== bestDistance) return candidateDistance < bestDistance ? candidate : best;
    }
    return candidate.source.localeCompare(best.source) < 0 ? candidate : best;
  });
}

export function collapsePriceSourcesByIndependentFamily(
  sources: readonly SourcePrice[],
  pegRef: number | null,
): SourcePrice[] {
  const byFamily = new Map<string, SourcePrice[]>();
  for (const source of collapseRepeatedSourceQuotes(sources)) {
    const family = independentSourceFamily(source);
    const entries = byFamily.get(family) ?? [];
    entries.push(source);
    byFamily.set(family, entries);
  }

  return [...byFamily.values()].map((entries) =>
    entries.length === 1 ? entries[0]! : pickIndependentFamilyRepresentative(entries, pegRef),
  );
}

/**
 * Compute price consensus across N sources.
 *
 * Algorithm:
 * 1. If 0 sources, return null.
 * 2. If 1 source, return single-source.
 * 3. For 2+ sources, find the largest cluster of sources that agree within
 *    `thresholdBps` of each other (pairwise).
 * 4. If majority cluster has 2+ members → high confidence, pick highest-weight member.
 * 5. If no majority → low confidence, pick by trust tier first, then closeness
 *    to `pegRef` (or the source median when the reference is unavailable).
 *
 * @param sources - Candidate price feeds, each with a source name, price, and weight.
 * @param pegRef - The expected peg price (e.g. 1.0 for USD stablecoins). Used as
 *   tiebreaker when clusters are otherwise equal; `null` activates NAV mode.
 * @param thresholdBps - Maximum allowed price spread (in basis points) for two
 *   sources to be considered agreeing. NAV mode overrides this to 500 bps.
 * @param options.mode - Explicit mode override: "fixed" uses `thresholdBps` as-is;
 *   "nav" forces 500 bps tolerance. Inferred from `pegRef` when omitted.
 * @returns Consensus result with price, confidence level, and source attribution,
 *   or `null` if `sources` is empty.
 */
export function computePriceConsensus(
  sources: SourcePrice[],
  pegRef: number | null,
  thresholdBps: number,
  options?: ConsensusOptions,
): ConsensusResult | null {
  const independentSources = collapsePriceSourcesByIndependentFamily(sources, pegRef);
  if (independentSources.length === 0) return null;

  const allPrices: Record<string, number> = {};
  for (const s of independentSources) allPrices[s.source] = s.price;
  const observedAtBySource = buildObservedAtRecord(independentSources);
  const observedAtModeBySource = buildObservedAtModeRecord(independentSources);

  if (independentSources.length === 1) {
    const s = independentSources[0]!;
    return {
      price: s.price,
      source: s.source,
      selectedSource: s.source,
      priceEstimator: "selected_source",
      confidence: "single-source",
      agreeSources: [s.source],
      disagreeSources: [],
      allPrices,
      observedAt: observedAtBySource[s.source] ?? null,
      observedAtMode: observedAtModeBySource[s.source] ?? null,
      observedAtBySource,
      observedAtModeBySource,
    };
  }

  const mode = options?.mode ?? (pegRef === null || pegRef <= 0 ? "nav" : "fixed");
  const clusterThresholdBps = mode === "nav" ? 500 : thresholdBps;

  // Agreement clusters must be fully pairwise, not just "close to the same anchor".
  // That prevents transitive chains like 1.000 / 1.004 / 1.008 from being treated as
  // one 3-source high-confidence cluster when the endpoints disagree materially.
  const clusters = findMaximalAgreementClusters(independentSources, clusterThresholdBps);
  const bestCluster = pickBestCluster(clusters, pegRef);

  const clusterSet = new Set(bestCluster.map((s) => s.source));
  const disagreeSources = independentSources.filter((s) => !clusterSet.has(s.source)).map((s) => s.source);

  if (bestCluster.length >= 2) {
    const clusterRef = pegRef != null && pegRef > 0 ? pegRef : medianPrice(bestCluster);
    const clusterPrice = medianPrice(bestCluster);
    const chosen = pickBestClusterSource(bestCluster, clusterRef);
    const agreeSources = bestCluster.map((s) => s.source);
    return {
      price: clusterPrice,
      source: buildSourceLabel(bestCluster),
      selectedSource: chosen.source,
      priceEstimator: "cluster_median",
      confidence: "high",
      agreeSources,
      disagreeSources,
      allPrices,
      observedAt: pickConservativeObservedAt(agreeSources, observedAtBySource),
      observedAtMode: pickConservativeObservedAtMode(agreeSources, observedAtModeBySource),
      observedAtBySource,
      observedAtModeBySource,
    };
  }

  const fallbackRef = pegRef != null && pegRef > 0 ? pegRef : medianPrice(independentSources);
  const chosen = pickLowConfidenceSource(independentSources, fallbackRef);
  return {
    price: chosen.price,
    source: chosen.source,
    selectedSource: chosen.source,
    priceEstimator: "selected_source",
    confidence: "low",
    agreeSources: [chosen.source],
    disagreeSources: independentSources.filter((s) => s !== chosen).map((s) => s.source),
    allPrices,
    observedAt: observedAtBySource[chosen.source] ?? null,
    observedAtMode: observedAtModeBySource[chosen.source] ?? null,
    observedAtBySource,
    observedAtModeBySource,
  };
}

function findMaximalAgreementClusters(sources: SourcePrice[], thresholdBps: number): SourcePrice[][] {
  const neighborMap = new Map<number, Set<number>>();
  const maximalCliques: number[][] = [];

  for (let i = 0; i < sources.length; i++) {
    const neighbors = new Set<number>();
    for (let j = 0; j < sources.length; j++) {
      if (i !== j && pricesAgreeWithinBps(sources[i]!.price, sources[j]!.price, thresholdBps)) {
        neighbors.add(j);
      }
    }
    neighborMap.set(i, neighbors);
  }

  bronKerbosch([], new Set(sources.map((_, index) => index)), new Set<number>(), neighborMap, maximalCliques);

  if (maximalCliques.length === 0) {
    return sources.map((source) => [source]);
  }

  return maximalCliques.map((clique) => clique.map((index) => sources[index]!));
}

function bronKerbosch(
  clique: number[],
  candidates: Set<number>,
  excluded: Set<number>,
  neighbors: Map<number, Set<number>>,
  output: number[][],
): void {
  if (candidates.size === 0 && excluded.size === 0) {
    output.push([...clique]);
    return;
  }

  const pivot = choosePivot(candidates, excluded, neighbors);
  const pivotNeighbors = pivot == null ? new Set<number>() : (neighbors.get(pivot) ?? new Set<number>());
  const branchCandidates = [...candidates].filter((candidate) => !pivotNeighbors.has(candidate));

  for (const candidate of branchCandidates) {
    const candidateNeighbors = neighbors.get(candidate) ?? new Set<number>();
    bronKerbosch(
      [...clique, candidate],
      intersectSets(candidates, candidateNeighbors),
      intersectSets(excluded, candidateNeighbors),
      neighbors,
      output,
    );
    candidates.delete(candidate);
    excluded.add(candidate);
  }
}

function choosePivot(
  candidates: Set<number>,
  excluded: Set<number>,
  neighbors: Map<number, Set<number>>,
): number | null {
  let best: number | null = null;
  let bestDegree = -1;
  for (const node of [...candidates, ...excluded]) {
    const degree = neighbors.get(node)?.size ?? 0;
    if (degree > bestDegree) {
      best = node;
      bestDegree = degree;
    }
  }
  return best;
}

function intersectSets(left: Set<number>, right: Set<number>): Set<number> {
  const result = new Set<number>();
  for (const value of left) {
    if (right.has(value)) result.add(value);
  }
  return result;
}

function buildSourceLabel(cluster: SourcePrice[]): string {
  return cluster
    .map((s) => s.source)
    .sort()
    .join("+");
}

function medianPrice(cluster: SourcePrice[]): number {
  return median(cluster.map((source) => source.price)) ?? 0;
}

function clusterTotalWeight(cluster: SourcePrice[]): number {
  return cluster.reduce((sum, source) => sum + source.weight, 0);
}

function clusterSpreadBps(cluster: SourcePrice[]): number {
  if (cluster.length <= 1) return 0;
  const prices = cluster.map((source) => source.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  return midDivergenceBps(minPrice, maxPrice);
}

/**
 * Ranks a cluster by its strongest trust tier. Higher rank wins the tiebreak.
 * - 2: any member is hard_market, hard_oracle, or hard_protocol
 * - 0: all members are soft_aggregator or soft_dex
 * - 1: mixed (e.g. fallback_search only, or soft + fallback_search)
 */
function clusterTierRank(cluster: SourcePrice[]): number {
  const tiers = cluster.map((m) => getPricingSourceRegistryEntry(m.source)?.trustTier ?? "soft_aggregator");
  const anyHard = tiers.some(isHardPricingTrustTier);
  const allSoft = tiers.every((t) => t === "soft_aggregator" || t === "soft_dex");
  return anyHard ? 2 : allSoft ? 0 : 1;
}

/**
 * Selects the winning cluster from all maximal cliques by a priority cascade:
 * largest size → highest total weight → strongest trust tier → tightest price
 * spread → closest median to `pegRef` → alphabetical source label tiebreak.
 *
 * @param clusters - All maximal agreement cliques found by Bron-Kerbosch.
 * @param pegRef - The expected peg price used as a proximity tiebreaker.
 * @returns The single best cluster of sources to use for consensus.
 */
function pickBestCluster(clusters: SourcePrice[][], pegRef: number | null): SourcePrice[] {
  return clusters.reduce((best, candidate) => {
    if (candidate.length !== best.length) {
      return candidate.length > best.length ? candidate : best;
    }

    const candidateWeight = clusterTotalWeight(candidate);
    const bestWeight = clusterTotalWeight(best);
    if (candidateWeight !== bestWeight) {
      return candidateWeight > bestWeight ? candidate : best;
    }

    const candidateTierRank = clusterTierRank(candidate);
    const bestTierRank = clusterTierRank(best);
    if (candidateTierRank !== bestTierRank) {
      return candidateTierRank > bestTierRank ? candidate : best;
    }

    const candidateSpread = clusterSpreadBps(candidate);
    const bestSpread = clusterSpreadBps(best);
    if (candidateSpread !== bestSpread) {
      return candidateSpread < bestSpread ? candidate : best;
    }

    if (pegRef != null && pegRef > 0) {
      const candidateDistance = Math.abs(medianPrice(candidate) - pegRef);
      const bestDistance = Math.abs(medianPrice(best) - pegRef);
      if (candidateDistance !== bestDistance) {
        return candidateDistance < bestDistance ? candidate : best;
      }
    }

    return buildSourceLabel(candidate).localeCompare(buildSourceLabel(best)) < 0 ? candidate : best;
  });
}

const TRUST_TIER_PRIORITY = {
  hard_oracle: 0,
  hard_market: 1,
  hard_protocol: 2,
  soft_aggregator: 3,
  soft_dex: 4,
  fallback_search: 5,
  cached_replay: 6,
} as const;

function getSourceTrustPriority(source: string): number {
  const trustTier = getPricingSourceRegistryEntry(source)?.trustTier;
  if (!trustTier) return Number.MAX_SAFE_INTEGER;
  return TRUST_TIER_PRIORITY[trustTier];
}

function pickBestClusterSource(cluster: SourcePrice[], ref: number): SourcePrice {
  return cluster.reduce((best, candidate) => {
    if (candidate.weight !== best.weight) {
      return candidate.weight > best.weight ? candidate : best;
    }
    const candidateTrust = getSourceTrustPriority(candidate.source);
    const bestTrust = getSourceTrustPriority(best.source);
    if (candidateTrust !== bestTrust) {
      return candidateTrust < bestTrust ? candidate : best;
    }
    const candidateDistance = Math.abs(candidate.price - ref);
    const bestDistance = Math.abs(best.price - ref);
    if (candidateDistance !== bestDistance) {
      return candidateDistance < bestDistance ? candidate : best;
    }
    return candidate.source.localeCompare(best.source) < 0 ? candidate : best;
  });
}

function pickLowConfidenceSource(cluster: SourcePrice[], ref: number): SourcePrice {
  return cluster.reduce((best, candidate) => {
    const candidateTrust = getSourceTrustPriority(candidate.source);
    const bestTrust = getSourceTrustPriority(best.source);
    if (candidateTrust !== bestTrust) {
      return candidateTrust < bestTrust ? candidate : best;
    }
    const candidateDistance = Math.abs(candidate.price - ref);
    const bestDistance = Math.abs(best.price - ref);
    if (candidateDistance !== bestDistance) {
      return candidateDistance < bestDistance ? candidate : best;
    }
    if (candidate.weight !== best.weight) {
      return candidate.weight > best.weight ? candidate : best;
    }
    return candidate.source.localeCompare(best.source) < 0 ? candidate : best;
  });
}
