import { jsonResponse } from "../../../test-helpers/__shared/mock-fetch";
import { fetchErc4626SingleAssetReserves } from "../erc4626-single-asset";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { fetchWithRetryMock, testChainRpcs } from "./helpers/rpc-mock";

type Erc4626Call = { to?: string; data: string };

type Erc4626RpcContext = {
  url: string;
  call?: Erc4626Call;
  body: Record<string, unknown>;
};

type Erc4626RpcHandler = (context: Erc4626RpcContext) => Response | null | undefined;

type Erc4626RpcFixture = {
  asset?: string | null;
  totalAssets?: bigint | number;
  totalSupply?: bigint | number;
  convertedAssets?: bigint | number;
  idleBalance?: bigint | number;
  decimals?: bigint | number;
  paused?: bigint | number;
  extraHandlers?: Erc4626RpcHandler[];
};

function uint256Result(value: bigint | number): string {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

export function mockErc4626Rpc({
  asset = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  totalAssets = 100_000_000n,
  totalSupply = 100_000_000n,
  convertedAssets = 100_000_000n,
  idleBalance = 25_000_000n,
  decimals = 6,
  paused,
  extraHandlers = [],
}: Erc4626RpcFixture = {}): void {
  fetchWithRetryMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const params = body.params as Array<Erc4626Call> | undefined;
    const call = params?.[0];
    const context = { url, call, body };

    for (const handler of extraHandlers) {
      const response = handler(context);
      if (response !== undefined) return response;
    }
    if (!call) return null;

    if (call.data === "0x38d52e0f") {
      return asset == null ? jsonResponse({ result: "0x" }) : jsonResponse({ result: `0x${asset.replace(/^0x/i, "").padStart(64, "0")}` });
    }
    if (call.data === "0x01e1d114" && totalAssets !== undefined) {
      return jsonResponse({ result: uint256Result(totalAssets) });
    }
    if (call.data === "0x18160ddd" && totalSupply !== undefined) {
      return jsonResponse({ result: uint256Result(totalSupply) });
    }
    if (call.data.startsWith("0x07a2d13a") && convertedAssets !== undefined) {
      return jsonResponse({ result: uint256Result(convertedAssets) });
    }
    if (call.data.startsWith("0x70a08231") && idleBalance !== undefined) {
      return jsonResponse({ result: uint256Result(idleBalance) });
    }
    if (call.data === "0x313ce567" && decimals !== undefined) {
      return jsonResponse({ result: uint256Result(decimals) });
    }
    if (call.data === "0x5c975abb" && paused !== undefined) {
      return jsonResponse({ result: uint256Result(paused) });
    }
    return null;
  });
}

export async function runTrackedVault(
  id: string,
  configTransform?: (config: LiveReservesConfig) => LiveReservesConfig,
): Promise<Awaited<ReturnType<typeof fetchErc4626SingleAssetReserves>>> {
  const coin = TRACKED_META_BY_ID.get(id);
  if (!coin?.liveReservesConfig) throw new Error(`Missing live reserve config for ${id}`);
  const config = configTransform ? configTransform(coin.liveReservesConfig) : coin.liveReservesConfig;
  return fetchErc4626SingleAssetReserves(
    coin,
    config,
    new AbortController().signal,
    { chainRpcs: testChainRpcs },
  );
}
