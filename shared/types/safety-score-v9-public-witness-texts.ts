import { z } from "zod";

export const V9PublicWitnessTextEntrySchema = z.union([
  z.string().min(1),
  z.tuple([z.number().int().nonnegative(), z.number().int().refine((length) => length !== 0), z.string()]),
]);
export type V9PublicWitnessTextEntry = z.output<typeof V9PublicWitnessTextEntrySchema>;
export const V9PublicWitnessTextTableSchema = z.array(V9PublicWitnessTextEntrySchema).min(1).describe(
  "Card-local witness texts, unique and sorted after resolution. Each entry is a literal string or [earlierEntryRef, sliceLengthUtf16, literalRemainder]. Positive lengths append the remainder to the earlier text prefix; negative lengths prepend it to the earlier text suffix. message, path, field, label, controlKey, posture and plain-text cap/deployment/coverage reason values beginning with ~ are base-36 references into this table; resolve before display or comparison. Literal leading ~ values use the table.",
);
export interface V9PublicWitnessTextTable { witnessTexts?: readonly V9PublicWitnessTextEntry[] }
