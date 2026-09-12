import { z } from "zod";
import { EEARN_SUI_COIN_TYPE } from "@shared/lib/onchain-supply-probe";
import { fetchJsonPostWithRetry } from "../../reserve-adapters/request";

const VAULT = "0x0779d2a4e1a6d3412982404cfe5567aac8cea229f17622c7b72d198b22a22e37";
const VAULT_TYPE = `0xc83d5406fd355f34d3ce87b35ab2c0b099af9d309ba96c17e40309502a49976f::vault::Vault<0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC,${EEARN_SUI_COIN_TYPE}>`;
const ResponseSchema = z.object({
  checkpoint: z.object({ timestamp: z.string() }),
  coinMetadata: z.object({ decimals: z.literal(6) }),
  object: z.object({ asMoveObject: z.object({ contents: z.object({
    type: z.object({ repr: z.literal(VAULT_TYPE) }),
    json: z.object({
      id: z.literal(VAULT),
      receipt_token_treasury_cap: z.object({ total_supply: z.object({ value: z.string().regex(/^\d{1,20}$/) }) }),
    }),
  }) }) }),
});

/** Reviewed native eEARN vault: its embedded TreasuryCap owns the full receipt
 * supply even though the public coin metadata's optional supply is null. */
export async function fetchEearnSuiSupply(coinType: string, decimals: number | undefined, signal: AbortSignal): Promise<bigint> {
  if (coinType !== EEARN_SUI_COIN_TYPE || decimals !== 6) throw new Error("Unreviewed Sui supply identity");
  const response = await fetchJsonPostWithRetry<{ data?: unknown; errors?: unknown[] }>(
    "https://graphql.mainnet.sui.io/graphql",
    { query: `query($coinType: String!, $vault: SuiAddress!) {
      checkpoint { timestamp }
      coinMetadata(coinType: $coinType) { decimals }
      object(address: $vault) { asMoveObject { contents { type { repr } json } } }
    }`, variables: { coinType, vault: VAULT } },
    signal, 10_000, undefined, { maxRetries: 0, maxResponseBytes: 256 * 1024 },
  );
  if (response.errors?.length) throw new Error("Sui supply GraphQL error");
  const data = ResponseSchema.parse(response.data);
  const timestamp = Date.parse(data.checkpoint.timestamp) / 1000;
  const age = Date.now() / 1000 - timestamp;
  if (!Number.isFinite(age) || age > 600 || age < -600) throw new Error("Sui supply checkpoint is stale or future");
  const raw = BigInt(data.object.asMoveObject.contents.json.receipt_token_treasury_cap.total_supply.value);
  if (raw > 18_446_744_073_709_551_615n) throw new Error("Sui supply exceeds u64");
  return raw;
}
