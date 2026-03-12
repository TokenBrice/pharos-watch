import type { StablecoinMeta } from "@shared/types";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { getChainRpc } from "../../lib/chain-registry";

interface JsonRpcCallResponse {
  result?: string;
  error?: { message?: string };
}

function isHexResult(value: string | undefined): value is `0x${string}` {
  return typeof value === "string" && value.startsWith("0x") && value.length > 2;
}

export async function fetchEvmCallHex(
  chainId: string,
  to: string,
  data: string,
  signal?: AbortSignal,
): Promise<`0x${string}` | null> {
  const rpc = getChainRpc(chainId);
  if (!rpc) return null;

  const rpcUrls = [rpc.rpcUrl, rpc.fallbackRpcUrl].filter(
    (url): url is string => typeof url === "string" && url.length > 0,
  );

  for (const rpcUrl of rpcUrls) {
    try {
      const res = await fetchWithRetry(
        rpcUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal,
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "eth_call",
            params: [{ to, data }, "latest"],
            id: 1,
          }),
        },
        1,
        { timeoutMs: 10_000 },
      );

      if (!res?.ok) continue;

      const body = await res.json() as JsonRpcCallResponse;
      if (body.error || !isHexResult(body.result) || body.result === "0x") continue;

      return body.result;
    } catch {
      continue;
    }
  }

  return null;
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
