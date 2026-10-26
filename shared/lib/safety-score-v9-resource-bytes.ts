import { z } from "zod";
import { stableJsonStringifyChunksV1 } from "./stable-json";
import { SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_UNCOMPRESSED_BYTES } from "./safety-score-v9-publication-limits";

// Calibrated card-unit regression bound: measured maximum 85,123 B plus
// ceil(25%) = 21,281 B of detail-growth headroom, not a heap/value-size limit.
export const RESOURCE_PUBLICATION_CARD_UNIT_MAX_BYTES = 106_404;
// Preserve 958a14c's aggregate relative headroom (7,100,000 / 7,029,184):
// ceil10KB(8,158,138 * 7,100,000 / 7,029,184) = 8,250,000 B.
// This early regression ceiling stays below the independent 9.2 MB hard cap.
export const RESOURCE_PUBLICATION_STREAMED_TOTAL_REGRESSION_MAX_BYTES = 8_250_000;

export const PublicationByteMetricsSchema = z.object({
  unit: z.literal("card"), units: z.number().int().positive(),
  largestUnitBytes: z.number().int().positive().max(RESOURCE_PUBLICATION_CARD_UNIT_MAX_BYTES),
  unitLimitBytes: z.literal(RESOURCE_PUBLICATION_CARD_UNIT_MAX_BYTES),
  streamedTotalBytes: z.number().int().positive().max(RESOURCE_PUBLICATION_STREAMED_TOTAL_REGRESSION_MAX_BYTES),
  streamedTotalRegressionLimitBytes: z.literal(RESOURCE_PUBLICATION_STREAMED_TOTAL_REGRESSION_MAX_BYTES),
  streamedTotalLimitBytes: z.literal(SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_UNCOMPRESSED_BYTES),
}).refine((value) => value.largestUnitBytes <= value.streamedTotalBytes, "card unit exceeds streamed total");

export function measurePublicationByteBudget(publication: { cards: readonly { id: string }[] }, streamedTotalBytes: number) {
  let largestUnitBytes = 0;
  for (const card of publication.cards) {
    let bytes = 0;
    for (const chunk of stableJsonStringifyChunksV1(card)) {
      bytes += chunk.length;
      // Canonical JSON escapes lone surrogates; UTF-16 pairs therefore always
      // represent one four-byte UTF-8 code point. No Node/DOM byte API or copy.
      for (let index = 0; index < chunk.length; index += 1) {
        const code = chunk.charCodeAt(index);
        if (code < 0x80) continue;
        bytes += code < 0x800 ? 1 : 2;
        if (code >= 0xd800 && code <= 0xdbff) index += 1;
      }
    }
    if (bytes > RESOURCE_PUBLICATION_CARD_UNIT_MAX_BYTES) throw new Error(`synthetic-publication-card-unit-byte-budget:${card.id}`);
    largestUnitBytes = Math.max(largestUnitBytes, bytes);
  }
  return PublicationByteMetricsSchema.parse({ unit: "card", units: publication.cards.length, largestUnitBytes,
    unitLimitBytes: RESOURCE_PUBLICATION_CARD_UNIT_MAX_BYTES, streamedTotalBytes,
    streamedTotalRegressionLimitBytes: RESOURCE_PUBLICATION_STREAMED_TOTAL_REGRESSION_MAX_BYTES,
    streamedTotalLimitBytes: SAFETY_SCORE_V9_PUBLICATION_MAX_WRITE_UNCOMPRESSED_BYTES });
}
