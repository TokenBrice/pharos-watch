import type { ChainRpcConfig } from "../../lib/chain-registry";
import { makeStablecoinMeta } from "@shared/test-utils/stablecoin";
import type { StablecoinMeta } from "@shared/types";

export function supplyMetadata(): StablecoinMeta[] {
  const contract = (chain: string, decimals: number) => ({
    chain, decimals, address: "0x1111111111111111111111111111111111111111",
  });
  const euroFlags = () => ({ ...makeStablecoinMeta().flags, pegCurrency: "EUR" as const });
  return [
    makeStablecoinMeta({ id: "usdt-tether", symbol: "USDT", detailProvider: "defillama", llamaId: "1", geckoId: "tether" }),
    makeStablecoinMeta({ id: "euro3-3a-dao", symbol: "EURO3", detailProvider: "defillama", llamaId: "170", flags: euroFlags() }),
    makeStablecoinMeta({ id: "eurc-circle", symbol: "EURC", detailProvider: "defillama", llamaId: "50", geckoId: "euro-coin", flags: euroFlags() }),
    makeStablecoinMeta({ id: "susdt-spark", symbol: "spUSDT", detailProvider: "coingecko", geckoId: "spark-savings-usdt",
      contracts: [contract("ethereum", 6), contract("arbitrum", 6)] }),
    makeStablecoinMeta({ id: "acred-apollo-securitize", symbol: "ACRED", detailProvider: "coingecko",
      geckoId: "apollo-diversified-credit-securitize-fund", contracts: [contract("ethereum", 6), contract("avalanche", 6)] }),
    makeStablecoinMeta({ id: "autousd-auto-finance", symbol: "autoUSD", detailProvider: "coingecko", contracts: [contract("ethereum", 18)] }),
    makeStablecoinMeta({ id: "eearn-ember", symbol: "eEARN", detailProvider: "coingecko", contracts: [contract("ethereum", 6)] }),
    makeStablecoinMeta({ id: "bd-basedollar", symbol: "BD", detailProvider: "defillama", llamaId: "434", contracts: [contract("base", 18)] }),
    makeStablecoinMeta({ id: "usg-tangent", symbol: "USG", detailProvider: "coingecko", contracts: [contract("ethereum", 18)] }),
    makeStablecoinMeta({ id: "xaut-tether", symbol: "XAUT", detailProvider: "commodity", geckoId: "tether-gold", protocolSlug: "tether-gold",
      flags: { ...makeStablecoinMeta().flags, pegCurrency: "GOLD" } }),
  ];
}

export function ethereumSupplyRpc(): Map<string, ChainRpcConfig> {
  return new Map([["ethereum", {
    chainId: "ethereum",
    chainName: "Ethereum",
    type: "evm",
    rpcUrl: "https://fake-eth-rpc.test",
    explorerUrl: "https://etherscan.io",
  }]]);
}

export function supplyRpcResponse(init: RequestInit | undefined, block: number, amounts: Readonly<Record<string, bigint>>): Response {
  const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: [{ data: string }, string] };
  const amount = amounts[body.params[0].data.toLowerCase()];
  if (body.method !== "eth_call" || body.params[1] !== `0x${block.toString(16)}` || amount == null) {
    throw new Error(`Unexpected historical RPC request: ${init?.body}`);
  }
  return Response.json({ jsonrpc: "2.0", id: body.id, result: `0x${amount.toString(16).padStart(64, "0")}` });
}
