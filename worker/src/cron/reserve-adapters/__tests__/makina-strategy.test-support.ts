/**
 * Shared makina-strategy wire fixtures for fetch-level tests.
 *
 * The strategy and allocations payloads are committed wire captures (see
 * `fixtures/makina-strategy.json`, `fixtures/makina-allocations.json`). The RPC
 * table answers the adapter's same-block AsyncRedeemer route reads: one
 * Multicall3 `aggregate3` batch over the redeemer/Machine/USDC/DUSD identities,
 * counters and balances, the EIP-1967 beacon slot storage read, the beacon
 * `implementation()` call, the reviewed implementation's runtime code, and the
 * `convertToAssets(lockedShares)` queue-depth call.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterNetworkSpec, AdapterRpcValue } from "./reserve-adapter.test-support";
import { EIP1967_BEACON_SLOT } from "../onchain-identity";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export const MAKINA_STRATEGY_FIXTURE = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "makina-strategy.json"), "utf8"),
);
export const MAKINA_ALLOCATIONS_FIXTURE = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "makina-allocations.json"), "utf8"),
);

// Runtime code of the reviewed AsyncRedeemer implementation
// 0x49c4762ab838f2e5d8252b69b90a1e8587a74511, captured from a public Ethereum
// RPC. Its keccak256 is the adapter's reviewed implementation-code pin, so
// serving the real bytes exercises the real identity check.
export const MAKINA_REVIEWED_IMPLEMENTATION_RUNTIME_CODE = readFileSync(
  join(FIXTURES_DIR, "makina-async-redeemer-runtime-code.txt"),
  "utf8",
).trim();

export const MAKINA_STRATEGY_URL =
  "https://api.makina.finance/v1/strategies/0x6b006870C83b1Cd49E766Ac9209f8d68763Df721";
export const MAKINA_ALLOCATIONS_URL = `${MAKINA_STRATEGY_URL}/allocations`;

export const MAKINA_MACHINE = "0x6b006870c83b1cd49e766ac9209f8d68763df721";
export const MAKINA_ASYNC_REDEEMER = "0x1303c26cfe06bac5bfee29907f37919643def75c";
export const MAKINA_DUSD = "0x1e33e98af620f1d563fcd3cfd3c75ace841204ef";
export const MAKINA_USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
export const MAKINA_BEACON = "0x1f20cdfa19b860f0dd78fefbb052be5aa5003dd9";
export const MAKINA_REVIEWED_IMPLEMENTATION = "0x49c4762ab838f2e5d8252b69b90a1e8587a74511";
export const MAKINA_REVIEWED_IMPLEMENTATION_CODE_HASH =
  "0x395083795e58602401305485b5328241fb589687c9edac0dddede880a083524f";
export const MAKINA_BLOCK = 25_646_765;
export const MAKINA_LOCKED_SHARES = 3_000n * 10n ** 18n;

const BALANCE_OF_SELECTOR = "0x70a08231";
const CONVERT_TO_ASSETS_SELECTOR = "0x07a2d13a";

/** 64-char ABI word body (no 0x prefix) for embedding in calldata routing keys. */
function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

/**
 * The same-block AsyncRedeemer route reads. Keys name the exact contract and
 * calldata the adapter sends; `overrides` swap individual answers for drift
 * cases.
 */
export function makinaRouteRpc(
  overrides: Record<string, AdapterRpcValue> = {},
): Record<string, AdapterRpcValue> {
  return {
    [`${MAKINA_ASYNC_REDEEMER}:0x75c60225`]: MAKINA_MACHINE, // machine()
    [`${MAKINA_MACHINE}:0xda68cf8b`]: MAKINA_USDC, // accountingToken()
    [`${MAKINA_MACHINE}:0x6c9fa59e`]: MAKINA_DUSD, // shareToken()
    [`${MAKINA_USDC}:${BALANCE_OF_SELECTOR}${word(BigInt(MAKINA_MACHINE))}`]: 120_722_783n, // Machine idle USDC
    [`${MAKINA_DUSD}:${BALANCE_OF_SELECTOR}${word(BigInt(MAKINA_ASYNC_REDEEMER))}`]: MAKINA_LOCKED_SHARES, // locked DUSD
    [`${MAKINA_USDC}:${BALANCE_OF_SELECTOR}${word(BigInt(MAKINA_ASYNC_REDEEMER))}`]: 3_679n, // reserved unclaimed USDC
    [`${MAKINA_ASYNC_REDEEMER}:0x184d69ab`]: 0, // whitelist enabled
    [`${MAKINA_ASYNC_REDEEMER}:0x1c34eb35`]: 1, // sanctions check enabled
    [`${MAKINA_ASYNC_REDEEMER}:0xf9823a5c`]: 43_200, // minimum finalization delay
    [`${MAKINA_ASYNC_REDEEMER}:0x6a84a985`]: 344, // next request id
    [`${MAKINA_ASYNC_REDEEMER}:0x667a739e`]: 342, // last finalized request id
    [`${MAKINA_ASYNC_REDEEMER}:0x0912ae6d`]: 10n ** 18n, // minimum redeem shares
    [`eth_getStorageAt:${MAKINA_ASYNC_REDEEMER}:${EIP1967_BEACON_SLOT}`]: MAKINA_BEACON,
    [`${MAKINA_BEACON}:0x5c60da1b`]: MAKINA_REVIEWED_IMPLEMENTATION, // beacon.implementation()
    [`${MAKINA_MACHINE}:${CONVERT_TO_ASSETS_SELECTOR}${word(MAKINA_LOCKED_SHARES)}`]: 3_104_889_979n, // convertToAssets(locked)
    ...overrides,
  };
}

/** Full network spec for one makina-strategy fetch, with per-case overrides. */
export function makinaNetworkSpec(
  options: {
    allocations?: unknown;
    rpc?: Record<string, AdapterRpcValue>;
    code?: Record<string, string>;
  } = {},
): AdapterNetworkSpec {
  return {
    json: {
      [MAKINA_STRATEGY_URL]: MAKINA_STRATEGY_FIXTURE,
      [MAKINA_ALLOCATIONS_URL]: options.allocations ?? MAKINA_ALLOCATIONS_FIXTURE,
    },
    rpc: makinaRouteRpc(options.rpc),
    code: {
      [`ethereum:${MAKINA_REVIEWED_IMPLEMENTATION}`]: MAKINA_REVIEWED_IMPLEMENTATION_RUNTIME_CODE,
      ...options.code,
    },
    block: { number: MAKINA_BLOCK },
  };
}
