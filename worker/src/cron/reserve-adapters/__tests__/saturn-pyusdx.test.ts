import { describe, expect, it } from "vitest";
import { EIP1967_IMPLEMENTATION_SLOT } from "../onchain-identity";
import { installAdapterNetwork, runAdapter, type AdapterNetworkSpec } from "./reserve-adapter.test-support";

const ADDRESSES = {
  wrapper: "0x23238f20b894f29041f48d88ee91131c395aaa71",
  implementation: "0x496a4a33b6181f4536203488d9a05ac1429e702c",
  pyusdx: "0xebdb0942ce16386ab90718c7bd10c91cdb66b14d",
  other: "0x00000000000000000000000000000000000000ab",
} as const;

const SUPPLY = 64_224_919_545249n;
const BALANCE = 64_224_919_545249n;

function word(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function addressWord(address: string): `0x${string}` {
  return word(BigInt(address));
}

function installReads(overrides: {
  implementation?: string;
  pyusdx?: string;
  supply?: bigint;
  balance?: bigint;
  paused?: bigint;
  decimals?: bigint;
} = {}): AdapterNetworkSpec {
  const decimals = overrides.decimals ?? 6n;
  const wrapper = ADDRESSES.wrapper.toLowerCase();
  const pyusdx = ADDRESSES.pyusdx.toLowerCase();
  return {
    rpc: {
      [`eth_getStorageAt:${wrapper}:${EIP1967_IMPLEMENTATION_SLOT}`]:
        addressWord(overrides.implementation ?? ADDRESSES.implementation),
      [`${wrapper}:pyusdx()`]: addressWord(overrides.pyusdx ?? ADDRESSES.pyusdx),
      [`${wrapper}:totalSupply()`]: word(overrides.supply ?? SUPPLY),
      [`${wrapper}:decimals()`]: word(decimals),
      [`${pyusdx}:balanceOf(address)`]: word(overrides.balance ?? BALANCE),
      [`${pyusdx}:decimals()`]: word(decimals),
      [`${wrapper}:paused()`]: word(overrides.paused ?? 0n),
    },
  };
}

async function fetchFixture(
  overrides: Parameters<typeof installReads>[0] = {},
  options: { validate?: false } = {},
) {
  const { result } = await runAdapter("saturn-pyusdx", "usdat-saturn", {
    network: installAdapterNetwork(installReads(overrides)),
    ...options,
  });
  return result;
}

describe("saturn-pyusdx adapter", () => {
  it("emits the measured 100% PYUSDx slice with the canonical PYUSD dependency", async () => {
    const output = await fetchFixture();

    expect(output.slices).toEqual([
      {
        sourceKey: "saturn-pyusdx:pyusd",
        name: "PYUSDx held by Saturn USDat",
        pct: 100,
        risk: "low",
        coinId: "pyusd-paypal",
        depType: "wrapper",
      },
    ]);
    expect(output.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      details: { proofKind: "saturn-pyusdx-wrapper-balance" },
      wrapperAddress: ADDRESSES.wrapper,
      implementationAddress: ADDRESSES.implementation,
      pyusdxAddress: ADDRESSES.pyusdx,
      totalSupplyRaw: SUPPLY.toString(),
      underlyingBalanceRaw: BALANCE.toString(),
      wrapperDecimals: 6,
      underlyingDecimals: 6,
      collateralizationRatio: 1,
      redemption: {
        capacityUsd: 64_224_919.545249,
        capacityRatioOfSupply: 1,
        capacityKind: "live-direct",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusSource: "onchain",
        holderEligibility: "whitelisted-primary",
        settlementDelaySec: 0,
      },
    });
    expect(output.warnings).toBeUndefined();
  });

  it("fails closed when the EIP-1967 implementation slot drifts", async () => {
    await expect(fetchFixture({ implementation: ADDRESSES.other })).rejects.toThrow("EIP-1967 implementation identity mismatch");
  });

  it("fails closed when pyusdx() does not resolve to the pinned PYUSDx token", async () => {
    await expect(fetchFixture({ pyusdx: ADDRESSES.other })).rejects.toThrow("pyusdx() identity mismatch");
  });

  it("publishes PYUSDx below supply as degraded instead of erroring (E4)", async () => {
    const output = await fetchFixture({ balance: 59_000_000_000000n }, { validate: false });
    expect(output.slices).toEqual([
      {
        sourceKey: "saturn-pyusdx:pyusd",
        name: "PYUSDx held by Saturn USDat",
        pct: 100,
        risk: "low",
        coinId: "pyusd-paypal",
        depType: "wrapper",
      },
    ]);
    expect(output.metadata?.collateralizationRatio).toBeCloseTo(59_000_000 / 64_224_919.545249, 6);
    expect(output.warnings).toEqual([
      expect.objectContaining({
        code: "reserve-undercollateralized",
        effect: "degraded",
        severity: "warning",
        message: "Saturn USDat PYUSDx balance covers 91.86% of USDat supply",
      }),
    ]);
  });

  it("degrades zero supply and reports a paused MultiMint route as paused", async () => {
    const output = await fetchFixture({ supply: 0n, paused: 1n }, { validate: false });
    expect(output.metadata?.collateralizationRatio).toBeUndefined();
    expect(output.metadata?.redemption).toMatchObject({
      routeStatus: "paused",
      routeStatusSource: "onchain",
      routeStatusReason: "Saturn USDat MultiMint paused() returned true on-chain",
    });
    expect(output.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "reserve-undercollateralized", effect: "degraded" }),
        expect.objectContaining({ code: "route-paused", effect: "degraded" }),
      ]),
    );
  });
});
