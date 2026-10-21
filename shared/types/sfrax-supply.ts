import { z } from "zod";

export const SFRAX_STOCK_PERIMETER_METHOD = "sfrax-current-token-stock-v1" as const;
export const SFRAX_STOCK_MAX_AGE_SEC = 5 * 60;
export const SFRAX_STOCK_CHAINS = [
  "ethereum", "arbitrum", "avalanche", "base", "blast", "bsc", "fraxtal", "metis", "optimism", "solana",
] as const;

const RawQuantitySchema = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const TimestampSchema = z.number().int().positive().safe();
const ChainSchema = z.enum(SFRAX_STOCK_CHAINS);
const EvmBlockSchema = z.object({
  number: z.number().int().positive().safe(),
  hash: z.string().regex(/^0x[0-9a-f]{64}$/),
  timestamp: TimestampSchema,
}).strict();

/** Current minted token stocks less measured excluded custody; not a pending-claim or financial assurance certificate. */
export const SfraxStockPerimeterObservationSchema = z.object({
  method: z.literal(SFRAX_STOCK_PERIMETER_METHOD),
  assetId: z.literal("sfrax-frax"),
  readStartedAt: TimestampSchema,
  readCompletedAt: TimestampSchema,
  priceUsd: z.number().finite().positive(),
  blocks: z.record(ChainSchema, EvmBlockSchema.or(z.object({
    slot: z.number().int().positive().safe(), timestamp: TimestampSchema,
  }).strict())),
  grossSupplyRaw: z.record(ChainSchema, RawQuantitySchema),
  nativeCustodyRaw: z.object({
    migratedStandardBridge: RawQuantitySchema,
    oftAdapter: RawQuantitySchema,
    arbitrumFerry: RawQuantitySchema,
    avalancheFerry: RawQuantitySchema,
    bscFerry: RawQuantitySchema,
    optimismFerry: RawQuantitySchema,
    historicalFraxtalFerry: RawQuantitySchema,
    retiredZkevmFerry: RawQuantitySchema,
  }).strict(),
  migratedDepositsRaw: RawQuantitySchema,
  remotePrefundedRaw: z.object({
    arbitrum: RawQuantitySchema, avalanche: RawQuantitySchema, bsc: RawQuantitySchema, optimism: RawQuantitySchema,
  }).strict(),
  /** Included, not excluded: ownership alone is not the repo's circulation convention. */
  compoundHolderBalanceRaw: RawQuantitySchema,
}).strict();

export type SfraxStockPerimeterObservation = z.infer<typeof SfraxStockPerimeterObservationSchema>;
