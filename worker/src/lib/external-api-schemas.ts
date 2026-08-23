import { z } from "zod";

// NOTE: DefiLlama chainCirculating (Q06) is already validated by the existing
// ChainCirculatingSchema in shared/types/market.ts (lines 11-19). The cast at
// stages.ts:42 is a post-parse narrowing, not a raw API cast. No new schema needed.

// --- TronGrid events (Q11) ---
const TronEventResultSchema = z.object({
  _user: z.string().optional(),
  _blackListedUser: z.string().optional(),
  _balance: z.string().optional(),
  _value: z.string().optional(),
  "0": z.string().optional(),
  "1": z.string().optional(),
}).passthrough();

const TronEventSchema = z.object({
  block_number: z.number(),
  block_timestamp: z.number(),
  transaction_id: z.string(),
  event_index: z.number(),
  event_name: z.string(),
  result: TronEventResultSchema,
}).passthrough();

export const TronEventsResponseSchema = z.object({
  data: z.array(TronEventSchema),
  success: z.boolean(),
  meta: z.object({
    links: z.object({ next: z.string().optional() }).optional(),
  }).optional(),
}).passthrough();

// --- CoinGecko market chart (Q11) ---
export const CoinGeckoMarketChartSchema = z.object({
  prices: z.array(z.tuple([z.number(), z.number()])),
});

// --- Frankfurter FX rates (Q11) ---
export const FrankfurterTimeSeriesSchema = z.object({
  base: z.string(),
  start_date: z.string(),
  end_date: z.string(),
  rates: z.record(z.string(), z.record(z.string(), z.number())),
});

// --- Secondary FX (fawazahmed0 currency-api) day response (Q252) ---
export const SecondaryFxResponseSchema = z.object({
  date: z.string().optional(),
  usd: z.record(z.string(), z.number()).optional(),
}).passthrough();
