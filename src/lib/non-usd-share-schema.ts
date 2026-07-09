import type { NonUsdSharePoint } from "@/lib/non-usd-share-types";
import { z, type ZodType } from "zod";

export const NonUsdSharePointSchema: ZodType<NonUsdSharePoint> = z.object({
  date: z.number(),
  commodityShare: z.number().nullable(),
  fiatNonUsdShare: z.number().nullable(),
  commodity: z.number().nullable(),
  fiatNonUsd: z.number().nullable(),
  total: z.number(),
});

export const NonUsdShareResponseSchema: ZodType<NonUsdSharePoint[]> = z.array(NonUsdSharePointSchema);
