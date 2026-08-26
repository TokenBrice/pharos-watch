import { z } from "zod";

/**
 * Canonical Zod schemas for upstream pricing API responses consumed by the
 * worker. Use these for permissive parsing of CoinGecko `/simple/price` and
 * DefiLlama `/coins/prices/current/...` payloads.
 *
 * NOTE: The DefiLlama contract-pass in
 * `worker/src/cron/sync-stablecoins/enrich-prices-defillama-pass.ts` uses a
 * stricter variant (`DLPriceResponseSchema` in `worker/src/lib/schemas.ts`)
 * that requires `price` and adds `symbol`/`confidence` fields. That schema is
 * deliberately divergent and remains its own export.
 */

/** CoinGecko `/simple/price?ids=...&vs_currencies=usd&include_last_updated_at=true` response. */
export const CoinGeckoSimplePriceSchema = z.record(
  z.string(),
  z.object({
    usd: z.number().optional(),
    last_updated_at: z.number().optional(),
  }),
);

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

type CoinGeckoSimplePriceResponse = z.infer<typeof CoinGeckoSimplePriceSchema>;
export type DefiLlamaCoinsPriceResponse = z.infer<typeof DefiLlamaCoinsPriceSchema>;
