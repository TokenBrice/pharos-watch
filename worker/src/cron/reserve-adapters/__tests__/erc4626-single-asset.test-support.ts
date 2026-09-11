import { fetchErc4626SingleAssetReserves } from "../erc4626-single-asset";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import {
  installAdapterNetwork,
  type AdapterNetwork,
  type AdapterNetworkSpec,
  type AdapterRpcCall,
  type AdapterBlockHeader,
  type AdapterRpcValue,
  type AdapterRpcWord,
} from "./reserve-adapter.test-support";

type Erc4626Call = { to?: string; data: string };

type Erc4626RpcContext = {
  url: string;
  call?: Erc4626Call;
  body: Record<string, unknown>;
};

type Erc4626RpcHandler = (context: Erc4626RpcContext) => Response | null | undefined;

export type Erc4626RpcFixture = {
  chain?: string;
  vault?: string;
  asset?: string | null;
  totalAssets?: bigint | number | null;
  totalSupply?: bigint | number | null;
  convertedAssets?: bigint | number | null;
  idleBalance?: bigint | number | null;
  decimals?: bigint | number | null;
  paused?: bigint | number;
  shutdown?: bigint | number;
  extraHandlers?: Erc4626RpcHandler[];
};

async function responseValue(response: Response | null): Promise<string | null> {
  const payload = response == null ? null : await response.json() as { result?: string } | null;
  // An empty success word ("0x") is not representable as a harness rpc word
  // (short hex is right-aligned into a zero word); surface it as a failed
  // call instead, which adapters read identically (unreadable result).
  const result = payload?.result;
  return result != null && result.length > 2 ? result : null;
}

let activeNetwork: AdapterNetwork | undefined;

export function installErc4626Network({
  chain = "ethereum",
  vault = "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b",
  asset = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  totalAssets = 100_000_000n,
  totalSupply = 100_000_000n,
  convertedAssets = 100_000_000n,
  idleBalance = 25_000_000n,
  decimals = 6,
  paused,
  shutdown,
  extraHandlers = [],
}: Erc4626RpcFixture = {}): AdapterNetwork {
  const vaultAddress = vault.toLowerCase();
  const underlying = asset?.toLowerCase();
  const invokeExtra = async (call: AdapterRpcCall | undefined, url: string, body: Record<string, unknown>) => {
    for (const handler of extraHandlers) {
      const response = handler({
        url,
        call: call ? { to: call.contract, data: call.data } : undefined,
        body,
      });
      if (response !== undefined) return response;
    }
    return undefined;
  };
  const rpcHandlerBody = (call: AdapterRpcCall) => ({
    jsonrpc: "2.0",
    method: call.method,
    params: [{ to: call.contract, data: call.data }, call.block],
  });
  const withHandlers = (fallback: AdapterRpcValue) =>
    async (call: AdapterRpcCall): Promise<AdapterRpcWord | AdapterBlockHeader> => {
      const response = await invokeExtra(call, call.url, rpcHandlerBody(call));
      if (response === undefined) return typeof fallback === "function" ? fallback(call) : fallback;
      return responseValue(response);
    };
  const rpc: AdapterNetworkSpec["rpc"] = {
    [`${vault}:asset()`]: withHandlers(asset == null ? null : asset),
    [`${vault}:totalAssets()`]: withHandlers(totalAssets),
    [`${vault}:totalSupply()`]: withHandlers(totalSupply),
    ...(paused === undefined ? {} : { [`${vault}:paused()`]: withHandlers(paused) }),
    ...(shutdown === undefined ? {} : { [`${vault}:isShutdown()`]: withHandlers(shutdown) }),
    [`${vault}:convertToAssets(uint256)`]: withHandlers(convertedAssets),
    ...(underlying
      ? {
          [`${underlying}:decimals()`]: withHandlers(decimals),
          [`${underlying}:balanceOf(address)`]: withHandlers((call: AdapterRpcCall) =>
            call.data === `0x70a08231${vaultAddress.slice(2).padStart(64, "0")}` ? idleBalance ?? null : null),
        }
      : {}),
    ...Object.fromEntries(
      [
        "0x9aa7df94",
        "0xa9bbf1cc",
        "0x39ebf823",
        "0xce96cb77",
        "0x160b71df",
        "0xbf2428e6",
        "0x35269315",
        "0x90b9f9e4",
        "0xb249b35d",
        "0x1d30e266",
        "0x9e65741e",
        "0xe7c2a608",
        "0x5c975abb",
        "0x18160ddd",
        "0x70a08231",
      ]
        .map((selector) => [selector, async (call: AdapterRpcCall) => {
          const response = await invokeExtra(call, call.url, rpcHandlerBody(call));
          if (response == null) return null;
          return responseValue(response);
        }]),
    ),
  };
  activeNetwork = installAdapterNetwork({
    chains: { [chain]: "https://rpc.example" },
    rpc,
    json: {
      "https://api.morpho.org/graphql": async (request: Request) => {
        const body = await request.json() as Record<string, unknown>;
        const response = await invokeExtra(undefined, "https://api.morpho.org/graphql", body);
        if (!response) throw new Error("Unexpected non-RPC request https://api.morpho.org/graphql");
        return await response.json();
      },
    },
  });
  return activeNetwork;
}
export function getErc4626Network(): AdapterNetwork | undefined {
  return activeNetwork;
}

/** Strip the reviewed deployed-exposure attestation so a case exercises the
 *  unreviewed held-versus-deployed split. */
export function withoutDeployedExposure(config: LiveReservesConfig): LiveReservesConfig {
  const cloned = structuredClone(config) as LiveReservesConfig & {
    params?: { deployedExposure?: unknown };
  };
  if (cloned.params) delete cloned.params.deployedExposure;
  return cloned;
}

export async function runTrackedVault(
  id: string,
  configTransform?: (config: LiveReservesConfig) => LiveReservesConfig,
): Promise<Awaited<ReturnType<typeof fetchErc4626SingleAssetReserves>>> {
  const coin = TRACKED_META_BY_ID.get(id);
  if (!coin?.liveReservesConfig) throw new Error(`Missing live reserve config for ${id}`);
  const config = configTransform ? configTransform(coin.liveReservesConfig) : coin.liveReservesConfig;
  const network = activeNetwork ?? installErc4626Network();
  return fetchErc4626SingleAssetReserves(
    coin,
    config,
    new AbortController().signal,
    { chainRpcs: network.chainRpcs },
  );
}
