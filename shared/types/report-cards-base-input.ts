import { z } from "zod";
import { compareText } from "./safety-score-v9-fact-primitives";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const NonEmptyCanonicalStringSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, "Value must not have leading or trailing whitespace");

const CanonicalStringSetSchema = z
  .array(NonEmptyCanonicalStringSchema)
  .transform((values) => [...new Set(values)].sort(compareText));

const ProducerMethodologyVersionSetSchema = CanonicalStringSetSchema.pipe(
  z.array(NonEmptyCanonicalStringSchema).min(1, "At least one producer methodology version is required"),
);

const ProducerMethodologyVersionsSchema = z
  .object({
    dexLiquidity: ProducerMethodologyVersionSetSchema,
    pegScore: ProducerMethodologyVersionSetSchema,
    redemptionBackstop: ProducerMethodologyVersionSetSchema,
  })
  .strict();

const ProducerIdentitySchema = z
  .object({
    generationId: NonEmptyCanonicalStringSchema,
    payloadSha256: Sha256Schema,
  })
  .strict();

/** Model-neutral identity projection for one report-card input capture. */
export const ReportCardsBaseInputIdentityV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    captureKind: z.enum(["exact-publication-inputs", "public-reconstruction"]),
    publicationClockSec: z.number().int().nonnegative(),
    sourceUpdatedAtSec: z.number().int().nonnegative(),
    registry: z
      .object({
        activeAssetIds: CanonicalStringSetSchema.pipe(z.array(NonEmptyCanonicalStringSchema).min(1)),
        fingerprintSha256: Sha256Schema,
      })
      .strict(),
    producers: z
      .object({
        dex: ProducerIdentitySchema,
        redemption: ProducerIdentitySchema,
      })
      .strict(),
    producerMethodologyVersions: ProducerMethodologyVersionsSchema,
    normalizedSnapshotDigests: z
      .object({
        scoreBearingFactsSha256: Sha256Schema,
        scoreBearingFreshnessSha256: Sha256Schema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.sourceUpdatedAtSec > value.publicationClockSec) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceUpdatedAtSec"],
        message: "Source updatedAt cannot be later than the publication clock",
      });
    }
  });

export type ReportCardsBaseInputIdentityV1 = z.infer<typeof ReportCardsBaseInputIdentityV1Schema>;
