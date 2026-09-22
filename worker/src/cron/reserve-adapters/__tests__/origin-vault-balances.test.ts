import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import { runAdapter, expectWarnings, installAdapterNetwork, type AdapterNetworkSpec } from "./reserve-adapter.test-support";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const OUSD = "0x2a8e1e676ec238d8a992307b495b45b3feaa5e86";
const CHECK_BALANCE_SELECTOR = "0x5f515226";
const BALANCE_OF_SELECTOR = "0x70a08231";
const TOTAL_VALUE_SELECTOR = "0xd4c3eea0";
const DECIMALS_SELECTOR = "0x313ce567";
const BLOCK_NUMBER = 12345;
const BLOCK_TIMESTAMP = 1776154391;

interface OriginAssetValues {
  reserve: bigint;
  idle: bigint;
}

interface OriginNetworkOptions {
  reserve?: bigint;
  idle?: bigint;
  total?: bigint;
  decimals?: bigint | null;
  failed?: string;
  assets?: Record<string, OriginAssetValues>;
}

function originNetwork(options: OriginNetworkOptions = {}): AdapterNetworkSpec {
  const assets = Object.fromEntries(
    Object.entries(options.assets ?? {
      [USDC.toLowerCase()]: {
        reserve: options.reserve ?? 5_000_000n * 10n ** 6n,
        idle: options.idle ?? 1_250_000n * 10n ** 6n,
      },
    }).map(([address, values]) => [address.toLowerCase(), values]),
  );
  const defaultValues = assets[USDC.toLowerCase()] ?? {
    reserve: options.reserve ?? 5_000_000n * 10n ** 6n,
    idle: options.idle ?? 1_250_000n * 10n ** 6n,
  };
  return {
    block: { number: BLOCK_NUMBER, timestamp: BLOCK_TIMESTAMP },
    rpc: {
      [CHECK_BALANCE_SELECTOR]: ({ data }) => {
        if (options.failed && data.startsWith(options.failed)) return null;
        const asset = `0x${data.slice(-40)}`.toLowerCase();
        return assets[asset]?.reserve ?? defaultValues.reserve;
      },
      [BALANCE_OF_SELECTOR]: ({ contract, data }) => {
        if (options.failed && data.startsWith(options.failed)) return null;
        return assets[contract]?.idle ?? defaultValues.idle;
      },
      [TOTAL_VALUE_SELECTOR]: ({ data }) => {
        if (options.failed && data.startsWith(options.failed)) return null;
        return options.total ?? 5_000_000n * 10n ** 18n;
      },
      [`${OUSD}:${DECIMALS_SELECTOR}`]: options.decimals === undefined ? 18n : options.decimals,
    },
  };
}

function runOrigin(
  network: AdapterNetworkSpec,
  params?: Record<string, unknown>,
  validate = true,
  coin?: Partial<StablecoinMeta>,
) {
  return runAdapter("origin-vault-balances", "ousd-origin-protocol", {
    network: installAdapterNetwork(network),
    nowSec: BLOCK_TIMESTAMP,
    ...(params ? { params } : {}),
    ...(coin ? { coin } : {}),
    ...(validate ? {} : { validate: false as const }),
  });
}

describe("fetchOriginVaultBalancesReserves", () => {
  it("uses OUSD vault checkBalance and reconciles against totalValue", async () => {
    const { result, network } = await runOrigin(originNetwork());
    expect(result.metadata?.observedBlock).toEqual({ chain: "ethereum", number: BLOCK_NUMBER, timestamp: BLOCK_TIMESTAMP });
    expect(network.rpcCalls.every((call) => call.block === `0x${BLOCK_NUMBER.toString(16)}`)).toBe(true);

    expect(result.slices).toEqual([
      {
        sourceKey: "origin-vault-balances:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        name: "USDC deployed through Origin OUSD strategies",
        pct: 100,
        risk: "medium",
        coinId: "usdc-circle",
        depType: "collateral",
      },
    ]);
    expectWarnings(result, []);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      totalReserveUsd: 5_000_000,
      totalValueUsd: 5_000_000,
      assetCoverageRatio: 1,
      idleVaultBalances: [
        {
          name: "USDC deployed through Origin OUSD strategies",
          value: 1_250_000,
          raw: (1_250_000n * 10n ** 6n).toString(),
          coinId: "usdc-circle",
        },
      ],
      redemption: {
        capacityUsd: 1_250_000,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        sourceUrls: ["https://analytics.originprotocol.com/"],
      },
      details: {
        proofKind: "origin-vault-check-balance",
        totalValueDecimals: 18,
      },
    });
    const idleCall = network.rpcCalls.find(
      (call) => call.selector === BALANCE_OF_SELECTOR && call.contract === USDC.toLowerCase(),
    );
    expect(idleCall).toMatchObject({
      contract: USDC.toLowerCase(),
      data: "0x70a08231000000000000000000000000e75d77b1865ae93c7eaa3040b038d7aa7bc02f70",
    });
    expect(network.rpcCalls.filter((call) => call.selector === DECIMALS_SELECTOR).map((call) => call.contract))
      .toEqual([OUSD]);
  });

  it("scales totalValue by the decimals read at the pinned block instead of an assumed 18", async () => {
    const { result } = await runOrigin(
      originNetwork({ decimals: 6n, total: 5_000_000n * 10n ** 6n }),
      undefined,
      true,
      { contracts: [{ chain: "ethereum", address: OUSD, decimals: 6 }] },
    );

    expect(result.metadata).toMatchObject({
      totalValueUsd: 5_000_000,
      assetCoverageRatio: 1,
      unknownExposurePct: 0,
      details: { totalValueDecimals: 6 },
    });
    expect(result.slices).toHaveLength(1);
    expectWarnings(result, []);
  });

  it("fails closed when the decimals read disagrees with the reviewed deployment or fails", async () => {
    await expect(runOrigin(originNetwork({ decimals: 6n }), undefined, false))
      .rejects.toThrow(/totalValue scale drifted \(decimals\(\) 6, reviewed 18\)/);
    await expect(runOrigin(originNetwork({ decimals: null }), undefined, false))
      .rejects.toThrow(/decimals\(\) probe failed/);
  });

  it("distinguishes failed invested, idle and total-value probes", async () => {
    for (const [failed, message] of [
      [CHECK_BALANCE_SELECTOR, /checkBalance failed/],
      [BALANCE_OF_SELECTOR, /idle balance probe failed/],
      [TOTAL_VALUE_SELECTOR, /totalValue probe failed/],
    ] as const) {
      await expect(runOrigin(originNetwork({ failed }), undefined, false)).rejects.toThrow(message);
    }
  });

  it("rejects zero total value and zero aggregate reserves independently", async () => {
    await expect(runOrigin(originNetwork({ reserve: 100n * 10n ** 6n, total: 0n }), undefined, false))
      .rejects.toThrow(/totalValue probe failed/);
    await expect(runOrigin(originNetwork({ reserve: 0n, total: 100n * 10n ** 18n }), undefined, false))
      .rejects.toThrow(/zero reserve value/);
  });

  it("degrades incomplete asset coverage without confusing idle liquidity with backing", async () => {
    const { result } = await runOrigin(originNetwork({
      reserve: 80n * 10n ** 6n,
      idle: 20n * 10n ** 6n,
      total: 100n * 10n ** 18n,
    }));
    expect(result.metadata).toMatchObject({
      totalReserveUsd: 80, totalValueUsd: 100, assetCoverageRatio: 0.8,
      redemption: { capacityUsd: 20 },
    });
    expectWarnings(result, ["origin-vault-coverage-gap"]);
  });

  it("normalizes mixed asset decimals and sums idle capacity separately", async () => {
    const assets = [
      { address: "0x1111111111111111111111111111111111111111", decimals: 6, name: "USDC", risk: "low" },
      { address: "0x2222222222222222222222222222222222222222", decimals: 18, name: "DAI", risk: "low" },
    ];
    const { result } = await runOrigin(
      originNetwork({
        assets: {
          [assets[0]!.address]: { reserve: 40n * 10n ** 6n, idle: 7n * 10n ** 6n },
          [assets[1]!.address]: { reserve: 60n * 10n ** 18n, idle: 11n * 10n ** 18n },
        },
        total: 100n * 10n ** 18n,
      }),
      { assets },
    );
    expect(result.slices).toEqual([
      { sourceKey: "origin-vault-balances:0x2222222222222222222222222222222222222222", name: "DAI", pct: 60, risk: "low" },
      { sourceKey: "origin-vault-balances:0x1111111111111111111111111111111111111111", name: "USDC", pct: 40, risk: "low" },
    ]);
    expect(result.metadata).toMatchObject({ totalReserveUsd: 100, assetCoverageRatio: 1, redemption: { capacityUsd: 18 } });
    expectWarnings(result, []);
  });

  it("rejects a renamed totalValue field instead of publishing a plausible snapshot", async () => {
    await expect(runOrigin(originNetwork({ failed: TOTAL_VALUE_SELECTOR }), undefined, false))
      .rejects.toThrow(/totalValue probe failed/);
  });
});
