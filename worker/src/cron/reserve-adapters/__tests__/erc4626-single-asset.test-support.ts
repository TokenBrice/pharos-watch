import { fetchErc4626SingleAssetReserves } from "../erc4626-single-asset";
import type { AdapterContext } from "../types";
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
  liquidityAdapter?: bigint | number | null;
  json?: AdapterNetworkSpec["json"];
  extraHandlers?: Erc4626RpcHandler[];
};

export interface MorphoReadMockOptions {
  version?: "v1" | "v2";
  chainId?: number;
  vault?: string;
  asset?: string;
  listed?: boolean;
  dirAsset?: string;
  withdrawable?: string | null;
  stateAddress?: string;
  stateChainId?: number;
  penalties?: string[];
  price?: number | null;
  priceStatus?: number;
  overrides?: AdapterNetworkSpec["json"];
}

export function morphoReadJson({
  version = "v2",
  chainId = 1,
  vault = "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b",
  asset = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  listed = true,
  dirAsset = asset,
  withdrawable = "90000000",
  stateAddress = vault,
  stateChainId = chainId,
  penalties = [],
  price = 1,
  priceStatus = 200,
  overrides = {},
}: MorphoReadMockOptions = {}): NonNullable<AdapterNetworkSpec["json"]> {
  const v = vault.toLowerCase();
  const a = asset.toLowerCase();
  const sel = `${chainId}:${v}`;
  const base = "https://api.morpho.org";
  return {
    [`${base}/v0/vaults-${version}?limit=1000`]: {
      data: listed ? [{ chain_id: chainId, vault_address: vault, asset_address: dirAsset }] : [],
      cursor: null,
    },
    [`${base}/${version === "v1" ? "v0/vaults-v1" : "v1/vaults-v2"}/${sel}/state`]: {
      data: { chain_id: stateChainId, address: stateAddress, withdrawable_assets: withdrawable },
    },
    ...(version === "v2"
      ? {
          [`${base}/v0/vaults-v2/${sel}/withdrawal-options`]: {
            data: {
              chain_id: chainId,
              vault_address: vault,
              adapter_penalties: penalties.map((p) => ({ force_deallocatable_assets: p })),
            },
          },
        }
      : {}),
    [`${base}/v0/tokens/${chainId}:${a}/price`]: {
      status: priceStatus,
      json: { data: { chain_id: chainId, address: asset, price } },
    },
    ...overrides,
  };
}

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
  liquidityAdapter,
  json,
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
    ...(liquidityAdapter === undefined ? {} : { [`${vault}:0xad468d11`]: withHandlers(liquidityAdapter) }),
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
        "0xad468d11",
        "0x7bfef9fa",
        // stUSDS unused-funds probe: vat(), jug(), clip(), ilk(), ilks(bytes32),
        // Due() and Multicall3 getCurrentBlockTimestamp().
        "0x36569e77",
        "0x84718d89",
        "0x39b00e41",
        "0xc5ce281e",
        "0xd9638d36",
        "0x08bf162f",
        "0x0f28c97d",
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
    ...(json ? { json } : {}),
  });
  return activeNetwork;
}
export function getErc4626Network(): AdapterNetwork | undefined {
  return activeNetwork;
}

/** Restore the default network between files that share one module cache, so a
 * test omitting `installErc4626Network()` cannot inherit the previous file's
 * chain in the non-isolated `worker-shared` project. */
export function resetErc4626NetworkForTests(): void {
  activeNetwork = undefined;
}

export async function runTrackedVault(
  id: string,
  configTransform?: (config: LiveReservesConfig) => LiveReservesConfig,
  ctx?: Partial<AdapterContext>,
): Promise<Awaited<ReturnType<typeof fetchErc4626SingleAssetReserves>>> {
  const coin = TRACKED_META_BY_ID.get(id);
  if (!coin?.liveReservesConfig) throw new Error(`Missing live reserve config for ${id}`);
  const config = configTransform ? configTransform(coin.liveReservesConfig) : coin.liveReservesConfig;
  const network = activeNetwork ?? installErc4626Network();
  return fetchErc4626SingleAssetReserves(
    coin,
    config,
    new AbortController().signal,
    { chainRpcs: network.chainRpcs, ...ctx },
  );
}
