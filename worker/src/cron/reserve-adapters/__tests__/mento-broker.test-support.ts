import { encodeAbiParameters, parseAbiParameters, toFunctionSelector } from "viem/utils";
import { encodeAddress } from "../../../lib/evm-selectors";
import { MENTO_BIPOOL_MANAGER_ADDRESS } from "@shared/lib/mento-contracts";
import type { AdapterRpcCall, AdapterRpcValue } from "./reserve-adapter.test-support";

export const BROKER = "0x777a8255ca72412f0d706dc03c9d1987306b4cad";
export const BROKER_RESERVE = "0x9380fa34fd9e4fd14c06305fd7b6199089ed4eb9";
export const BROKER_ORACLE = "0xefb84935239dacdecf7c5ba76d8de40b077b7b33";
export const BROKER_BREAKER = "0x303ed1df62fa067659b586ebee8de0ece824ab39";
export const BROKER_FEED = "0x646bd504c3864ea5b8a6b6d25743721f61864a07";
export const BROKER_PRICING_MODULE = "0x0000000000000000000000000000000000000001";
const USDm = "0x765de816845861e75a25fca122bb6898b8b1282a";
const uint = (value: bigint) => encodeAbiParameters(parseAbiParameters("uint256"), [value]);
const bool = (value: boolean) => encodeAbiParameters(parseAbiParameters("bool"), [value]);
const address = (value: string) => `0x${encodeAddress(value)}`;

export function brokerGuardFixture(exchangeId: string, self: string, output: string, capacityUsd: number, now: number): Record<string, AdapterRpcValue> {
  const manager = MENTO_BIPOOL_MANAGER_ADDRESS.toLowerCase();
  const table: Record<string, AdapterRpcValue> = {};
  const put = (contract: string, signature: string, value: AdapterRpcValue, suffix = "") => {
    table[`celo:${contract.toLowerCase()}:${toFunctionSelector(signature)}${suffix}`] = value;
  };
  const outDecimals = output.toLowerCase() === USDm ? 18 : 6;
  put(manager, "broker()", address(BROKER));
  put(manager, "sortedOracles()", address(BROKER_ORACLE));
  put(manager, "breakerBox()", address(BROKER_BREAKER));
  put(BROKER, "exchangeReserve(address)", address(BROKER_RESERVE));
  put(BROKER, "isExchangeProvider(address)", bool(true));
  put(self, "broker()", address(BROKER));
  put(self, "decimals()", uint(18n));
  put(output, "decimals()", uint(BigInt(outDecimals)));
  put(BROKER_RESERVE, "isStableAsset(address)", bool(true), encodeAddress(self));
  put(BROKER_RESERVE, "isStableAsset(address)", bool(true), encodeAddress(output));
  put(BROKER_RESERVE, "isCollateralAsset(address)", bool(false), encodeAddress(output));
  put(output, "isMinter(address)", bool(true));
  put(BROKER_RESERVE, "isExchangeSpender(address)", bool(true));
  put(output, "balanceOf(address)", uint(BigInt(capacityUsd) * 10n ** BigInt(outDecimals)));
  put(BROKER_BREAKER, "getRateFeedTradingMode(address)", uint(0n));
  put(BROKER_ORACLE, "medianTimestamp(address)", uint(BigInt(now)));
  put(BROKER_ORACLE, "numRates(address)", uint(1n));
  put(BROKER_ORACLE, "isOldestReportExpired(address)", encodeAbiParameters(parseAbiParameters("bool,address"), [false, BROKER_FEED]));
  for (const [token, limit] of [[self, capacityUsd], [output, 0]] as const) {
    const id = (BigInt(exchangeId) ^ BigInt(token)).toString(16).padStart(64, "0");
    put(BROKER, "tradingLimitsConfig(bytes32)", encodeAbiParameters(parseAbiParameters("uint32,uint32,int48,int48,int48,uint8"),
      [0, 0, 0, 0, limit, limit > 0 ? 4 : 0]), id);
    put(BROKER, "tradingLimitsState(bytes32)", encodeAbiParameters(parseAbiParameters("uint32,uint32,int48,int48,int48"),
      [0, 0, 0, 0, 0]), id);
  }
  put(BROKER, "getAmountOut(address,bytes32,address,address,uint256)", ({ data }) => uint(BigInt(`0x${data.slice(-64)}`) / 10n ** BigInt(18 - outDecimals)));
  put(BROKER, "getAmountIn(address,bytes32,address,address,uint256)", ({ data }) => uint(BigInt(`0x${data.slice(-64)}`) * 10n ** BigInt(18 - outDecimals)));
  return table;
}

export async function brokerFixtureResponse(table: Record<string, AdapterRpcValue>, contract: string, data: string): Promise<`0x${string}` | null> {
  const value = table[`celo:${contract.toLowerCase()}:${data}`] ?? table[`celo:${contract.toLowerCase()}:${data.slice(0, 10)}`];
  const call: AdapterRpcCall = { chain: "celo", url: "https://rpc.example", method: "eth_call", contract, data, selector: data.slice(0, 10), block: "0x7b", viaMulticall: true };
  const result = typeof value === "function" ? await value(call) : value;
  return typeof result === "string" ? result as `0x${string}` : null;
}

export function brokerInventoryCalls(calls: readonly AdapterRpcCall[]): string[] {
  return calls.filter(({ contract, selector }) => contract.toLowerCase() === MENTO_BIPOOL_MANAGER_ADDRESS.toLowerCase()
    && ["0xdc162e36", "0x278488a4"].includes(selector)).map(({ data }) => data);
}
