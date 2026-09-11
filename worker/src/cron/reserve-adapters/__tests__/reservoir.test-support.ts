import type { AdapterResult } from "../types";
import type { ReservoirReservesResponse } from "../reservoir";
import {
  runAdapter,
  type AdapterNetworkSpec,
  type AdapterRpcValue,
  type AdapterRun,
} from "./reserve-adapter.test-support";

export const RESERVOIR_ENDPOINT = "https://app.reservoir.xyz/api/reserves/raw";

const PSM_ADDRESS = "0x4809010926aec940b550d34a46a52739f996d75d";
const USDC_ADDRESS = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const SAVING_MODULE_ADDRESS = "0x5475611dffb8ef4d697ae39df9395513b6e947d7";
const DEFAULT_PSM_BALANCE = 4_000000n;
const DEFAULT_REDEEM_FEE = 134n;

export interface ReservoirNetworkOptions {
  /** PSM `underlying()` answer; `null` routes a revert. Defaults to pinned Circle USDC. */
  underlying?: string | null;
  /** PSM `underlyingBalance()` answer in 6-decimal raw units; `null` routes a revert. */
  balance?: bigint | null;
  /** PSM `paused()` answer; `null` routes a revert. */
  paused?: boolean | null;
  /** SavingModule `redeemFee()` answer; `null` routes a revert. */
  redeemFee?: bigint | null;
  /** Answer the browser-header request with 403 so the neutral-header fallback runs. */
  rejectBrowserHeaders?: boolean;
}

/**
 * Wire the reservoir balance-sheet endpoint plus the same-run PSM and
 * SavingModule reads. The endpoint responder only answers requests that carry
 * either the exact browser header pair or no `origin` at all, so a request with
 * unexpected headers fails the test instead of being answered.
 */
export function reservoirNetwork(
  payload: ReservoirReservesResponse,
  options: ReservoirNetworkOptions = {},
): AdapterNetworkSpec {
  const rpc: Record<string, AdapterRpcValue> = {
    [`${PSM_ADDRESS}:0x6f307dc3`]: options.underlying === undefined ? USDC_ADDRESS : options.underlying,
    [`${PSM_ADDRESS}:0x59356c5c`]: options.balance === undefined ? DEFAULT_PSM_BALANCE : options.balance,
    [`${PSM_ADDRESS}:0x5c975abb`]: options.paused === undefined ? false : options.paused,
    [`${SAVING_MODULE_ADDRESS}:0x965fa21e`]: options.redeemFee === undefined ? DEFAULT_REDEEM_FEE : options.redeemFee,
  };
  return {
    json: {
      [RESERVOIR_ENDPOINT]: (request: Request) => {
        const browser = request.headers.get("origin") === "https://app.reservoir.xyz"
          && request.headers.get("referer") === "https://app.reservoir.xyz/reserves";
        if (browser && options.rejectBrowserHeaders) return { status: 403, json: {} };
        if (!browser && request.headers.has("origin")) throw new Error("Unexpected Reservoir origin header");
        return payload;
      },
    },
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

export function reservoirSnapshot(result: AdapterResult, now: number) {
  if (!result.metadata) throw new Error("Reservoir fixture did not emit metadata");
  return {
    stablecoinId: "wsrusd-reservoir", fetchedAt: now, source: "reservoir", metadata: result.metadata,
    warningCount: 0, warnings: [], sourceModel: "dynamic-mix" as const,
    evidenceClass: "independent" as const, syncStatus: "ok" as const,
  };
}
