import { z } from "zod";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BASE_INPUT_GENERATION_ID_PATTERN = /^report-cards-input:v1:[a-f0-9]{64}$/u;
const STRICT_ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/** Non-empty canonical text. Surrounding whitespace is rejected, never normalized. */
export const CanonicalTextSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, "Value must not have leading or trailing whitespace");

export const Sha256Schema = z.string().regex(SHA256_PATTERN);
export const BaseInputGenerationIdSchema = z.string().regex(BASE_INPUT_GENERATION_ID_PATTERN);
export const UnixSecondsSchema = z.number().int().nonnegative();
export const FractionSchema = z.number().finite().min(0).max(1);
export const StrictIsoDateSchema = z.string().refine((value) => {
  if (!STRICT_ISO_DATE_PATTERN.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}, "Expected a valid ISO calendar date (YYYY-MM-DD)");

/** Strict versioned envelope for authored collections with unique item keys. */
export function uniqueKeyedCollectionSchema<
  ItemSchema extends z.ZodType<{ assetId: string }>,
  CollectionKey extends string,
  NoteSchema extends z.ZodType,
>(options: {
  itemSchema: ItemSchema; collectionKey: CollectionKey; duplicateMessage: string; noteSchema: NoteSchema;
}) {
  const { itemSchema, collectionKey, duplicateMessage, noteSchema } = options;
  const collectionSchema = z.array(itemSchema).superRefine((items, ctx) => {
    const keys = items.map((item) => item.assetId);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: "custom", message: duplicateMessage });
    }
  });
  const shape = {
    schemaVersion: z.literal(1),
    note: noteSchema,
    [collectionKey]: collectionSchema,
  } as { schemaVersion: z.ZodLiteral<1>; note: NoteSchema }
    & Record<CollectionKey, typeof collectionSchema>;

  return z.object(shape).strict();
}
