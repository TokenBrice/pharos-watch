import type { StablecoinMeta } from "@shared/types";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { fetchEvmCallHexAtBlock } from "../../lib/evm-rpc";

function isHexResult(value: string | undefined): value is `0x${string}` {
  return typeof value === "string" && value.startsWith("0x") && value.length > 2;
}

export async function fetchEvmCallHex(
  chainId: string,
  to: string,
  data: string,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
  timeoutMs?: number,
): Promise<`0x${string}` | null> {
  const result = await fetchEvmCallHexAtBlock(chainId, to, data, "latest", { signal, chainRpcs, timeoutMs });
  return isHexResult(result ?? undefined) ? result : null;
}

export function parseEvmAddressResult(result: `0x${string}`): string | null {
  return /^0x[0-9a-fA-F]{64}$/.test(result)
    ? `0x${result.slice(-40).toLowerCase()}`
    : null;
}

export function resolveCoinContractAddress(
  coin: StablecoinMeta,
  chainId: string,
): string | null {
  const contract = coin.contracts?.find((entry) => entry.chain === chainId);
  return contract?.address ?? null;
}
