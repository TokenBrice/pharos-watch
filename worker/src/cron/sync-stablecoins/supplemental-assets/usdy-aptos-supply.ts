import { z } from "zod";
import { APTOS_PUBLIC_REST_URL } from "@shared/lib/chain-rpc-registry";
import { NAV_SUPPLY_LEDGER_FRESHNESS } from "@shared/lib/onchain-supply-probe";
import { fetchJsonPostWithRetry, fetchJsonWithRetry } from "../../../lib/json-request";

const BOUNDED_READ = { maxRetries: 0, maxResponseBytes: 64 * 1024 };
const IntegerSchema = z.string().regex(/^(0|[1-9]\d{0,38})$/);
const LedgerSchema = z.object({ chain_id: z.literal(1), ledger_version: IntegerSchema, ledger_timestamp: IntegerSchema });
const SupplyViewSchema = z.array(z.object({ vec: z.array(IntegerSchema).length(1) })).length(1);

/** Coin supply includes paired FA stock; native FA supply reads the metadata object directly. */
export async function fetchAptosSupply(address: string, decimals: number, signal: AbortSignal, symbol: "USDY" | "BUIDL" = "USDY"): Promise<bigint> {
  const errorPrefix = `aptos-${symbol.toLowerCase()}`;
  if (!/^0x[0-9a-f]{64}$/.test(address) || decimals !== 6) throw new Error(`${errorPrefix}-identity-invalid`);
  const ledger = LedgerSchema.parse(await fetchJsonWithRetry<unknown>(APTOS_PUBLIC_REST_URL, signal, 10_000, undefined, BOUNDED_READ));
  const age = Date.now() / 1000 - Number(BigInt(ledger.ledger_timestamp)) / 1_000_000;
  if (!Number.isFinite(age) || age > NAV_SUPPLY_LEDGER_FRESHNESS.maxAgeSec || age < -NAV_SUPPLY_LEDGER_FRESHNESS.maxFutureSkewSec) throw new Error(`${errorPrefix}-ledger-stale-or-future`);
  const coin = symbol === "USDY";
  const type = coin ? `0x1::coin::CoinInfo<${address}::usdy::USDY>` : "0x1::fungible_asset::Metadata";
  const resource = z.object({ type: z.string(), data: z.object({ decimals: z.literal(6), symbol: z.literal(symbol) }) }).parse(await fetchJsonWithRetry<unknown>(
    `${APTOS_PUBLIC_REST_URL}/accounts/${address}/resource/${encodeURIComponent(type)}?ledger_version=${ledger.ledger_version}`,
    signal, 10_000, undefined, BOUNDED_READ,
  ));
  if (resource.type !== type) throw new Error(`${errorPrefix}-resource-identity-mismatch`);
  const supply = SupplyViewSchema.parse(await fetchJsonPostWithRetry<unknown>(
    `${APTOS_PUBLIC_REST_URL}/view?ledger_version=${ledger.ledger_version}`,
    coin ? { function: "0x1::coin::supply", type_arguments: [`${address}::usdy::USDY`], arguments: [] }
      : { function: "0x1::fungible_asset::supply", type_arguments: [type], arguments: [address] },
    signal, 10_000, undefined, BOUNDED_READ,
  ));
  const raw = BigInt(supply[0].vec[0]);
  if (raw >= 1n << 128n) throw new Error(`${errorPrefix}-supply-exceeds-u128`);
  return raw;
}
