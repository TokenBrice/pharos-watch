import { z } from "zod";

import { JsonNumberDecimalSourceSchema } from "./decimal";

export const ETHENA_PROTOCOL_API_URLS = {
  collateralizationStatus: "https://app.ethena.fi/api/collateralization/status",
  proofOfReserves: "https://app.ethena.fi/api/por",
} as const;

export const EthenaCollateralizationStatusSchema = z
  .object({
    timestamp: z.string().min(1),
    totalBackingAssetsInUsd: JsonNumberDecimalSourceSchema,
    totalReserveFundInUsd: JsonNumberDecimalSourceSchema,
    totalTokenSupplyInUsd: JsonNumberDecimalSourceSchema,
  })
  .loose();

const PorAuditorSchema = z
  .object({
    name: z.string().trim().min(1),
    is_confirmed: z.boolean(),
  })
  .loose();

const PorReportSchema = z
  .object({
    auditors: z.array(PorAuditorSchema).min(1),
    date: z.string().datetime(),
    deltaNeutral: z.boolean(),
    overCollateralized: z.boolean(),
  })
  .loose();

export const EthenaProofOfReservesSchema = z
  .object({
    lastUpdatedAt: z.string().datetime(),
    reports: z.array(PorReportSchema).min(1),
  })
  .loose();

export type EthenaCollateralizationStatus = z.infer<typeof EthenaCollateralizationStatusSchema>;
export type EthenaProofOfReserves = z.infer<typeof EthenaProofOfReservesSchema>;
