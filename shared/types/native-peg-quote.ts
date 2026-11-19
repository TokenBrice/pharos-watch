import { z } from "zod";
import { CanonicalTextSchema, UnixSecondsSchema } from "./safety-schema-primitives";

export const QuoteDerivationSchema = z.object({
  kind: z.enum(["traded-pair", "conversion", "unknown"]),
  lineage: z.object({
    venue: CanonicalTextSchema.optional(),
    pair: CanonicalTextSchema.optional(),
    fxSource: CanonicalTextSchema.optional(),
    fxObservedAtSec: UnixSecondsSchema.optional(),
  }),
});
export type QuoteDerivation = z.infer<typeof QuoteDerivationSchema>;

/** A cached native-denominated quote with lineage when the producer records it. */
export const PersistedNativePegQuoteSchema = z.object({
  value: z.number().finite().positive(),
  observedAt: z.number().finite().positive(),
  source: z.literal("coingecko"),
  derivation: QuoteDerivationSchema.optional(),
});

export type PersistedNativePegQuote = z.output<typeof PersistedNativePegQuoteSchema>;
