import { decodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, type ParseAbi } from "viem/utils";
import { decodeMentoPoolExchange, MENTO_POOL_SPREAD_FIXIDITY_SCALE } from "@shared/lib/mento-contracts";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { CIRCUIT_SOURCE } from "../constants";
import { fetchEvmBlockNumber, fetchEvmBlockHeader, fetchEvmMulticall3Aggregate3AtBlock, type EvmBlockHeader } from "../evm-rpc";
import { throwIfAborted } from "../abort";
import { hasPublishableCurrentPrice } from "../price-publication-state";
import { getPublicFallbackRpcUrls } from "../public-rpc-registry";
import { resolveTrustedOverrideParent, type CurrentPriceOverride, type LivePriceContext, type PriceSourceProvider } from "./helpers";

const BROKER = "0x777a8255ca72412f0d706dc03c9d1987306b4cad";
const MANAGER = "0x22d9db95e6ae61c104a7b6f6c78d7993b94ec901";
const USDM = "0x765de816845861e75a25fca122bb6898b8b1282a";
const RESERVE = "0x9380fa34fd9e4fd14c06305fd7b6199089ed4eb9";
const ORACLE = "0xefb84935239dacdecf7c5ba76d8de40b077b7b33";
const BREAKER = "0x303ed1df62fa067659b586ebee8de0ece824ab39";
const UNIT = 10n ** 18n;
const ROUTES: Record<string, { token: string; exchange: string; feed: string; depth: bigint }> = {
  "audm-mento": { token: "0x7175504c455076f15c04a2f90a8e352281f492f9", exchange: "0xd580d237231109e6a96d67d82450611c610a805a26660c90281bdc0cd04a95c7", feed: "0x646bd504c3864ea5b8a6b6d25743721f61864a07", depth: 1_000n * UNIT },
  "cadm-mento": { token: "0xff4ab19391af240c311c54200a492233052b6325", exchange: "0x517ccc3bcab9f35e2e24143a0c1809068efc649f740846cfb6a1c5703735c1ee", feed: "0x20869cf54ead821c45dfb2ab0c23d2e10fbb65a4", depth: 1_000n * UNIT },
  "copm-mento": { token: "0x8a567e2ae79ca692bd748ab832081c45de4041ea", exchange: "0x1c9378bd0973ff313a599d3effc654ba759f8ccca655ab6d6ce5bd39a212943b", feed: "0x0196d1f4fda21fa442e53eaf18bf31282f6139f1", depth: 1_000_000n * UNIT },
};
const CONFIG = parseAbiParameters("uint32,uint32,int48,int48,int48,uint8");
const STATE = parseAbiParameters("uint32,uint32,int48,int48,int48");
// Context identity confines reuse to one serial override stage. Every route still
// reads its full state and rechecks this block's canonical hash before publishing.
const validatedHeads = new WeakMap<LivePriceContext, { block: number; head: EvmBlockHeader }>();

export async function fetchMentoBrokerPrice(id: string, context: LivePriceContext, signal?: AbortSignal): Promise<CurrentPriceOverride | null> {
  const reject = (reason: string): null => { context.lastRejectionReason = `mento-broker:${reason}`; return null; };
  const route = Object.prototype.hasOwnProperty.call(ROUTES, id) ? ROUTES[id] : undefined;
  if (!route) return reject("unsupported-asset");
  const parent = resolveTrustedOverrideParent(context, "cusd-celo", () => "Mento Broker: trusted USDm unavailable", { allowFreshReplaySafeSingleSourceParent: true });
  if (!parent) return reject("parent-unavailable");
  const parentAge = Math.floor(Date.now() / 1000) - parent.trustedParent.observedAt;
  if (parentAge < 0 || parentAge >= 300) return reject("parent-age");
  const options = { signal, chainRpcs: context.chainRpcs, extraRpcUrls: getPublicFallbackRpcUrls("celo"), maxRetries: 0 };
  throwIfAborted(signal);
  const cached = validatedHeads.get(context);
  const cachedAge = cached ? Math.floor(Date.now() / 1000) - cached.head.timestamp : Infinity;
  const reusable = cached && cachedAge >= 0 && cachedAge < 300 ? cached : undefined;
  const block = reusable?.block ?? await fetchEvmBlockNumber("celo", options);
  if (block == null) return reject("block-unavailable");
  const head = reusable?.head ?? await fetchEvmBlockHeader("celo", block, options);
  const now = Math.floor(Date.now() / 1000);
  if (!head || head.timestamp > now || now - head.timestamp >= 300) return reject("block-age");
  const call = (label: string, target: string, signature: string, args: readonly unknown[] = []) => ({ label, target,
    callData: encodeFunctionData({ abi: parseAbi([signature]) as ParseAbi<readonly string[]>, functionName: signature.match(/function (\w+)/)![1], args }) });
  const calls = [
    call("provider", BROKER, "function isExchangeProvider(address) view returns(bool)", [MANAGER]),
    call("reserve", BROKER, "function reserve() view returns(address)"),
    call("managerBroker", MANAGER, "function broker() view returns(address)"),
    call("oracle", MANAGER, "function sortedOracles() view returns(address)"),
    call("breaker", MANAGER, "function breakerBox() view returns(address)"),
    call("pool", MANAGER, "function getPoolExchange(bytes32) view returns(bytes)", [route.exchange]),
    call("mode", BREAKER, "function getRateFeedTradingMode(address) view returns(uint8)", [route.feed]),
    call("oracleTime", ORACLE, "function medianTimestamp(address) view returns(uint256)", [route.feed]),
    call("oracleCount", ORACLE, "function numRates(address) view returns(uint256)", [route.feed]),
    call("expired", ORACLE, "function isOldestReportExpired(address) view returns(bool,address)", [route.feed]),
    call("inputBroker", route.token, "function broker() view returns(address)"),
    call("outputMinter", USDM, "function isMinter(address) view returns(bool)", [BROKER]),
  ];
  for (const [label, target] of [["input", route.token], ["output", USDM], ["broker", BROKER], ["manager", MANAGER]]) {
    calls.push(call(`${label}Implementation`, target, "function _getImplementation() view returns(address)"));
  }
  for (const [label, token] of [["input", route.token], ["output", USDM]]) {
    const limitId = `0x${(BigInt(route.exchange) ^ BigInt(token)).toString(16).padStart(64, "0")}`;
    calls.push(call(`${label}Stable`, RESERVE, "function isStableAsset(address) view returns(bool)", [token]),
      call(`${label}Decimals`, token, "function decimals() view returns(uint8)"),
      call(`${label}Limits`, BROKER, "function tradingLimitsConfig(bytes32) view returns(uint32,uint32,int48,int48,int48,uint8)", [limitId]),
      call(`${label}State`, BROKER, "function tradingLimitsState(bytes32) view returns(uint32,uint32,int48,int48,int48)", [limitId]));
  }
  for (const [label, amount] of [["small", UNIT], ["depth", route.depth]] as const) calls.push(call(label, BROKER,
    "function getAmountOut(address,bytes32,address,address,uint256) view returns(uint256)", [MANAGER, route.exchange, route.token, USDM, amount]));
  const rows = await fetchEvmMulticall3Aggregate3AtBlock("celo", calls, block, options);
  throwIfAborted(signal);
  if (!rows || rows.length !== calls.length || rows.some((r, i) => !r.success || r.label !== calls[i].label)) return reject("state-unavailable");
  const closing = await fetchEvmBlockHeader("celo", block, options);
  throwIfAborted(signal);
  if (closing?.hash !== head.hash) {
    validatedHeads.delete(context);
    return reject("canonical-check");
  }
  const values = new Map(rows.map((r) => [r.label, r.returnData]));
  const raw = (label: string) => values.get(label)!;
  try {
    const uint = (label: string) => decodeAbiParameters(parseAbiParameters("uint256"), raw(label))[0];
    const address = (label: string) => decodeAbiParameters(parseAbiParameters("address"), raw(label))[0].toLowerCase();
    const bool = (label: string) => decodeAbiParameters(parseAbiParameters("bool"), raw(label))[0];
    if (address("reserve") !== RESERVE || address("managerBroker") !== BROKER || address("inputBroker") !== BROKER ||
      address("oracle") !== ORACLE || address("breaker") !== BREAKER || !bool("provider") || !bool("outputMinter") ||
      !bool("inputStable") || !bool("outputStable") || uint("inputDecimals") !== 18n || uint("outputDecimals") !== 18n) return reject("identity-permissions");
    // Reviewed V2 input burn role and standard V3 USDm mint/transfer semantics; upgrades require review.
    if (address("inputImplementation") !== "0x434563b0604be100f04b7ae485bcafe3c9d8850e" ||
      address("outputImplementation") !== "0x815795c30d0758a297b08cd4e0643620c974c318" ||
      address("brokerImplementation") !== "0x1b78f6acd05e7bcb00f74863bfd8a7c264143e37" ||
      address("managerImplementation") !== "0xc016174b60519bdc24433d4ed2cff6c1efac7881") return reject("implementation");
    const pool = decodeMentoPoolExchange(raw("pool"));
    const oracleTime = Number(uint("oracleTime"));
    if (pool.config.spread * 10_000n > 200n * MENTO_POOL_SPREAD_FIXIDITY_SCALE) return reject("spread");
    if (pool.asset0.toLowerCase() !== USDM || pool.asset1.toLowerCase() !== route.token || pool.config.referenceRateFeedID.toLowerCase() !== route.feed ||
      pool.config.referenceRateResetFrequency !== 360n || pool.config.minimumReports < 1n || uint("oracleCount") < pool.config.minimumReports ||
      uint("mode") !== 0n || decodeAbiParameters(parseAbiParameters("bool,address"), raw("expired"))[0] ||
      oracleTime > head.timestamp || head.timestamp - oracleTime >= 360) return reject("oracle-state");
    const small = uint("small"), depth = uint("depth");
    if (small <= 0n || depth <= 0n || depth * UNIT * 100n < small * route.depth * 95n || depth * UNIT * 100n > small * route.depth * 105n) return reject("quote-depth");
    for (const [label, amounts] of [["input", [UNIT, route.depth]], ["output", [-small, -depth]]] as const) {
      const config = decodeAbiParameters(CONFIG, raw(`${label}Limits`));
      const state = decodeAbiParameters(STATE, raw(`${label}State`));
      // MGP-18 reviewed global-only configuration. Other configurations fail closed.
      if (config[5] !== 4 || config[0] !== 0 || config[1] !== 0 || config[2] !== 0 || config[3] !== 0 || config[4] <= 0) return reject("limit-config");
      for (const amount of amounts) {
        const delta = amount / UNIT || (amount > 0n ? 1n : -1n);
        if (delta < -(1n << 47n) || delta > (1n << 47n) - 1n) return reject("trading-limits");
        const flow = BigInt(state[4]) + delta;
        if (flow > BigInt(config[4]) || flow < -BigInt(config[4]) || flow < -(1n << 47n) || flow > (1n << 47n) - 1n) return reject("trading-limits");
      }
    }
    const observedAt = Math.min(head.timestamp, oracleTime, parent.trustedParent.observedAt);
    const age = Math.floor(Date.now() / 1000) - observedAt;
    if (age < 0 || age >= 300) return reject("dependency-age");
    const price = Number(small) / Number(UNIT) * parent.trustedParent.price;
    if (!Number.isFinite(price) || price <= 0) return reject("price-invalid");
    validatedHeads.set(context, { block, head });
    return { price, source: "mento-broker", confidence: "fallback", observedAt, observedAtMode: "upstream" };
  } catch { return reject("state-malformed"); }
}
export const mentoBrokerProvider: PriceSourceProvider = {
  source: "mento-broker", liveMissingOnly: true, liveCircuitSource: CIRCUIT_SOURCE.MENTO_BROKER,
  livePriority: 1, liveTimeoutMs: 6_000, matches: (id) => Object.prototype.hasOwnProperty.call(ROUTES, id),
  async fetchLivePrice(asset: PeggedAsset, context: LivePriceContext, signal?: AbortSignal) {
    return hasPublishableCurrentPrice(asset) ? null : fetchMentoBrokerPrice(asset.id, context, signal);
  },
};
