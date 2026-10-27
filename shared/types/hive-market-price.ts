import { z } from "zod";

const HiveMarketRejectionSchema = z.enum([
  "rpc_timeout", "rpc_error", "rate_limited", "invalid_response", "head_stale",
  "sample_expired", "book_empty", "book_crossed", "spread_exceeded",
  "insufficient_depth", "depth_unproven", "volume_unproven", "insufficient_volume",
  "trade_stale", "trade_book_divergence", "hive_usd_unavailable", "hive_usd_stale",
  "aborted", "deadline_exceeded",
]);
export type HiveMarketRejection = z.infer<typeof HiveMarketRejectionSchema>;

const finite = z.number().finite();
const head = z.object({ number: z.number().int().nonnegative(), time: finite });
export const HiveMarketDiagnosticSchema = z.object({
  stablecoinId: z.literal("hbd-hive"),
  source: z.literal("hive-native-cg"),
  generation: finite,
  policyVersion: z.literal(1),
  policy: z.object({
    headMaxAgeSec: finite, headFutureSkewSec: finite, sampleMaxMs: finite,
    spreadMax: finite, depthBand: finite, depthMinHbd: finite,
    volumeWindowSec: finite, volumeMinHbd: finite, tradeMaxAgeSec: finite,
    tradeDivergenceMax: finite, parentMaxAgeSec: finite, parentFutureSkewSec: finite,
    sourceMaxAgeSec: finite, rpcTimeoutMs: finite, observerTimeoutMs: finite,
    maxResponseBytes: finite, bookLimit: finite, tradeLimit: finite,
  }),
  node: z.string().nullable(),
  methods: z.array(z.string()).max(5),
  rpcCount: z.number().int().nonnegative(),
  preHead: head.nullable(), postHead: head.nullable(),
  bookRetrievedAt: finite.nullable(), sampleDurationMs: finite.nullable(),
  pair: z.literal("HBD/HIVE"), units: z.literal("HBD per HIVE"),
  bid: finite.nullable(), ask: finite.nullable(), mid: finite.nullable(), spread: finite.nullable(),
  bidDepthHbd: finite.nullable(), askDepthHbd: finite.nullable(),
  bidDepthComplete: z.boolean().nullable(), askDepthComplete: z.boolean().nullable(),
  tradeAgeSec: finite.nullable(), volumeHbd: finite.nullable(), volumeComplete: z.boolean().nullable(),
  duplicateTradeRows: z.number().int().nonnegative().nullable(),
  tickerVolumeHbd: finite.nullable(), tickerVolumeDifferenceHbd: finite.nullable(),
  parent: z.object({ id: z.literal("hive"), source: z.literal("coingecko"), price: finite.nullable(), observedAt: finite.nullable(), ageSec: finite.nullable() }),
  formula: z.literal("HIVE_USD / ((bid_HBD_per_HIVE + ask_HBD_per_HIVE) / 2)"),
  price: finite.nullable(), usdBid: finite.nullable(), usdAsk: finite.nullable(),
  observedAt: finite.nullable(), observedAtMode: z.literal("local_fetch"),
  rejectionReason: HiveMarketRejectionSchema.nullable(),
});
export type HiveMarketDiagnostic = z.infer<typeof HiveMarketDiagnosticSchema>;
export type HiveNativePriceQuote = {
  price: number;
  observedAt: number;
  observedAtMode: "local_fetch";
};
