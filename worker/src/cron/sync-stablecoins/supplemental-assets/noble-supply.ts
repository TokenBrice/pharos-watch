import { z } from "zod";
import { NAV_SUPPLY_LEDGER_FRESHNESS } from "@shared/lib/onchain-supply-probe";
import { fetchJsonWithRetry } from "../../reserve-adapters/request";

const BOUNDED_READ = { maxRetries: 0, maxResponseBytes: 16 * 1024 };
const StatusSchema = z.object({ height: z.string().regex(/^[1-9]\d{0,19}$/), timestamp: z.string().datetime() });
const SupplySchema = z.object({ amount: z.object({
  denom: z.literal("ausdy"), amount: z.string().regex(/^(0|[1-9]\d{0,77})$/),
}) });

/** Native USDY bank stock includes Noble's IBC escrow; remote vouchers are not additive. */
export async function fetchNobleSupply(denom: string, decimals: number, signal: AbortSignal): Promise<bigint> {
  if (denom !== "ausdy" || decimals !== 18) throw new Error("noble-unreviewed-supply-identity");
  // Node status carries the LCD's committed height/clock without the full block's transactions.
  const status = StatusSchema.parse(await fetchJsonWithRetry<unknown>(
    "https://noble-api.polkachu.com/cosmos/base/node/v1beta1/status",
    signal, 10_000, undefined, BOUNDED_READ,
  ));
  const age = Date.now() / 1000 - Date.parse(status.timestamp) / 1000;
  if (!Number.isFinite(age) || age > NAV_SUPPLY_LEDGER_FRESHNESS.maxAgeSec || age < -NAV_SUPPLY_LEDGER_FRESHNESS.maxFutureSkewSec) throw new Error("noble-block-stale-or-future");
  const response = await fetchJsonWithRetry<unknown>(
    "https://noble-api.polkachu.com/cosmos/bank/v1beta1/supply/by_denom?denom=ausdy",
    signal, 10_000, undefined, BOUNDED_READ,
  );
  return BigInt(SupplySchema.parse(response).amount.amount);
}
