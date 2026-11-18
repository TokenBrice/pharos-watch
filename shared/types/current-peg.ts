import { z } from "zod";
import { PegSummaryCoinSchema } from "./peg";

/** Current fields travel with the list quote; omitted only on pre-cutover publications. */
export const CurrentPegSchema = PegSummaryCoinSchema.pick({
  currentDeviationBps: true, pegReference: true, pegReferenceUnavailable: true,
  currentPriceUnavailable: true, primaryTrust: true, dexPriceCheck: true,
}).required().extend({
  ...PegSummaryCoinSchema.pick({ referenceAdmission: true, admittedDeviationBps: true }).shape,
  /** This comparison uses a verified legacy peg in a mixed FX publication. */
  legacyFxReference: z.literal(true).optional(),
  /** Exclusive Unix-second expiry under the producer's DEX UI evidence budget; absent on older blocks. */
  dexPriceCheckExpiresAt: z.number().finite().positive().nullable().optional(),
});
export type CurrentPeg = z.infer<typeof CurrentPegSchema>;
