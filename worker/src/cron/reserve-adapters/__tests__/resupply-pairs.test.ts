import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { encodeAbiParameters } from "viem/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  const fetchOnchainRawCall = vi.fn();
  return {
    ...actual,
    fetchOnchainRawCall,
    makeOnchainCallers: vi.fn((input, options) => ({
      uint256: vi.fn(),
      raw: (contract: string, data: string) =>
        fetchOnchainRawCall({
          ...options,
          contract,
          data,
          rpcMode: input.rpcMode,
          chain: input.chain,
        }),
    })),
  };
});

import { fetchOnchainRawCall } from "../helpers";
import { adaptResupplyPairSnapshots, fetchResupplyPairsReserves } from "../resupply-pairs";

const signal = AbortSignal.timeout(5_000);
const CURVE_PAIR = "0xC5184cccf85b81EDdc661330acB3E41bd89F34A1";
const FRAX_PAIR = "0x3F2b20b8E8Ce30bb52239d3dFADf826eCFE6A5f7";
const EMPTY_PAIR = "0x212589B06EBBA4d89d9deFcc8DDc58D80E141EA0";
const CRVUSD = "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e";
const FRXUSD = "0xcacd6fd266af91b8aed52accc382b4e165586e29";
const CURVE_COLLATERAL = "0x8e3009b59200668e1efda0a2f2ac42b24baa2982";
const FRAX_COLLATERAL = "0xab3cb84c310186b2fa4b4503624a5d90b5dcb22d";
const EMPTY_COLLATERAL = "0x1111111111111111111111111111111111111111";
const UNDERLYING_SELECTOR = "0x6f307dc3";
const COLLATERAL_SELECTOR = "0xd8dfeb45";
const GET_PAIR_ACCOUNTING_SELECTOR = "0xcdd72d52";
const CONVERT_TO_ASSETS_SELECTOR = "0x07a2d13a";
const GET_MAX_REDEEMABLE_DEBT_SELECTOR = "0x43bad45b";
const GUARD_ENABLED_SELECTOR = "0x901654fc";
const PERMISSIONLESS_PRICE_THRESHOLD_SELECTOR = "0x0e3d9f3c";
const REUSD_ORACLE_PRICE_SELECTOR = "0xc6af1dda";
const REDEMPTION_HANDLER = "0x5eeB063d0abefBBc78F576E28d762a16b637A025";
const ONE = 1_000_000_000_000_000_000n;

const coin = {
  id: "reusd-resupply",
  symbol: "REUSD",
  contracts: [{ chain: "ethereum", address: "0x57ab1e0003f623289cd798b1824be09a793e4bec", decimals: 18 }],
};

function encodeAddressResult(address: string): `0x${string}` {
  return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

function encodePairAccounting(totalBorrowAmount: bigint, totalCollateralShares: bigint): `0x${string}` {
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "uint256" }],
    [0n, totalBorrowAmount, totalBorrowAmount, totalCollateralShares],
  );
}

function encodeUint256Result(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function encodeBoolResult(value: boolean): `0x${string}` {
  return encodeUint256Result(value ? 1n : 0n);
}

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

const underlyings = [
  {
    address: CRVUSD,
    name: "Curve crvUSD lending markets",
    risk: "high" as const,
    coinId: "crvusd-curve",
    depType: "collateral" as const,
  },
  {
    address: FRXUSD,
    name: "Frax frxUSD lending markets",
    risk: "high" as const,
    coinId: "frxusd-frax",
    depType: "collateral" as const,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resupply-pairs adapter", () => {
  it("aggregates converted collateral assets by reviewed underlying", () => {
    const result = adaptResupplyPairSnapshots(
      [
        {
          pairKey: "PAIR_CURVELEND_SFRXUSD_CRVUSD",
          pairAddress: CURVE_PAIR,
          underlyingAddress: CRVUSD,
          collateralAddress: CURVE_COLLATERAL,
          totalBorrowAmount: 60n * ONE,
          totalBorrowShares: 60n * ONE,
          totalCollateralShares: 100n * ONE,
          totalCollateralAssets: 80n * ONE,
          maxRedeemableDebt: 50n * ONE,
        },
        {
          pairKey: "PAIR_FRAXLEND_SFRXETH_FRXUSD",
          pairAddress: FRAX_PAIR,
          underlyingAddress: FRXUSD,
          collateralAddress: FRAX_COLLATERAL,
          totalBorrowAmount: 40n * ONE,
          totalBorrowShares: 40n * ONE,
          totalCollateralShares: 80n * ONE,
          totalCollateralAssets: 120n * ONE,
          maxRedeemableDebt: 30n * ONE,
        },
        {
          pairKey: "PAIR_FRAXLEND_SUSDE_FRXUSD",
          pairAddress: EMPTY_PAIR,
          underlyingAddress: FRXUSD,
          collateralAddress: EMPTY_COLLATERAL,
          totalBorrowAmount: 0n,
          totalBorrowShares: 0n,
          totalCollateralShares: 0n,
          totalCollateralAssets: 0n,
          maxRedeemableDebt: 0n,
        },
      ],
      underlyings,
      {
        redemptionHandlerAddress: REDEMPTION_HANDLER.toLowerCase() as `0x${string}`,
        guard: {
          guardEnabled: true,
          permissionlessPriceThreshold: 985_000_000_000_000_000n,
          reUsdOraclePrice: 970_000_000_000_000_000n,
        },
      },
    );

    expect(result.slices).toEqual([
      { name: "Frax frxUSD lending markets", pct: 60, risk: "high", coinId: "frxusd-frax", depType: "collateral" },
      { name: "Curve crvUSD lending markets", pct: 40, risk: "high", coinId: "crvusd-curve", depType: "collateral" },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      totalBorrowUsd: 100,
      totalCollateralAssetsUsd: 200,
      immediateRedeemableUsd: 80,
      redemption: {
        capacityUsd: 80,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusSource: "onchain",
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        guardEnabled: true,
        reUsdOraclePrice: 0.97,
        permissionlessPriceThreshold: 0.985,
      },
      pairCount: 3,
      activePairCount: 2,
      details: {
        proofKind: "resupply-pair-accounting",
      },
    });
  });

  it("fails closed on unmapped positive-collateral underlyings", () => {
    expect(() =>
      adaptResupplyPairSnapshots(
        [
          {
            pairKey: "PAIR_UNKNOWN",
            pairAddress: CURVE_PAIR,
            underlyingAddress: "0x0000000000000000000000000000000000000001",
            collateralAddress: CURVE_COLLATERAL,
            totalBorrowAmount: ONE,
            totalBorrowShares: ONE,
            totalCollateralShares: 2n * ONE,
            totalCollateralAssets: 2n * ONE,
            maxRedeemableDebt: ONE,
          },
        ],
        underlyings,
      ),
    ).toThrow(/unmapped positive-collateral underlying/);
  });

  it("fetches independent pairs with bounded fan-out", async () => {
    const config: LiveReservesConfig = {
      adapter: "resupply-pairs",
      version: 1,
      semantics: "collateral-mix",
      breakerScope: "reusd-resupply",
      display: { url: "https://resupply.fi/supply", label: "Resupply markets" },
      inputs: {
        primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      },
      params: {
        rpcUrl: "https://ethereum-rpc.publicnode.com",
        fallbackRpcUrl: "https://eth.llamarpc.com",
        pairs: [
          { key: "PAIR_CURVELEND_SFRXUSD_CRVUSD", address: CURVE_PAIR },
          { key: "PAIR_FRAXLEND_SFRXETH_FRXUSD", address: FRAX_PAIR },
        ],
        underlyings,
      },
    };

    let resolveCurveUnderlying!: (value: `0x${string}`) => void;
    let resolveFraxUnderlying!: (value: `0x${string}`) => void;
    const curveUnderlying = new Promise<`0x${string}`>((resolve) => {
      resolveCurveUnderlying = resolve;
    });
    const fraxUnderlying = new Promise<`0x${string}`>((resolve) => {
      resolveFraxUnderlying = resolve;
    });
    const calls: string[] = [];

    vi.mocked(fetchOnchainRawCall).mockImplementation(async ({ contract, data }) => {
      const normalizedContract = normalizeAddress(contract);
      calls.push(`${normalizedContract}:${data}`);
      if (normalizedContract === normalizeAddress(CURVE_PAIR) && data === UNDERLYING_SELECTOR) {
        return curveUnderlying;
      }
      if (normalizedContract === normalizeAddress(FRAX_PAIR) && data === UNDERLYING_SELECTOR) {
        return fraxUnderlying;
      }
      if (normalizedContract === normalizeAddress(CURVE_PAIR) && data === COLLATERAL_SELECTOR) {
        return encodeAddressResult(CURVE_COLLATERAL);
      }
      if (normalizedContract === normalizeAddress(FRAX_PAIR) && data === COLLATERAL_SELECTOR) {
        return encodeAddressResult(FRAX_COLLATERAL);
      }
      if (normalizedContract === normalizeAddress(CURVE_PAIR) && data === GET_PAIR_ACCOUNTING_SELECTOR) {
        return encodePairAccounting(75n * ONE, 100n * ONE);
      }
      if (normalizedContract === normalizeAddress(FRAX_PAIR) && data === GET_PAIR_ACCOUNTING_SELECTOR) {
        return encodePairAccounting(25n * ONE, 100n * ONE);
      }
      if (normalizedContract === normalizeAddress(CURVE_COLLATERAL) && data.startsWith(CONVERT_TO_ASSETS_SELECTOR)) {
        return encodeUint256Result(60n * ONE);
      }
      if (normalizedContract === normalizeAddress(FRAX_COLLATERAL) && data.startsWith(CONVERT_TO_ASSETS_SELECTOR)) {
        return encodeUint256Result(40n * ONE);
      }
      return null;
    });

    const resultPromise = fetchResupplyPairsReserves(coin as never, config, signal);
    await Promise.resolve();

    expect(calls).toContain(`${normalizeAddress(CURVE_PAIR)}:${UNDERLYING_SELECTOR}`);
    expect(calls).toContain(`${normalizeAddress(FRAX_PAIR)}:${UNDERLYING_SELECTOR}`);

    resolveCurveUnderlying(encodeAddressResult(CRVUSD));
    resolveFraxUnderlying(encodeAddressResult(FRXUSD));

    const result = await resultPromise;
    expect(result.metadata).toMatchObject({
      pairCount: 2,
      activePairCount: 2,
      totalBorrowUsd: 100,
      totalCollateralAssetsUsd: 100,
    });
  });

  it("reads reviewed pairs and converts collateral shares to assets onchain", async () => {
    const config: LiveReservesConfig = {
      adapter: "resupply-pairs",
      version: 1,
      semantics: "collateral-mix",
      breakerScope: "reusd-resupply",
      display: { url: "https://resupply.fi/supply", label: "Resupply markets" },
      inputs: {
        primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      },
      params: {
        rpcUrl: "https://ethereum-rpc.publicnode.com",
        fallbackRpcUrl: "https://eth.llamarpc.com",
        redemptionHandlerAddress: REDEMPTION_HANDLER,
        pairs: [
          { key: "PAIR_CURVELEND_SFRXUSD_CRVUSD", address: CURVE_PAIR },
          { key: "PAIR_FRAXLEND_SFRXETH_FRXUSD", address: FRAX_PAIR },
          { key: "PAIR_FRAXLEND_SUSDE_FRXUSD", address: EMPTY_PAIR },
        ],
        underlyings,
      },
    };

    vi.mocked(fetchOnchainRawCall).mockImplementation(async ({ contract, data }) => {
      const normalizedContract = normalizeAddress(contract);
      if (normalizedContract === normalizeAddress(CURVE_PAIR) && data === UNDERLYING_SELECTOR) {
        return encodeAddressResult(CRVUSD);
      }
      if (normalizedContract === normalizeAddress(FRAX_PAIR) && data === UNDERLYING_SELECTOR) {
        return encodeAddressResult(FRXUSD);
      }
      if (normalizedContract === normalizeAddress(EMPTY_PAIR) && data === UNDERLYING_SELECTOR) {
        return encodeAddressResult(FRXUSD);
      }
      if (normalizedContract === normalizeAddress(CURVE_PAIR) && data === COLLATERAL_SELECTOR) {
        return encodeAddressResult(CURVE_COLLATERAL);
      }
      if (normalizedContract === normalizeAddress(FRAX_PAIR) && data === COLLATERAL_SELECTOR) {
        return encodeAddressResult(FRAX_COLLATERAL);
      }
      if (normalizedContract === normalizeAddress(EMPTY_PAIR) && data === COLLATERAL_SELECTOR) {
        return encodeAddressResult(EMPTY_COLLATERAL);
      }
      if (normalizedContract === normalizeAddress(CURVE_PAIR) && data === GET_PAIR_ACCOUNTING_SELECTOR) {
        return encodePairAccounting(75n * ONE, 100n * ONE);
      }
      if (normalizedContract === normalizeAddress(FRAX_PAIR) && data === GET_PAIR_ACCOUNTING_SELECTOR) {
        return encodePairAccounting(25n * ONE, 100n * ONE);
      }
      if (normalizedContract === normalizeAddress(EMPTY_PAIR) && data === GET_PAIR_ACCOUNTING_SELECTOR) {
        return encodePairAccounting(0n, 0n);
      }
      if (normalizedContract === normalizeAddress(REDEMPTION_HANDLER) && data === GUARD_ENABLED_SELECTOR) {
        return encodeBoolResult(true);
      }
      if (
        normalizedContract === normalizeAddress(REDEMPTION_HANDLER) &&
        data === PERMISSIONLESS_PRICE_THRESHOLD_SELECTOR
      ) {
        return encodeUint256Result(985_000_000_000_000_000n);
      }
      if (normalizedContract === normalizeAddress(REDEMPTION_HANDLER) && data === REUSD_ORACLE_PRICE_SELECTOR) {
        return encodeUint256Result(990_000_000_000_000_000n);
      }
      if (
        normalizedContract === normalizeAddress(REDEMPTION_HANDLER) &&
        data.startsWith(GET_MAX_REDEEMABLE_DEBT_SELECTOR)
      ) {
        if (data.toLowerCase().endsWith(CURVE_PAIR.toLowerCase().replace(/^0x/, "").padStart(64, "0"))) {
          return encodeUint256Result(50n * ONE);
        }
        if (data.toLowerCase().endsWith(FRAX_PAIR.toLowerCase().replace(/^0x/, "").padStart(64, "0"))) {
          return encodeUint256Result(25n * ONE);
        }
        if (data.toLowerCase().endsWith(EMPTY_PAIR.toLowerCase().replace(/^0x/, "").padStart(64, "0"))) {
          return encodeUint256Result(0n);
        }
      }
      if (normalizedContract === normalizeAddress(CURVE_COLLATERAL) && data.startsWith(CONVERT_TO_ASSETS_SELECTOR)) {
        return encodeUint256Result(60n * ONE);
      }
      if (normalizedContract === normalizeAddress(FRAX_COLLATERAL) && data.startsWith(CONVERT_TO_ASSETS_SELECTOR)) {
        return encodeUint256Result(40n * ONE);
      }
      if (normalizedContract === normalizeAddress(EMPTY_COLLATERAL) && data.startsWith(CONVERT_TO_ASSETS_SELECTOR)) {
        return encodeUint256Result(0n);
      }
      return null;
    });

    const result = await fetchResupplyPairsReserves(coin as never, config, signal);

    expect(result.slices).toEqual([
      { name: "Curve crvUSD lending markets", pct: 60, risk: "high", coinId: "crvusd-curve", depType: "collateral" },
      { name: "Frax frxUSD lending markets", pct: 40, risk: "high", coinId: "frxusd-frax", depType: "collateral" },
    ]);
    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      totalBorrowUsd: 100,
      totalCollateralAssetsUsd: 100,
      immediateRedeemableUsd: 75,
      redemption: {
        capacityUsd: 75,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus: "cohort-limited",
        routeStatusSource: "onchain",
        holderEligibility: "whitelisted-primary",
        settlementDelaySec: 0,
        guardEnabled: true,
        reUsdOraclePrice: 0.99,
        permissionlessPriceThreshold: 0.985,
      },
      pairCount: 3,
      activePairCount: 2,
    });
    expect(fetchOnchainRawCall).toHaveBeenCalledTimes(18);
  });
});
