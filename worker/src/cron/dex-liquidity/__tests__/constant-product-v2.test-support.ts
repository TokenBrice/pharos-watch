import { canonicalExitRouteAssetKey } from "@shared/lib/exit-route-identity";
import { makeChainRpcConfig } from "../../../test-helpers/chain-rpc-fixtures.test-support";
import type { EvmV2ReplayCase } from "./fixtures/evm-v2-fixtures";

export function captureRpcs(chainId: string, chainName: string) {
  return new Map([[chainId, makeChainRpcConfig({
    chainId, chainName, rpcUrls: ["https://rpc.example"], explorerUrl: "https://example.com",
  })]]);
}

export function replayTokenLookups(replay: EvmV2ReplayCase) {
  const tokens = [
    { address: replay.stablecoinAddress, stablecoinId: replay.assetId, symbol: replay.stablecoinSymbol, decimals: replay.stablecoinDecimals },
    { address: replay.counterAddress, stablecoinId: replay.counterAssetId, symbol: replay.counterSymbol, decimals: replay.counterDecimals },
  ];
  return {
    chainAddressToId: new Map(tokens.map((token) => [canonicalExitRouteAssetKey("bsc", token.address), token.stablecoinId])),
    contractMetaByChainAddress: new Map(tokens.map(({ address, ...token }) => [
      canonicalExitRouteAssetKey("bsc", address), { ...token, source: "contract" as const },
    ])),
  };
}
