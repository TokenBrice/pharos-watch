import { encodeAbiParameters } from "viem/utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adaptResupplyPairSnapshots } from "../resupply-pairs";
import {
  installAdapterNetwork,
  runAdapter,
  type AdapterNetwork,
  type AdapterNetworkSpec,
  type AdapterRpcValue,
} from "./reserve-adapter.test-support";

afterEach(() => vi.unstubAllGlobals());

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
const ASSET_SELECTOR = "0x38d52e0f";
const DECIMALS_SELECTOR = "0x313ce567";
const REDEMPTION_HANDLER = "0x5eeB063d0abefBBc78F576E28d762a16b637A025";
const ONE = 1_000_000_000_000_000_000n;
const NOW_SEC = 1_800_000_000;

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

function encodePairAccounting(totalBorrowAmount: bigint, totalCollateralShares: bigint): `0x${string}` {
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "uint256" }],
    [0n, totalBorrowAmount, totalBorrowAmount, totalCollateralShares],
  );
}

interface ResupplyPairAnswers {
  underlying: string;
  collateral: string;
  totalBorrowAmount: bigint;
  totalCollateralShares: bigint;
  maxRedeemableDebt: bigint;
  collateralAssets: bigint;
  vaultAsset: string;
}

function pairAnswers(
  overrides: Partial<ResupplyPairAnswers> & Pick<ResupplyPairAnswers, "underlying" | "collateral">,
): ResupplyPairAnswers {
  return {
    totalBorrowAmount: 0n,
    totalCollateralShares: 0n,
    maxRedeemableDebt: 0n,
    collateralAssets: 0n,
    vaultAsset: overrides.underlying,
    ...overrides,
  };
}

interface ResupplyGuardAnswers {
  guardEnabled: boolean;
  permissionlessPriceThreshold: bigint;
  reUsdOraclePrice: bigint;
}

const DEFAULT_GUARD: ResupplyGuardAnswers = {
  guardEnabled: true,
  permissionlessPriceThreshold: 985_000_000_000_000_000n,
  reUsdOraclePrice: 970_000_000_000_000_000n,
};

/**
 * Answer the reviewed RedemptionHandler reads, per-pair accounting, and the
 * second-stage collateral conversion. `getMaxRedeemableDebt` is keyed by the
 * encoded pair argument (the calldata's trailing 32-byte address word),
 * mirroring the on-chain call shape.
 */
function resupplyNetwork(
  pairs: Record<string, ResupplyPairAnswers>,
  options: { decimals?: Record<string, bigint | null>; guard?: ResupplyGuardAnswers } = {},
): AdapterNetworkSpec {
  const guard = options.guard ?? DEFAULT_GUARD;
  const rpc: Record<string, AdapterRpcValue> = {
    [`${REDEMPTION_HANDLER}:${GUARD_ENABLED_SELECTOR}`]: guard.guardEnabled,
    [`${REDEMPTION_HANDLER}:${PERMISSIONLESS_PRICE_THRESHOLD_SELECTOR}`]: guard.permissionlessPriceThreshold,
    [`${REDEMPTION_HANDLER}:${REUSD_ORACLE_PRICE_SELECTOR}`]: guard.reUsdOraclePrice,
    [`${REDEMPTION_HANDLER}:${GET_MAX_REDEEMABLE_DEBT_SELECTOR}`]: ({ data }) => {
      for (const [pair, answer] of Object.entries(pairs)) {
        if (data.endsWith(pair.toLowerCase().replace(/^0x/, "").padStart(64, "0"))) return answer.maxRedeemableDebt;
      }
      return null;
    },
  };
  for (const [contract, value] of Object.entries(options.decimals ?? { [CRVUSD]: 18n, [FRXUSD]: 18n })) {
    rpc[`${contract}:${DECIMALS_SELECTOR}`] = value;
  }
  for (const [pair, answer] of Object.entries(pairs)) {
    rpc[`${pair}:${UNDERLYING_SELECTOR}`] = answer.underlying;
    rpc[`${pair}:${COLLATERAL_SELECTOR}`] = answer.collateral;
    rpc[`${pair}:${GET_PAIR_ACCOUNTING_SELECTOR}`] = encodePairAccounting(
      answer.totalBorrowAmount,
      answer.totalCollateralShares,
    );
    rpc[`${answer.collateral}:${CONVERT_TO_ASSETS_SELECTOR}`] = answer.collateralAssets;
    rpc[`${answer.collateral}:${ASSET_SELECTOR}`] = answer.vaultAsset;
  }
  return { rpc };
}

const DEFAULT_PAIRS = [
  { key: "PAIR_CURVELEND_SFRXUSD_CRVUSD", address: CURVE_PAIR },
  { key: "PAIR_FRAXLEND_SFRXETH_FRXUSD", address: FRAX_PAIR },
];

function runResupply(options: {
  network: AdapterNetworkSpec | AdapterNetwork;
  pairs?: { key: string; address: string }[];
}) {
  return runAdapter("resupply-pairs", "reusd-resupply", {
    network: options.network,
    params: { pairs: options.pairs ?? DEFAULT_PAIRS },
    nowSec: NOW_SEC,
  });
}

describe("resupply-pairs adapter", () => {
  it("aggregates converted collateral assets by reviewed underlying", () => {
    const result = adaptResupplyPairSnapshots(
      [
        {
          pairKey: "PAIR_CURVELEND_SFRXUSD_CRVUSD",
          pairAddress: CURVE_PAIR,
          underlyingAddress: CRVUSD,
          collateralAddress: CURVE_COLLATERAL,
          underlyingDecimals: 18,
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
          underlyingDecimals: 18,
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
          underlyingDecimals: 18,
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
      { sourceKey: "resupply-pairs:ethereum:0xcacd6fd266af91b8aed52accc382b4e165586e29", name: "Frax frxUSD lending markets", pct: 60, risk: "high", coinId: "frxusd-frax", depType: "collateral" },
      { sourceKey: "resupply-pairs:ethereum:0xf939e0a03fb07f59a73314e73794be0e57ac1b4e", name: "Curve crvUSD lending markets", pct: 40, risk: "high", coinId: "crvusd-curve", depType: "collateral" },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      totalBorrowUsd: 100,
      totalCollateralAssetsUsd: 200,
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
            underlyingDecimals: 18,
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
    let resolveCurveUnderlying!: (value: string) => void;
    let resolveFraxUnderlying!: (value: string) => void;
    const curveUnderlying = new Promise<string>((resolve) => {
      resolveCurveUnderlying = resolve;
    });
    const fraxUnderlying = new Promise<string>((resolve) => {
      resolveFraxUnderlying = resolve;
    });

    const spec = resupplyNetwork({
      [CURVE_PAIR]: pairAnswers({
        underlying: CRVUSD,
        collateral: CURVE_COLLATERAL,
        totalBorrowAmount: 75n * ONE,
        totalCollateralShares: 100n * ONE,
        maxRedeemableDebt: 75n * ONE,
        collateralAssets: 60n * ONE,
      }),
      [FRAX_PAIR]: pairAnswers({
        underlying: FRXUSD,
        collateral: FRAX_COLLATERAL,
        totalBorrowAmount: 25n * ONE,
        totalCollateralShares: 100n * ONE,
        maxRedeemableDebt: 25n * ONE,
        collateralAssets: 40n * ONE,
      }),
    });
    // Both underlyings stay in flight while the first-stage batch is on the
    // wire: the run must not serialize one pair's pipeline behind the other.
    spec.rpc![`${CURVE_PAIR}:${UNDERLYING_SELECTOR}`] = () => curveUnderlying;
    spec.rpc![`${FRAX_PAIR}:${UNDERLYING_SELECTOR}`] = () => fraxUnderlying;
    const network = installAdapterNetwork(spec);

    const runPromise = runResupply({ network });
    await vi.waitFor(() => {
      expect(network.requests.length).toBeGreaterThan(0);
    });
    resolveCurveUnderlying(CRVUSD);
    resolveFraxUnderlying(FRXUSD);

    const { result } = await runPromise;
    expect(result.metadata).toMatchObject({
      pairCount: 2,
      activePairCount: 2,
      totalBorrowUsd: 100,
      totalCollateralAssetsUsd: 100,
    });
    const underlyingCalls = network.rpcCalls.filter((call) => call.selector === UNDERLYING_SELECTOR);
    expect(underlyingCalls.map((call) => call.contract)).toEqual([CURVE_PAIR.toLowerCase(), FRAX_PAIR.toLowerCase()]);
    expect(underlyingCalls.every((call) => call.viaMulticall)).toBe(true);
  });

  it("reads reviewed pairs and converts collateral shares to assets onchain", async () => {
    const { result, network } = await runResupply({
      pairs: [
        ...DEFAULT_PAIRS,
        { key: "PAIR_FRAXLEND_SUSDE_FRXUSD", address: EMPTY_PAIR },
      ],
      network: resupplyNetwork(
        {
          [CURVE_PAIR]: pairAnswers({
            underlying: CRVUSD,
            collateral: CURVE_COLLATERAL,
            totalBorrowAmount: 75n * ONE,
            totalCollateralShares: 100n * ONE,
            maxRedeemableDebt: 50n * ONE,
            collateralAssets: 60n * ONE,
          }),
          [FRAX_PAIR]: pairAnswers({
            underlying: FRXUSD,
            collateral: FRAX_COLLATERAL,
            totalBorrowAmount: 25n * ONE,
            totalCollateralShares: 100n * ONE,
            maxRedeemableDebt: 25n * ONE,
            collateralAssets: 40n * ONE,
          }),
          [EMPTY_PAIR]: pairAnswers({
            underlying: FRXUSD,
            collateral: EMPTY_COLLATERAL,
            vaultAsset: FRXUSD,
          }),
        },
        { guard: { ...DEFAULT_GUARD, reUsdOraclePrice: 990_000_000_000_000_000n } },
      ),
    });

    expect(result.slices).toEqual([
      { sourceKey: "resupply-pairs:ethereum:0xf939e0a03fb07f59a73314e73794be0e57ac1b4e", name: "Curve crvUSD lending markets", pct: 60, risk: "high", coinId: "crvusd-curve", depType: "collateral" },
      { sourceKey: "resupply-pairs:ethereum:0xcacd6fd266af91b8aed52accc382b4e165586e29", name: "Frax frxUSD lending markets", pct: 40, risk: "high", coinId: "frxusd-frax", depType: "collateral" },
    ]);
    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      totalBorrowUsd: 100,
      totalCollateralAssetsUsd: 100,
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
    // Two batched multicalls (guard + pairs, then collateral conversion): 15
    // first-stage members plus 9 second-stage members, no stray direct reads.
    expect(network.rpcCalls).toHaveLength(24);
    expect(network.rpcCalls.every((call) => call.viaMulticall)).toBe(true);
  });

  it.each([
    { name: "the wrapper underlying reports 8 decimals", frxUsdDecimals: 8n, expectedFraxUsd: 40 },
    { name: "the wrapper underlying reports 18 decimals", frxUsdDecimals: 18n, expectedFraxUsd: 40 },
  ])("values each pair at its verified underlying decimals when $name", async ({ frxUsdDecimals, expectedFraxUsd }) => {
    const scale = 10n ** frxUsdDecimals;
    const { result } = await runResupply({
      network: resupplyNetwork(
        {
          [CURVE_PAIR]: pairAnswers({
            underlying: CRVUSD,
            collateral: CURVE_COLLATERAL,
            totalBorrowAmount: 45n * ONE,
            totalCollateralShares: 100n * ONE,
            maxRedeemableDebt: 45n * ONE,
            collateralAssets: 60n * ONE,
          }),
          [FRAX_PAIR]: pairAnswers({
            underlying: FRXUSD,
            collateral: FRAX_COLLATERAL,
            totalBorrowAmount: 30n * scale,
            totalCollateralShares: 100n * ONE,
            maxRedeemableDebt: 30n * scale,
            collateralAssets: 40n * scale,
          }),
        },
        { decimals: { [CRVUSD]: 18n, [FRXUSD]: frxUsdDecimals } },
      ),
    });

    expect(result.metadata).toMatchObject({
      totalBorrowUsd: 75,
      totalCollateralAssetsUsd: 60 + expectedFraxUsd,
    });
    expect(result.slices).toEqual([
      { sourceKey: "resupply-pairs:ethereum:0xf939e0a03fb07f59a73314e73794be0e57ac1b4e", name: "Curve crvUSD lending markets", pct: 60, risk: "high", coinId: "crvusd-curve", depType: "collateral" },
      { sourceKey: "resupply-pairs:ethereum:0xcacd6fd266af91b8aed52accc382b4e165586e29", name: "Frax frxUSD lending markets", pct: 40, risk: "high", coinId: "frxusd-frax", depType: "collateral" },
    ]);
  });

  it.each([
    {
      name: "an underlying decimals() read fails",
      decimalsResult: null,
      vaultAsset: FRXUSD,
      expected: /decimals\(\) for .* call failed/,
    },
    {
      name: "the collateral vault reports a different asset",
      decimalsResult: 18n,
      vaultAsset: CRVUSD,
      expected: /asset\(\) mismatch/,
    },
  ])("fails closed when $name", async ({ decimalsResult, vaultAsset, expected }) => {
    await expect(runResupply({
      network: resupplyNetwork(
        {
          [CURVE_PAIR]: pairAnswers({
            underlying: CRVUSD,
            collateral: CURVE_COLLATERAL,
            totalBorrowAmount: 45n * ONE,
            totalCollateralShares: 100n * ONE,
            maxRedeemableDebt: 45n * ONE,
            collateralAssets: 60n * ONE,
          }),
          [FRAX_PAIR]: pairAnswers({
            underlying: FRXUSD,
            collateral: FRAX_COLLATERAL,
            totalBorrowAmount: 30n * ONE,
            totalCollateralShares: 100n * ONE,
            maxRedeemableDebt: 30n * ONE,
            collateralAssets: 40n * ONE,
            vaultAsset,
          }),
        },
        { decimals: { [CRVUSD]: 18n, [FRXUSD]: decimalsResult } },
      ),
    })).rejects.toThrow(expected);
  });
});
