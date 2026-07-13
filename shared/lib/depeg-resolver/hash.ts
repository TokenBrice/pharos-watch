import { sha256Hex } from "../sha256";
import { stableJsonStringifyV1 } from "../stable-json";

export { stableJsonStringifyV1 } from "../stable-json";

export const DDR_HASH_DOMAINS = {
  publicPrediction: "ddr.public_prediction.prediction.v1",
  publicNoCall: "ddr.public_prediction.no_call.v1",
  publicationManifest: "ddr.publication_manifest.v1",
  publicPredictionIds: "ddr.public_prediction_ids.v1",
  ddrrReviewSnapshot: "ddrr.review_snapshot.v2",
} as const;

export type DdrHashDomain = (typeof DDR_HASH_DOMAINS)[keyof typeof DDR_HASH_DOMAINS];

export function stableJsonHashV1(domain: string, payload: unknown): string {
  if (!Object.values(DDR_HASH_DOMAINS).includes(domain as DdrHashDomain)) {
    throw new Error(`Unsupported DDR hash domain: ${domain}`);
  }
  return sha256Hex(stableJsonStringifyV1({ domain, payload }));
}
