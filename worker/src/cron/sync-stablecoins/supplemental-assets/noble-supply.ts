import { z } from "zod";
import { fetchJsonWithRetry } from "../../reserve-adapters/request";

const SupplySchema = z.object({ amount: z.object({
  denom: z.literal("ausdy"), amount: z.string().regex(/^(0|[1-9]\d{0,77})$/),
}) });

/** Native USDY bank stock includes Noble's IBC escrow; remote vouchers are not additive. */
export async function fetchNobleSupply(denom: string, decimals: number, signal: AbortSignal): Promise<bigint> {
  if (denom !== "ausdy" || decimals !== 18) throw new Error("noble-unreviewed-supply-identity");
  const response = await fetchJsonWithRetry<unknown>(
    "https://noble-api.polkachu.com/cosmos/bank/v1beta1/supply/by_denom?denom=ausdy",
    signal, 10_000, undefined, { maxRetries: 0, maxResponseBytes: 16 * 1024 },
  );
  return BigInt(SupplySchema.parse(response).amount.amount);
}
