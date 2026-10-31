import catalog from "@shared/data/safety-score-v9/lane-emitter-descriptors-v1.generated.json";
import { adaptLaneEmitterCatalog } from "@shared/lib/safety-score-v9/lane-screening-derivation";

/**
 * Loads the shipped reviewed descriptor catalog through the runtime-neutral
 * adapter. The pure admission and screening-set derivation live in
 * `shared/lib/safety-score-v9/lane-screening-derivation.ts`, so decoding the
 * catalog adds no Worker RPC modules to the offline scoring candidate.
 */
export function loadReviewedLaneEmitterCatalog() {
  return adaptLaneEmitterCatalog(catalog.descriptors);
}
