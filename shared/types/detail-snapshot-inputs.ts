import { z } from "zod";
import { StablecoinLiveSummarySchema } from "./stablecoin-live-summary";
import { SupplyHistoryResponseSchema } from "./market";
// Wire-contract batch bound; producers and consumers import this same authority.
export const DETAIL_SNAPSHOT_INPUT_BATCH_SIZE = 10;

const SourceClockSchema = z.number().finite().nonnegative().nullable();
const SourcesSchema = z.object({
  detailCacheUpdatedAt: SourceClockSchema,
  publicationUpdatedAt: SourceClockSchema,
  supplySnapshotUpdatedAt: SourceClockSchema,
  supplySnapshotDate: SourceClockSchema,
});
const FreshnessSchema = z.object({
  status: z.enum(["fresh", "stale"]),
  maxAgeSec: z.number().finite().positive(),
});
const DetailSnapshotInputEntrySchema = z.discriminatedUnion("status", [
  z.object({
    id: z.string().min(1),
    status: z.literal("available"),
    liveSummary: StablecoinLiveSummarySchema,
    supplyHistory: SupplyHistoryResponseSchema,
    // Lane clocks are milliseconds, exactly as in generated snapshot envelopes.
    updatedAt: z.object({ liveSummary: z.number().finite().nonnegative(), supplyHistory: z.number().finite().nonnegative() }),
    freshness: z.object({ liveSummary: FreshnessSchema, supplyHistory: FreshnessSchema }),
    // Raw cache/publication clocks are seconds; provenance does not imply freshness.
    sources: SourcesSchema,
  }),
  z.object({
    id: z.string().min(1),
    status: z.literal("unavailable"),
    reason: z.enum(["unknown-id", "detail-cache-missing", "detail-cache-invalid-clock", "detail-cache-too-old", "publication-unavailable", "supply-marker-missing", "invalid-cache-input", "entry-too-large", "cache-read-failed"]),
    sources: SourcesSchema,
  }),
]);
export type DetailSnapshotInputEntry = z.infer<typeof DetailSnapshotInputEntrySchema>;
export const DetailSnapshotInputsResponseSchema = z.object({
  version: z.literal(1),
  entries: z.array(DetailSnapshotInputEntrySchema).min(1).max(DETAIL_SNAPSHOT_INPUT_BATCH_SIZE),
});
