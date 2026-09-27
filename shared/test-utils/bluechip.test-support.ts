import type { BluechipRating } from "../types/market";

export function makeUnreportedBluechipRating(): BluechipRating {
  return {
    grade: "A",
    slug: "tether",
    lastObservedAt: null,
    observationState: "unknown",
    observationReason: "legacy-observation-unknown",
    collateralization: null,
    smartContractAudit: null,
    dateOfRating: null,
    dateLastChange: null,
    smidge: {
      stability: null,
      management: null,
      implementation: null,
      decentralization: null,
      governance: null,
      externals: null,
    },
  };
}
