import { z } from "zod";

import { DecimalSourceSchema, JsonNumberDecimalSourceSchema } from "./decimal";

export const FALCON_TRANSPARENCY_URL = "https://api.falcon.finance/api/v1/transparency";

const FalconAssetRowSchema = z
  .object({ label: z.string().trim().min(1) })
  .loose()
  .transform((row, context) => {
    const normalized: Record<string, string> = { label: row.label };
    const amountEntries = Object.entries(row).filter(([key]) => key !== "label");
    if (amountEntries.length === 0) {
      context.addIssue({ code: "custom", message: `Falcon asset ${row.label} has no custody values` });
      return z.NEVER;
    }
    for (const [key, value] of amountEntries) {
      const parsed = z.union([DecimalSourceSchema, JsonNumberDecimalSourceSchema]).safeParse(value);
      if (!parsed.success) {
        context.addIssue({ code: "custom", message: `Falcon asset ${row.label}.${key} is not a decimal` });
      } else if (parsed.data.startsWith("-")) {
        context.addIssue({ code: "custom", message: `Falcon asset ${row.label}.${key} is negative` });
      } else {
        normalized[key] = parsed.data;
      }
    }
    return normalized;
  });

const FalconReservesSchema = z.record(z.string(), z.record(z.string(), DecimalSourceSchema));

export const FalconTransparencySchema = z
  .object({
    snapshot_date: JsonNumberDecimalSourceSchema,
    tvl: DecimalSourceSchema,
    usdf: z
      .object({
        supply: DecimalSourceSchema,
        insurance_fund: DecimalSourceSchema,
        reserves: FalconReservesSchema,
        venues: z.record(z.string(), z.unknown()),
        breakdown: z
          .object({
            assets: z.array(FalconAssetRowSchema).min(1),
          })
          .loose(),
      })
      .loose(),
  })
  .loose();

export type FalconTransparency = z.infer<typeof FalconTransparencySchema>;
