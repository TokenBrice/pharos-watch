import { z } from "zod";
import { USDY_SUI_COIN_TYPE } from "@shared/lib/onchain-supply-probe";
import { fetchJsonPostWithRetry } from "../../reserve-adapters/request";

const ResponseSchema = z.object({ data: z.object({
  checkpoint: z.object({ timestamp: z.string().datetime() }),
  coinMetadata: z.object({ decimals: z.literal(6), symbol: z.literal("USDY"), supply: z.string().regex(/^(0|[1-9]\d{0,19})$/) }),
}), errors: z.array(z.unknown()).length(0).optional() });

export async function fetchUsdySuiSupply(coinType: string, decimals: number, signal: AbortSignal): Promise<bigint> {
  if (coinType !== USDY_SUI_COIN_TYPE || decimals !== 6) throw new Error("sui-unreviewed-usdy-identity");
  const response = ResponseSchema.parse(await fetchJsonPostWithRetry<unknown>(
    "https://graphql.mainnet.sui.io/graphql",
    { query: `query($coinType: String!) {
      checkpoint { timestamp }
      coinMetadata(coinType: $coinType) { decimals supply symbol }
    }`, variables: { coinType } }, signal, 10_000, undefined, { maxRetries: 0, maxResponseBytes: 64 * 1024 },
  ));
  const age = Date.now() / 1000 - Date.parse(response.data.checkpoint.timestamp) / 1000;
  if (!Number.isFinite(age) || age > 600 || age < -60) throw new Error("sui-usdy-checkpoint-stale-or-future");
  const raw = BigInt(response.data.coinMetadata.supply);
  if (raw > 18_446_744_073_709_551_615n) throw new Error("sui-usdy-supply-exceeds-u64");
  return raw;
}
