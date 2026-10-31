import { z } from "zod";

/**
 * Canonical Zod schemas for upstream pricing API responses consumed by the
 * worker. Use these for permissive parsing of CoinGecko `/simple/price` and
 * DefiLlama `/coins/prices/current/...` payloads.
 *
 * NOTE: The DefiLlama contract-pass in
 * `worker/src/cron/sync-stablecoins/enrich-prices-defillama-pass.ts` uses a
 * stricter per-entry variant (`DLPriceEntrySchema` in `worker/src/lib/schemas.ts`,
 * validated row by row under the `DLPriceResponseSchema` envelope) that
 * requires `price` and adds `symbol`/`confidence` fields. Those schemas are
 * deliberately divergent and remain their own exports.
 */

/** One CoinGecko `/simple/price` quote; callers validate each entry separately. */
export const CoinGeckoSimplePriceEntrySchema = z.object({
  usd: z.number(),
  last_updated_at: z.number().optional(),
});

/**
 * CoinGecko `/simple/price?ids=...&vs_currencies=usd&include_last_updated_at=true`
 * envelope. Entries stay unknown so one malformed quote is quarantined per key
 * instead of rejecting its siblings.
 */
export const CoinGeckoSimplePriceSchema = z.record(z.string(), z.unknown());

/** DefiLlama `/coins/prices/current/...` response (permissive — allows missing price/timestamp). */
export const DefiLlamaCoinsPriceSchema = z.object({
  coins: z
    .record(
      z.string(),
      z.object({
        price: z.number().optional(),
        symbol: z.string().optional(),
        timestamp: z.number().optional(),
        confidence: z.number().optional(),
      }),
    )
    .optional(),
});

export type DefiLlamaCoinsPriceResponse = z.infer<typeof DefiLlamaCoinsPriceSchema>;
