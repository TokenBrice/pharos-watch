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

// --- TronGrid freeze-amount replay evidence (Q11) ---
const TronHex64Schema = z.string().regex(/^[0-9a-f]{64}$/i);
const TronEventTimestampMsSchema = z.number().int().nonnegative();

export const TronBlockHeaderSchema = z.object({
  blockID: TronHex64Schema,
  block_header: z.object({
    raw_data: z.object({
      number: z.number().int().nonnegative(),
      timestamp: TronEventTimestampMsSchema,
    }),
  }),
});

export const TronTransactionInfoSchema = z.object({
  id: TronHex64Schema,
  blockNumber: z.number().int().nonnegative(),
  blockTimeStamp: TronEventTimestampMsSchema,
  receipt: z.object({ result: z.string() }).optional(),
  log: z.array(z.object({
    address: z.string(),
    topics: z.array(z.string()),
  })).optional(),
});

const TronTrc20TransferSchema = z.object({
  transaction_id: z.string(),
  block_timestamp: TronEventTimestampMsSchema,
  from: z.string(),
  to: z.string(),
  type: z.string(),
  value: z.string().regex(/^\d+$/),
});

export const TronTriggerConstantContractSchema = z.object({
  result: z.object({ result: z.boolean() }).optional(),
  constant_result: z.array(z.string().regex(/^(0x)?[0-9a-f]{64}$/i)).min(1).optional(),
});

export const TronTrc20HistorySchema = z.object({
  success: z.literal(true),
  data: z.array(TronTrc20TransferSchema),
  meta: z.object({
    at: TronEventTimestampMsSchema,
    links: z.object({ next: z.string().optional() }).optional(),
  }).optional(),
});

// --- CoinGecko market chart (Q11) ---
export const CoinGeckoMarketChartSchema = z.object({
  prices: z.array(z.tuple([z.number(), z.number()])),
  market_caps: z.array(z.tuple([z.number(), z.number()])).optional(),
});

export const CoinGeckoCoinDetailSchema = z.object({
  market_data: z.object({
    circulating_supply: z.number().optional(),
  }).optional(),
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
