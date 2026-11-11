import { weightedMedian } from "@shared/lib/stats";

export interface WeightedPricePoint {
  price: number;
  weight: number;
}

export interface ProtocolPriceObservation {
  protocol: string;
  price: number;
  tvl: number;
  chain?: string;
  observedAt?: number;
  poolAddress?: string;
  side?: "base" | "quote";
}

export interface AggregatedProtocolPrice {
  protocol: string;
  price: number;
  tvl: number;
  chain: string;
  observedAt: number | null;
  representativePoolAddress: string | null;
  representativeSide: "base" | "quote" | null;
}

/**
 * Weight-aware median of a discrete price distribution. Points are sorted
 * ascending by price and the first point whose cumulative weight reaches or
 * exceeds half the total weight is returned.
 *
 * Discrete lower-median semantics: the boundary uses `>= halfWeight`, so at an
 * exact 50% crossing the *lower* of the two straddling prices is returned, not
 * an interpolated midpoint. With exactly two equal-weight observations this
 * always yields the lower price (a slight, systematic downward bias on that
 * case). This is intentional — no interpolation across discrete protocol/TVL
 * observations — so callers (e.g. the GeckoTerminal price probe) should treat
 * the result as a representative observed price, not a synthesised average.
 */
export function computeWeightedMedianPrice(points: WeightedPricePoint[]): number | null {
  const validPoints = points
    .filter((point) => (
      Number.isFinite(point.price) &&
      point.price > 0 &&
      Number.isFinite(point.weight) &&
      point.weight > 0
    ));
  return weightedMedian(validPoints.map((point) => ({ value: point.price, weight: point.weight })));
}

export function aggregateProtocolPrices(
  observations: ProtocolPriceObservation[],
): AggregatedProtocolPrice[] {
  const byProtocol = new Map<string, ProtocolPriceObservation[]>();

  for (const observation of observations) {
    if (!Number.isFinite(observation.price) || observation.price <= 0) continue;
    if (!Number.isFinite(observation.tvl) || observation.tvl <= 0) continue;
    const existing = byProtocol.get(observation.protocol) ?? [];
    existing.push(observation);
    byProtocol.set(observation.protocol, existing);
  }

  return [...byProtocol.entries()]
    .map(([protocol, protocolObservations]) => {
      const aggregatedPrice = computeWeightedMedianPrice(
        protocolObservations.map((observation) => ({
          price: observation.price,
          weight: observation.tvl,
        })),
      );
      if (aggregatedPrice == null) return null;

      const totalTvl = protocolObservations.reduce((sum, observation) => sum + observation.tvl, 0);
      const representativeObservation = [...protocolObservations]
        .sort((left, right) => right.tvl - left.tvl || left.price - right.price)[0];
      const chains = [...new Set(protocolObservations.map((observation) => observation.chain).filter(Boolean))];
      const observedAts = protocolObservations
        .map((observation) => observation.observedAt)
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

      return {
        protocol,
        price: aggregatedPrice,
        tvl: totalTvl,
        chain: chains.length === 1 ? chains[0]! : "multi",
        observedAt: observedAts.length > 0 ? Math.min(...observedAts) : null,
        representativePoolAddress: representativeObservation?.poolAddress ?? null,
        representativeSide: representativeObservation?.side ?? null,
      } satisfies AggregatedProtocolPrice;
    })
    .filter((entry): entry is AggregatedProtocolPrice => entry != null)
    .sort((left, right) => right.tvl - left.tvl || left.protocol.localeCompare(right.protocol));
}
