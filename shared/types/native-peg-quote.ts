import { z } from "zod";

/** A directly observed native-denominated market quote, never an FX-derived mark. */
export const PersistedNativePegQuoteSchema = z.object({
  value: z.number().finite().positive(),
  observedAt: z.number().finite().positive(),
  source: z.literal("coingecko"),
});

export type PersistedNativePegQuote = z.output<typeof PersistedNativePegQuoteSchema>;
