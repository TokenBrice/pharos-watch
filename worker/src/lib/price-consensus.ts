import type { PriceConfidence } from "@shared/types";

export interface SourcePrice {
  source: string;
  price: number;
  weight: number;
  metadata?: Record<string, unknown>;
}

export interface ConsensusResult {
  price: number;
  source: string;
  confidence: PriceConfidence;
  agreeSources: string[];
  disagreeSources: string[];
  allPrices: Record<string, number>;
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
 * 5. If no majority → low confidence, pick source closest to `pegRef` (or highest-weight if NAV).
 */
export function computePriceConsensus(
  sources: SourcePrice[],
  pegRef: number | null,
  thresholdBps: number,
): ConsensusResult | null {
  if (sources.length === 0) return null;

  const allPrices: Record<string, number> = {};
  for (const s of sources) allPrices[s.source] = s.price;

  if (sources.length === 1) {
    const s = sources[0];
    return {
      price: s.price,
      source: s.source,
      confidence: "single-source",
      agreeSources: [s.source],
      disagreeSources: [],
      allPrices,
    };
  }

  // For NAV tokens (pegRef === null), there's no peg to validate against.
  // 2+ sources is high confidence; pick highest-weight.
  if (pegRef === null || pegRef <= 0) {
    const chosen = sources.reduce((a, b) => a.weight >= b.weight ? a : b);
    return {
      price: chosen.price,
      source: chosen.source,
      confidence: "high",
      agreeSources: sources.map((s) => s.source),
      disagreeSources: [],
      allPrices,
    };
  }

  // Find largest agreeing cluster (pairwise within threshold)
  const clusters = findAgreementClusters(sources, thresholdBps);
  const bestCluster = clusters.reduce((a, b) => a.length >= b.length ? a : b, []);

  const clusterSet = new Set(bestCluster.map((s) => s.source));
  const disagreeSources = sources.filter((s) => !clusterSet.has(s.source)).map((s) => s.source);

  if (bestCluster.length >= 2) {
    // Majority agreement — high confidence
    const chosen = bestCluster.reduce((a, b) => a.weight >= b.weight ? a : b);
    return {
      price: chosen.price,
      source: buildSourceLabel(bestCluster),
      confidence: "high",
      agreeSources: bestCluster.map((s) => s.source),
      disagreeSources,
      allPrices,
    };
  }

  // Pick source closest to peg reference
  const chosen = sources.reduce((a, b) =>
    Math.abs(a.price - pegRef) <= Math.abs(b.price - pegRef) ? a : b,
  );
  return {
    price: chosen.price,
    source: chosen.source,
    confidence: "low",
    agreeSources: [chosen.source],
    disagreeSources: sources.filter((s) => s !== chosen).map((s) => s.source),
    allPrices,
  };
}

function findAgreementClusters(sources: SourcePrice[], thresholdBps: number): SourcePrice[][] {
  const clusters: SourcePrice[][] = [];
  for (const anchor of sources) {
    const cluster = sources.filter((s) => {
      if (s === anchor) return true;
      const mid = (anchor.price + s.price) / 2;
      if (mid <= 0) return false;
      return (Math.abs(anchor.price - s.price) / mid) * 10000 <= thresholdBps;
    });
    clusters.push(cluster);
  }
  return clusters;
}

function buildSourceLabel(cluster: SourcePrice[]): string {
  const names = cluster.map((s) => s.source).sort();
  if (names.length <= 2) return names.join("+");
  return `${names[0]}+${names.length - 1}more`;
}
