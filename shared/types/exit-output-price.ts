import { z } from "zod";

/** Exact current USD prices admitted by the capture producer for Exit outputs.
 * These are observations, never a peg/parity or executable-conversion claim. */
export const ExitOutputPriceObservationSchema = z.strictObject({
  priceUsd: z.number().finite().positive(),
  sourceId: z.string().min(1),
  observedAtSec: z.number().int().positive(),
  confidence: z.enum(["high", "medium"]),
  admission: z.enum(["authoritative", "multi-source", "guarded-nav"]),
});

export type ExitOutputPriceObservation = z.infer<typeof ExitOutputPriceObservationSchema>;
