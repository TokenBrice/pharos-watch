import { z } from "zod";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { getCache } from "../db-cache";
import { parseJson } from "../json-parse";
import { SAFETY_SCORE_V9_CACHE_KEYS } from "./publication-health";

const V9QuarantineMessageSchema = z.string().min(1).max(500);
const V9AssetQuarantineCodeSchema = z.enum([
  "fact-build-failed",
  "fact-validation-failed",
  "evaluation-failed",
]);
const V9AssetQuarantineSchema = z
  .object({
    assetId: z.string().min(1),
    code: V9AssetQuarantineCodeSchema,
    message: V9QuarantineMessageSchema,
  })
  .strict();
// Records persisted before quarantine causes were recorded lack `message`.
// They stay readable (the failed-attempt key may never be rewritten) and are
// normalized to V9PublicationAttempt with this placeholder.
const LEGACY_QUARANTINE_MESSAGE = "cause not recorded (legacy record)";
const V9StoredAssetQuarantineSchema = z
  .object({
    assetId: z.string().min(1),
    code: V9AssetQuarantineCodeSchema,
    message: V9QuarantineMessageSchema.optional(),
  })
  .strict();
const V9PublicationPhaseElapsedMsSchema = z.object({
  enrichment: z.number().nonnegative().nullable(),
  baselineLoad: z.number().nonnegative().nullable(),
  compile: z.number().nonnegative().nullable(),
  assess: z.number().nonnegative().nullable(),
  serialize: z.number().nonnegative().nullable(),
  persist: z.number().nonnegative().nullable(),
  journal: z.number().nonnegative().nullable(),
  archive: z.number().nonnegative().nullable(),
}).strict();
export type V9PublicationPhaseElapsedMs = z.infer<typeof V9PublicationPhaseElapsedMsSchema>;
const V9PublicationAbortCauseSchema = z.object({
  source: z.enum(["caller", "publication-deadline"]),
  name: z.string().min(1).max(80),
  message: z.string().max(500),
}).strict();
export type V9PublicationAbortCause = z.infer<typeof V9PublicationAbortCauseSchema>;

const V9PublicationAttemptFailureSchema = z
  .object({
    stage: z.enum([
      "base-input",
      "v9-enrichment",
      "compile",
      "publication-gate",
      "publication-write",
      "assess",
      "serialize",
      "journal",
      "archive",
      "alert-envelope",
      "aborted",
    ]),
    code: z.string().min(1).max(160),
    message: z.string().min(1).max(500),
    phaseElapsedMs: V9PublicationPhaseElapsedMsSchema.optional(),
    phaseTimingBasis: z.literal("workers-io-boundary-attributed").optional(),
    abortCause: V9PublicationAbortCauseSchema.nullable().optional(),
  })
  .strict();

function buildPublicationAttemptSchema<
  Q extends z.ZodType<{ assetId: string }>,
>(quarantineSchema: Q) {
  return z
    .object({
      schemaVersion: z.literal(1),
      attemptedAtSec: z.number().int().nonnegative(),
      outcome: z.enum([
        "published-clean",
        "published-partial",
        "held",
        "failed",
      ]),
      publicationGenerationId: z.string().min(1).nullable(),
      quarantines: z.array(quarantineSchema),
      affectedAssetIds: z.array(z.string().min(1)),
      failure: V9PublicationAttemptFailureSchema.optional(),
    })
    .strict()
    .superRefine((attempt, ctx) => {
      for (const [path, ids] of [
        [
          "quarantines",
          attempt.quarantines.map((quarantine) => quarantine.assetId),
        ],
        ["affectedAssetIds", attempt.affectedAssetIds],
      ] as const) {
        if (
          new Set(ids).size !== ids.length ||
          ids.some(
            (assetId, index) =>
              index > 0 && ids[index - 1]! >= assetId,
          )
        ) {
          ctx.addIssue({
            code: "custom",
            path: [path],
            message: `${path} must be unique and sorted`,
          });
        }
      }
      const affected = new Set(attempt.affectedAssetIds);
      if (
        attempt.quarantines.some(
          (quarantine) => !affected.has(quarantine.assetId),
        )
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["affectedAssetIds"],
          message: "Affected assets must include every quarantine",
        });
      }
      const published = attempt.outcome.startsWith("published-");
      if (published !== (attempt.publicationGenerationId !== null)) {
        ctx.addIssue({
          code: "custom",
          path: ["publicationGenerationId"],
          message:
            "Only published attempts carry a publication generation",
        });
      }
      if (
        attempt.outcome === "published-clean" &&
        (attempt.quarantines.length > 0 ||
          attempt.affectedAssetIds.length > 0)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["outcome"],
          message: "A clean publication cannot carry affected assets",
        });
      }
      if (
        attempt.outcome === "published-partial" &&
        attempt.affectedAssetIds.length === 0
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["affectedAssetIds"],
          message: "A partial publication requires affected assets",
        });
      }
      if ((attempt.outcome === "failed") !== (attempt.failure !== undefined)) {
        ctx.addIssue({
          code: "custom",
          path: ["failure"],
          message: "Only failed attempts must carry failure metadata",
        });
      }
    });
}
export const V9PublicationAttemptSchema = buildPublicationAttemptSchema(
  V9AssetQuarantineSchema,
);
const V9StoredPublicationAttemptSchema = buildPublicationAttemptSchema(
  V9StoredAssetQuarantineSchema,
);
export type V9PublicationAttempt = z.infer<
  typeof V9PublicationAttemptSchema
>;

function parseCanonicalJson<T>(
  raw: string,
  schema: z.ZodType<T>,
  label: string,
): T {
  const parsed = parseJson(raw);
  if (!parsed.ok) throw new Error(`Malformed ${label} JSON: ${parsed.message}`);
  const value = schema.parse(parsed.value);
  if (stableJsonStringifyV1(value) !== raw) {
    throw new Error(`${label} JSON is not canonical`);
  }
  return value;
}


async function loadSafetyScoreV9PublicationAttemptAtKey(
  db: D1Database,
  key: string,
  signal?: AbortSignal,
): Promise<V9PublicationAttempt | null> {
  const row = await getCache(db, key, signal);
  if (!row) return null;
  const stored = parseCanonicalJson(
    row.value,
    V9StoredPublicationAttemptSchema,
    "Safety Score v9 publication attempt",
  );
  if (row.updatedAt !== stored.attemptedAtSec) {
    throw new Error(
      "Safety Score v9 publication attempt cache timestamp mismatch",
    );
  }
  const attempt: V9PublicationAttempt = {
    ...stored,
    quarantines: stored.quarantines.map((quarantine) => ({
      ...quarantine,
      message: quarantine.message ?? LEGACY_QUARANTINE_MESSAGE,
    })),
  };
  return attempt;
}

export async function loadSafetyScoreV9PublicationAttempt(
  db: D1Database,
  signal?: AbortSignal,
): Promise<V9PublicationAttempt | null> {
  return loadSafetyScoreV9PublicationAttemptAtKey(
    db,
    SAFETY_SCORE_V9_CACHE_KEYS.publicationAttempt,
    signal,
  );
}

export async function loadSafetyScoreV9FailedPublicationAttempt(
  db: D1Database,
  signal?: AbortSignal,
): Promise<V9PublicationAttempt | null> {
  return loadSafetyScoreV9PublicationAttemptAtKey(
    db,
    SAFETY_SCORE_V9_CACHE_KEYS.failedPublicationAttempt,
    signal,
  );
}
