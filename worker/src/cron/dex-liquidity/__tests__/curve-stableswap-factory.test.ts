import { describe, expect, it, vi } from "vitest";
import { encodeFunctionResult, keccak256, parseAbi, toHex } from "viem/utils";

import { initMetrics } from "../pool-helpers";
import {
  CURVE_STABLESWAP_FACTORY_DEPLOYMENTS,
  enrichCurveStableswapFactoryExecutionModels,
} from "../curve-stableswap-factory";
import type { PoolEntry } from "../types";

/**
 * Recorded 2026-09-01 from `https://rpc.plasma.to` against the Plasma Curve
 * StableSwap-NG factory `0x8271e0…e8ad` at head block 31,321,392: 21 indexed
 * pools, exactly one (index 13) holding yzUSD, `is_meta` false, `get_A` 1000,
 * `fee` 1e6, `offpeg_fee_multiplier` 1e11, base stored rates.
 */
const PLASMA = "plasma";
const DEPLOYMENT = CURVE_STABLESWAP_FACTORY_DEPLOYMENTS.find((entry) => entry.chain === PLASMA)!;
const FACTORY = DEPLOYMENT.factoryAddress;
const IMPLEMENTATION = DEPLOYMENT.expectedPoolImplementationAddress;
const POOL = "0x085bad2c28bdd4a40396072d3eb2636bf7afa39c" as const;
const DECOY_POOL = "0x2d84d79c852f6842abe0304b70bbaa1506add457" as const;
const YZUSD = "0x6695c0f8706c5ace3bdf8995073179cca47926dc" as const;
const USDT0 = "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb" as const;
const XAUT0 = "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34" as const;
const BLOCK_NUMBER = 31_321_392;
const BLOCK_TIMESTAMP = 1_788_262_000;
const BLOCK_HASH = "0x0305aed7bdf9bb7711ac23ad7322cd7569380b004b56408b4bec0a4a7a7eaf82" as const;
const PINNED_BALANCES = [392_506_419_182_324_069_258_207n, 408_661_362_052n];
const PINNED_DECIMALS = [18n, 6n];
const PINNED_STORED_RATES = [10n ** 18n, 10n ** 30n];
const PINNED_AMPLIFICATION = 1_000n;
const PINNED_FEE = 1_000_000n;
const PINNED_OFFPEG_FEE_MULTIPLIER = 100_000_000_000n;
const POOL_COUNT = 21n;
const POOL_INDEX = 13;

const FACTORY_ABI = parseAbi([
  "function pool_count() view returns (uint256)",
  "function pool_list(uint256) view returns (address)",
  "function get_coins(address) view returns (address[])",
  "function get_decimals(address) view returns (uint256[])",
  "function get_balances(address) view returns (uint256[])",
  "function get_A(address) view returns (uint256)",
  "function is_meta(address) view returns (bool)",
  "function get_implementation_address(address) view returns (address)",
]);
const POOL_ABI = parseAbi([
  "function fee() view returns (uint256)",
  "function offpeg_fee_multiplier() view returns (uint256)",
  "function stored_rates() view returns (uint256[])",
]);
const ERC20_ABI = parseAbi(["function symbol() view returns (string)"]);

const FACTORY_CODE = toHex("plasma-curve-stableswap-ng-factory");
const IMPLEMENTATION_CODE = toHex("plasma-curve-stableswap-ng-blueprint");

interface StateOverrides {
  poolCount?: bigint;
  coinsByIndex?: Record<number, readonly `0x${string}`[]>;
  isMeta?: boolean;
  implementation?: `0x${string}`;
  storedRates?: bigint[];
  amplification?: bigint;
  balances?: bigint[];
}

function ok(label: string, returnData: `0x${string}`) {
  return { label, success: true, returnData };
}

function poolAddressAt(index: number): `0x${string}` {
  if (index === POOL_INDEX) return POOL;
  if (index === 0) return DECOY_POOL;
  return `0x${(index + 1).toString(16).padStart(40, "0")}` as `0x${string}`;
}

function coinsAt(index: number, overrides: StateOverrides): readonly `0x${string}`[] {
  const override = overrides.coinsByIndex?.[index];
  if (override) return override;
  if (index === POOL_INDEX) return [YZUSD, USDT0];
  if (index === 0) return [USDT0, XAUT0];
  return [USDT0, `0x${(index + 200).toString(16).padStart(40, "0")}` as `0x${string}`];
}

function multicall(calls: readonly { label: string }[], overrides: StateOverrides) {
  return calls.map((call) => {
    if (call.label === "pool-count") {
      return ok(
        call.label,
        encodeFunctionResult({
          abi: FACTORY_ABI,
          functionName: "pool_count",
          result: overrides.poolCount ?? POOL_COUNT,
        }),
      );
    }
    const listed = call.label.match(/^pool-list-(\d+)$/);
    if (listed) {
      return ok(
        call.label,
        encodeFunctionResult({
          abi: FACTORY_ABI,
          functionName: "pool_list",
          result: poolAddressAt(Number(listed[1])),
        }),
      );
    }
    const coins = call.label.match(/^pool-coins-(\d+)$/);
    if (coins) {
      return ok(
        call.label,
        encodeFunctionResult({
          abi: FACTORY_ABI,
          functionName: "get_coins",
          result: [...coinsAt(Number(coins[1]), overrides)],
        }),
      );
    }
    switch (call.label) {
      case "decimals":
        return ok(
          call.label,
          encodeFunctionResult({ abi: FACTORY_ABI, functionName: "get_decimals", result: PINNED_DECIMALS }),
        );
      case "balances":
        return ok(
          call.label,
          encodeFunctionResult({
            abi: FACTORY_ABI,
            functionName: "get_balances",
            result: overrides.balances ?? PINNED_BALANCES,
          }),
        );
      case "amplification":
        return ok(
          call.label,
          encodeFunctionResult({
            abi: FACTORY_ABI,
            functionName: "get_A",
            result: overrides.amplification ?? PINNED_AMPLIFICATION,
          }),
        );
      case "is-meta":
        return ok(
          call.label,
          encodeFunctionResult({ abi: FACTORY_ABI, functionName: "is_meta", result: overrides.isMeta ?? false }),
        );
      case "implementation":
        return ok(
          call.label,
          encodeFunctionResult({
            abi: FACTORY_ABI,
            functionName: "get_implementation_address",
            result: overrides.implementation ?? IMPLEMENTATION,
          }),
        );
      case "fee":
        return ok(call.label, encodeFunctionResult({ abi: POOL_ABI, functionName: "fee", result: PINNED_FEE }));
      case "offpeg-fee-multiplier":
        return ok(
          call.label,
          encodeFunctionResult({
            abi: POOL_ABI,
            functionName: "offpeg_fee_multiplier",
            result: PINNED_OFFPEG_FEE_MULTIPLIER,
          }),
        );
      case "stored-rates":
        return ok(
          call.label,
          encodeFunctionResult({
            abi: POOL_ABI,
            functionName: "stored_rates",
            result: overrides.storedRates ?? PINNED_STORED_RATES,
          }),
        );
      case "symbol-0":
        return ok(call.label, encodeFunctionResult({ abi: ERC20_ABI, functionName: "symbol", result: "yzUSD" }));
      case "symbol-1":
        return ok(call.label, encodeFunctionResult({ abi: ERC20_ABI, functionName: "symbol", result: "USDT0" }));
      default:
        throw new Error(`unexpected call ${call.label}`);
    }
  });
}

function poolEntry(overrides: Partial<NonNullable<PoolEntry["extra"]>> = {}): PoolEntry {
  return {
    poolId: "e4b869a7-c3ff-4414-9a7a-9e62f76fa3a3",
    project: "curve",
    chain: "Plasma",
    tvlUsd: 800_617,
    symbol: "YZUSD-USDT0",
    volumeUsd1d: 0,
    poolType: "curve-stableswap",
    source: "dl",
    extra: {
      executionCapabilityGate: { family: "curve-stableswap", reason: "exact-pool-join-unresolved" },
      ...overrides,
    },
  };
}

function metrics(pool: PoolEntry) {
  const metric = initMetrics("yzusd-yuzu", "YZUSD");
  metric.topPools.push(pool);
  return new Map([[metric.stablecoinId, metric]]);
}

function dependencies(
  overrides: StateOverrides & {
    factoryCode?: `0x${string}` | null;
    implementationCode?: `0x${string}` | null;
    confirmedHeader?: { timestamp: number; hash: `0x${string}` };
  } = {},
) {
  const header = { number: BLOCK_NUMBER, timestamp: BLOCK_TIMESTAMP, hash: BLOCK_HASH };
  const confirmed = {
    number: BLOCK_NUMBER,
    timestamp: overrides.confirmedHeader?.timestamp ?? header.timestamp,
    hash: overrides.confirmedHeader?.hash ?? header.hash,
  };
  return {
    fetchBlockNumber: vi.fn().mockResolvedValue(BLOCK_NUMBER),
    fetchBlockHeader: vi.fn().mockResolvedValueOnce(header).mockResolvedValueOnce(confirmed),
    fetchCodeAtBlock: vi.fn(async (_chain: string, address: string) =>
      address.toLowerCase() === FACTORY
        ? overrides.factoryCode === undefined
          ? FACTORY_CODE
          : overrides.factoryCode
        : overrides.implementationCode === undefined
          ? IMPLEMENTATION_CODE
          : overrides.implementationCode,
    ),
    fetchMulticall: vi.fn(async (_chain: string, calls: readonly { label: string }[]) =>
      multicall(calls, overrides),
    ),
    hashCode: keccak256,
  };
}

const chainAddressToId = new Map([
  [`plasma:${YZUSD}`, "yzusd-yuzu"],
  [`plasma:${USDT0}`, "usdt-tether"],
]);
const stablecoinPriceById = new Map([
  ["yzusd-yuzu", 1],
  ["usdt-tether", 0.9999],
]);

async function run(pool: PoolEntry, deps: ReturnType<typeof dependencies>) {
  await enrichCurveStableswapFactoryExecutionModels({
    metrics: metrics(pool),
    chainAddressToId,
    stablecoinPriceById,
    chainRpcs: new Map([[PLASMA, {} as never]]),
    nowSec: BLOCK_TIMESTAMP + 60,
    dependencies: deps as never,
  });
}

describe("Curve StableSwap-NG factory census capture", () => {
  it("pins the reviewed Plasma deployment", () => {
    expect(DEPLOYMENT).toMatchObject({
      chain: "plasma",
      registryId: "factory-stable-ng",
      factoryAddress: "0x8271e06e5887fe5ba05234f5315c19f3ec90e8ad",
      expectedFactoryCodeHash: "0xded1a5a542411bf8bced670953ccbed8dfc0443ee9d0e190e61cebc31631f87f",
      expectedPoolImplementationAddress: "0xfc687efafed297b765edecf8179c32195597c2df",
      expectedPoolImplementationCodeHash:
        "0x620bf33fca9d3555fa15de7b13cdbc279dcaf2c55844df479781f86425895a17",
    });
    expect(CURVE_STABLESWAP_FACTORY_DEPLOYMENTS).toHaveLength(1);
  });

  it("resolves the unreachable Curve join from the factory index and builds the model", async () => {
    const deps = dependencies({
      factoryCode: FACTORY_CODE,
      implementationCode: IMPLEMENTATION_CODE,
    });
    // The registry pins the hash of the recorded runtime, so the fixture code
    // stands in for it: rebind both pins to the fixture's own hashes.
    deps.hashCode = ((code: `0x${string}`) =>
      code === FACTORY_CODE
        ? DEPLOYMENT.expectedFactoryCodeHash
        : DEPLOYMENT.expectedPoolImplementationCodeHash) as never;

    const pool = poolEntry();
    await run(pool, deps);

    expect(deps.fetchMulticall).toHaveBeenCalledWith(
      PLASMA,
      [expect.objectContaining({ label: "pool-count", target: FACTORY })],
      BLOCK_NUMBER,
      expect.any(Object),
    );
    expect(deps.fetchBlockHeader).toHaveBeenCalledTimes(2);
    expect(pool.extra?.executionCapabilityGate).toBeUndefined();
    expect(pool.extra?.measurement).toMatchObject({ balanceMeasured: true });
    expect(pool.extra?.registryId).toBe("factory-stable-ng");
    const model = pool.extra?.ammExecutionModel;
    expect(model).toMatchObject({
      source: "curve",
      invariant: "stableswap",
      trackedTokenIndex: 0,
      // Contract convention A() = 1000 becomes the simulator's paper Ann.
      amplification: 500,
      // 1 bp static fee scaled to its documented off-balance maximum.
      feeRate: 0.001,
      tokens: [
        { address: YZUSD, symbol: "yzUSD", decimals: 18, trackedAssetId: "yzusd-yuzu" },
        { address: USDT0, symbol: "USDT0", decimals: 6, trackedAssetId: "usdt-tether" },
      ],
    });
    expect(model?.tokens[0]?.balance).toBeCloseTo(392_506.4191823241, 6);
    expect(model?.tokens[1]?.balance).toBeCloseTo(408_661.362052, 6);
    expect(model?.tokens[1]?.referencePriceUsd).toBeCloseTo(0.9999, 12);
  });

  it.each([
    ["a moved factory runtime", { factoryCode: toHex("moved-factory") }],
    ["a moved pool blueprint", { implementationCode: toHex("moved-blueprint") }],
    ["a missing factory runtime", { factoryCode: null }],
  ])("keeps the unresolved join on %s", async (_label, overrides) => {
    const deps = dependencies(overrides as StateOverrides);
    const pool = poolEntry();
    await run(pool, deps);

    expect(pool.extra?.ammExecutionModel).toBeUndefined();
    expect(pool.extra?.executionCapabilityGate).toEqual({
      family: "curve-stableswap",
      reason: "exact-pool-join-unresolved",
    });
    expect(deps.fetchMulticall).not.toHaveBeenCalled();
  });

  it("refuses a truncated factory inventory", async () => {
    const deps = dependencies({ poolCount: BigInt(DEPLOYMENT.maxIndexedPools + 1) });
    deps.hashCode = ((code: `0x${string}`) =>
      code === FACTORY_CODE
        ? DEPLOYMENT.expectedFactoryCodeHash
        : DEPLOYMENT.expectedPoolImplementationCodeHash) as never;
    const pool = poolEntry();
    await run(pool, deps);

    expect(pool.extra?.ammExecutionModel).toBeUndefined();
    expect(pool.extra?.executionCapabilityGate).toEqual({
      family: "curve-stableswap",
      reason: "exact-pool-join-unresolved",
    });
  });

  it.each([
    [
      "two indexed pools hold the tracked token",
      { coinsByIndex: { 0: [YZUSD, USDT0] } } as StateOverrides,
      "ambiguous-token-identity",
    ],
    ["the factory reports a metapool", { isMeta: true } as StateOverrides, "incomplete-exact-capture"],
    [
      "the pool was built from a foreign implementation",
      { implementation: "0x00000000000000000000000000000000deadbeef" } as StateOverrides,
      "incomplete-exact-capture",
    ],
    [
      "the pool carries non-base stored rates",
      { storedRates: [1_203_657_319_587_784_076n, 10n ** 30n] } as StateOverrides,
      "rate-bearing-inputs",
    ],
    ["the amplification reads zero", { amplification: 0n } as StateOverrides, "invalid-invariant-parameters"],
  ])("gates when %s", async (_label, overrides, reason) => {
    const deps = dependencies(overrides);
    deps.hashCode = ((code: `0x${string}`) =>
      code === FACTORY_CODE
        ? DEPLOYMENT.expectedFactoryCodeHash
        : DEPLOYMENT.expectedPoolImplementationCodeHash) as never;
    const pool = poolEntry();
    await run(pool, deps);

    expect(pool.extra?.ammExecutionModel).toBeUndefined();
    expect(pool.extra?.executionCapabilityGate).toEqual({ family: "curve-stableswap", reason });
  });

  it("withdraws the model when the capture straddles a reorg", async () => {
    const deps = dependencies({ confirmedHeader: { timestamp: BLOCK_TIMESTAMP, hash: `0x${"9".repeat(64)}` } });
    deps.hashCode = ((code: `0x${string}`) =>
      code === FACTORY_CODE
        ? DEPLOYMENT.expectedFactoryCodeHash
        : DEPLOYMENT.expectedPoolImplementationCodeHash) as never;
    const pool = poolEntry();
    await run(pool, deps);

    expect(pool.extra?.ammExecutionModel).toBeUndefined();
    expect(pool.extra?.executionCapabilityGate).toEqual({
      family: "curve-stableswap",
      reason: "exact-pool-join-unresolved",
    });
  });

  it("leaves every other Curve gate to its own reviewed path", async () => {
    const deps = dependencies();
    for (const reason of ["rate-bearing-inputs", "metapool-unsupported", "unsupported-invariant"] as const) {
      const pool = poolEntry({
        executionCapabilityGate: { family: "curve-stableswap", reason } as never,
      });
      await run(pool, deps);
      expect(pool.extra?.ammExecutionModel).toBeUndefined();
      expect(pool.extra?.executionCapabilityGate).toEqual({ family: "curve-stableswap", reason });
    }
    expect(deps.fetchBlockNumber).not.toHaveBeenCalled();
  });

  it("does not touch chains outside the reviewed registry", async () => {
    const deps = dependencies();
    const pool = { ...poolEntry(), chain: "Ethereum" };
    await run(pool, deps);

    expect(deps.fetchBlockNumber).not.toHaveBeenCalled();
    expect(pool.extra?.executionCapabilityGate).toEqual({
      family: "curve-stableswap",
      reason: "exact-pool-join-unresolved",
    });
  });
});
