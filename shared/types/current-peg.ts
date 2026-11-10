import { z } from "zod";
import { PegSummaryCoinSchema } from "./peg";

/** Current fields travel with the list quote; omitted only on pre-cutover publications. */
export const CurrentPegSchema = PegSummaryCoinSchema.pick({
  currentDeviationBps: true, pegReference: true, pegReferenceUnavailable: true,
  currentPriceUnavailable: true, primaryTrust: true, dexPriceCheck: true,
}).required();
export type CurrentPeg = z.infer<typeof CurrentPegSchema>;
