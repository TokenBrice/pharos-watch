import type { DexPriceObs } from "../types";

export function mergeDexPriceObservationMap(
  target: Map<string, DexPriceObs[]>,
  source: Map<string, DexPriceObs[]>,
): void {
  for (const [id, observations] of source) {
    const existing = target.get(id) ?? [];
    existing.push(...observations);
    target.set(id, existing);
  }
}
