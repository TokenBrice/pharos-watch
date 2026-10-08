import type { AdapterResult } from "../types";
import type { ReservoirReservesResponse } from "../reservoir";
import {
  runAdapter,
  type AdapterNetworkSpec,
  type AdapterRpcValue,
  type AdapterRun,
} from "./reserve-adapter.test-support";

export const RESERVOIR_ENDPOINT = "https://fireworks-git-master-fortunafi.vercel.app/api/reserves/raw";
const RESERVOIR_ORIGIN = "https://fireworks-git-master-fortunafi.vercel.app";

const PSM_ADDRESS = "0x4809010926aec940b550d34a46a52739f996d75d";
const USDC_ADDRESS = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const SAVING_MODULE_ADDRESS = "0x5475611dffb8ef4d697ae39df9395513b6e947d7";
const DEFAULT_PSM_BALANCE = 4_000000n;
const DEFAULT_REDEEM_FEE = 134n;
const RUSD_ADDRESS = "0x09d4214c03d01f49544c0448dbe3a27f768f2b34";
const SRUSD_ADDRESS = "0x738d1115b90efa71ae468f1287fc864775e23a31";
const WSRUSD_ADDRESS = "0xd3fd63209fa2d55b07a0f6db36c2f43900be3094";

export interface ReservoirNetworkOptions {
  /** PSM `underlying()` answer; `null` routes a revert. Defaults to pinned Circle USDC. */
  underlying?: string | null;
  /** PSM `underlyingBalance()` answer in 6-decimal raw units; `null` routes a revert. */
  balance?: bigint | null;
  /** PSM `paused()` answer; `null` routes a revert. */
  paused?: boolean | null;
  /** SavingModule `redeemFee()` answer; `null` routes a revert. */
  redeemFee?: bigint | null;
  currentPrice?: bigint;
  wrapperRate?: bigint;
  wrapperAsset?: string | null;
  mintAuthorized?: boolean | null;
  rpcOverrides?: Record<string, AdapterRpcValue>;
  blockTimestamp?: number;
  failPin?: boolean;
  onPin?: () => void;
  onHeader?: () => void;
  /** Answer the browser-header request with 403 so the neutral-header fallback runs. */
  rejectBrowserHeaders?: boolean;
}

/**
 * Wire the Reservoir balance-sheet endpoint plus the same-run PSM and
 * SavingModule reads. The endpoint responder only answers requests that carry
 * the complete same-origin browser fetch identity or no `origin` at all, so a
 * partial or unexpected header set fails the test instead of being answered.
 */
export function reservoirNetwork(
  payload: ReservoirReservesResponse,
  options: ReservoirNetworkOptions = {},
): AdapterNetworkSpec {
  const rpc: Record<string, AdapterRpcValue> = {
    [`${PSM_ADDRESS}:0x6f307dc3`]: options.underlying === undefined ? USDC_ADDRESS : options.underlying,
    [`${PSM_ADDRESS}:0x59356c5c`]: options.balance === undefined ? DEFAULT_PSM_BALANCE : options.balance,
    [`${PSM_ADDRESS}:paused()`]: options.paused === undefined ? false : options.paused,
    [`${SAVING_MODULE_ADDRESS}:0x965fa21e`]: options.redeemFee === undefined ? DEFAULT_REDEEM_FEE : options.redeemFee,
    [`${PSM_ADDRESS}:rusd()`]: RUSD_ADDRESS,
    [`${PSM_ADDRESS}:DECIMAL_FACTOR()`]: 6n,
    [`${USDC_ADDRESS}:decimals()`]: 6n,
    [`${RUSD_ADDRESS}:decimals()`]: 18n,
    [`${RUSD_ADDRESS}:MINTER()`]: `0x${"1".repeat(64)}`,
    [`${RUSD_ADDRESS}:hasRole(bytes32,address)`]: options.mintAuthorized === undefined ? true : options.mintAuthorized,
    [`${SAVING_MODULE_ADDRESS}:rusd()`]: RUSD_ADDRESS,
    [`${SAVING_MODULE_ADDRESS}:srusd()`]: SRUSD_ADDRESS,
    [`${SAVING_MODULE_ADDRESS}:currentPrice()`]: options.currentPrice ?? 100_000_001n,
    [`${SRUSD_ADDRESS}:decimals()`]: 18n,
    [`${SAVING_MODULE_ADDRESS}:previewRedeem(uint256)`]: (call) => {
      const amount = BigInt(`0x${call.data.slice(10)}`);
      const price = options.currentPrice ?? 100_000_001n;
      return price > 0n ? (amount * 100_000_000n + price - 1n) / price : 0n;
    },
    [`${WSRUSD_ADDRESS}:asset()`]: options.wrapperAsset === undefined ? RUSD_ADDRESS : options.wrapperAsset,
    [`${WSRUSD_ADDRESS}:decimals()`]: 18n,
    [`${WSRUSD_ADDRESS}:previewRedeem(uint256)`]: (call) =>
      BigInt(`0x${call.data.slice(10)}`) * (options.wrapperRate ?? 1_100_000_000_000_000_001n) / 10n ** 18n,
    [`${WSRUSD_ADDRESS}:previewWithdraw(uint256)`]: (call) =>
      BigInt(`0x${call.data.slice(10)}`) * 10n ** 18n / (options.wrapperRate ?? 1_100_000_000_000_000_001n),
    eth_blockNumber: () => {
      options.onPin?.();
      if (options.failPin) throw new Error("Fixture pin unavailable");
      return 26_142_993;
    },
    eth_getBlockByNumber: () => {
      options.onHeader?.();
      return { number: 26_142_993, timestamp: options.blockTimestamp ?? Math.floor(Date.now() / 1000) };
    },
    ...options.rpcOverrides,
  };
  return {
    json: {
      [RESERVOIR_ENDPOINT]: (request: Request) => {
        const browser = request.headers.get("origin") === RESERVOIR_ORIGIN
          && request.headers.get("referer") === `${RESERVOIR_ORIGIN}/reserves`
          && request.headers.get("accept") === "application/json, text/plain, */*"
          && request.headers.get("sec-fetch-dest") === "empty"
          && request.headers.get("sec-fetch-mode") === "cors"
          && request.headers.get("sec-fetch-site") === "same-origin";
        if (browser && options.rejectBrowserHeaders) return { status: 403, json: {} };
        if (!browser && request.headers.has("origin")) throw new Error("Unexpected Reservoir origin header");
        return payload;
      },
    },
    block: { number: 26_142_993, timestamp: options.blockTimestamp ?? Math.floor(Date.now() / 1000) },
    rpc,
  };
}

/** Run the registered reservoir adapter end to end against the catalog config. */
export function runReservoir(
  coinId: string,
  payload: ReservoirReservesResponse,
  options: ReservoirNetworkOptions = {},
): Promise<AdapterRun> {
  return runAdapter("reservoir", coinId, { network: reservoirNetwork(payload, options) });
}

export function reservoirSnapshot(result: AdapterResult, now: number, coinId = "wsrusd-reservoir") {
  if (!result.metadata) throw new Error("Reservoir fixture did not emit metadata");
  return {
    stablecoinId: coinId, fetchedAt: now, source: "reservoir", metadata: result.metadata,
    warningCount: 0, warnings: [], sourceModel: "dynamic-mix" as const,
    evidenceClass: "independent" as const, syncStatus: "ok" as const,
  };
}
