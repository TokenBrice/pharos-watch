import { z } from "zod";

/** Generation/time identify the transported row; totalCount retains the full dataset census.
 * Legacy evidence keeps a null generation rather than deriving identity from its clock. */
export const CoinProjectionMetadataSchema = z.object({
  stablecoinId: z.string().min(1),
  generationId: z.string().nullable(),
  updatedAt: z.number().nonnegative().nullable(),
  totalCount: z.number().int().nonnegative(),
  unavailableReason: z.enum(["row-not-published", "invalid-coverage-evidence"]).nullable(),
});
