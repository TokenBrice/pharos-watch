import { describe, expect, it } from "vitest";
import { encodeAddress, encodeUint256 } from "../../../lib/evm-selectors";

import { adaptCapVaultState } from "../cap-vault";
import {
  expectValidAdapterOutput,
  installAdapterNetwork,
  runAdapter,
  type AdapterRpcValue,
} from "./reserve-adapter.test-support";
import { makeCapAsset } from "./cap-vault.test-support";
const CAP_VAULT = "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eB48";
const WTGXX = "0x434558cb1ebe9950e8a66f1ef8a15a473dce7d8c";
const WTGXX_ORACLE = "0xd13cb763c43b5c058e7ec40176962c5030f4eb49";
const CAP_NOW = 1_776_154_391;


function encodeAddressArray(addresses: string[]): `0x${string}` {
  return `0x${encodeUint256(32)}${encodeUint256(addresses.length)}${
    addresses.map((address) => encodeAddress(address)).join("")
  }` as `0x${string}`;
}

function encodeLatestRoundData(answer: bigint, updatedAt: number): `0x${string}` {
  return `0x${[1n, answer, BigInt(updatedAt), BigInt(updatedAt), 1n]
    .map((value) => encodeUint256(value))
    .join("")}` as `0x${string}`;
}

function argumentAddress(data: string): string {
  return `0x${data.slice(-40)}`.toLowerCase();
}

function capNetwork(options: {
  assets?: string[];
  totalSupplies?: Record<string, bigint>;
  totalBorrows?: Record<string, bigint>;
  available?: Record<string, bigint>;
  decimals?: Record<string, bigint>;
  paused?: boolean | null;
  redeemFee?: bigint | null;
  nullField?: "decimals" | "totalSupplies" | "totalBorrows" | "available";
  navAnswer?: bigint;
  navUpdatedAt?: number;
} = {}) {
  const assets = options.assets ?? [USDC];
  const byAddress = (record: Record<string, bigint>) => {
    const map = new Map(Object.entries(record).map(([address, value]) => [address.toLowerCase(), value]));
    return (address: string): bigint | undefined => map.get(address.toLowerCase());
  };
  const totalSupplies = byAddress(options.totalSupplies ?? {});
  const totalBorrows = byAddress(options.totalBorrows ?? {});
  const available = byAddress(options.available ?? {});
  const decimals = byAddress(options.decimals ?? {});
  const rpc: Record<string, AdapterRpcValue> = {
    [`${CAP_VAULT}:0x71a97305`]: encodeAddressArray(assets),
    [`${CAP_VAULT}:0x18160ddd`]: 100n * 10n ** 18n,
    [`${CAP_VAULT}:0x9782e821`]: (call: { data: string }) =>
      options.nullField === "totalSupplies"
        ? null
        : totalSupplies(argumentAddress(call.data)) ?? (argumentAddress(call.data) === WTGXX.toLowerCase() ? 50n * 10n ** 18n : 50_000_000n),
    [`${CAP_VAULT}:0xc6d98f1a`]: options.redeemFee === undefined ? 0n : options.redeemFee,
    [`${CAP_VAULT}:0x8d730124`]: (call: { data: string }) => options.nullField === "totalBorrows"
      ? null
      : totalBorrows(argumentAddress(call.data)) ?? 0n,
    [`${CAP_VAULT}:0xa0821be3`]: (call: { data: string }) => options.nullField === "available"
      ? null
      : available(argumentAddress(call.data)) ?? (argumentAddress(call.data) === WTGXX.toLowerCase() ? 50n * 10n ** 18n : 50_000_000n),
    [`${CAP_VAULT}:0x2e48152c`]: options.paused === undefined ? false : options.paused,
    [`${WTGXX_ORACLE}:0x313ce567`]: 8n,
    [`${WTGXX_ORACLE}:0xfeaf968c`]: encodeLatestRoundData(
      options.navAnswer ?? 100_000_000n,
      options.navUpdatedAt ?? CAP_NOW - 60,
    ),
  };
  for (const asset of assets) {
    rpc[`${asset}:0x313ce567`] = options.nullField === "decimals"
      ? null
      : decimals(asset) ?? (asset.toLowerCase() === WTGXX.toLowerCase() ? 18n : 6n);
  }
  return {
    block: { number: 12345, timestamp: CAP_NOW },
    rpc,
  };
}


describe("adaptCapVaultState", () => {
  it("uses total supplied assets for reserve slices and available unpaused balances for redemption capacity", () => {
    const result = adaptCapVaultState({
      contractAddress: "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc",
      supplyUsd: 100,
      assets: [
        {
          address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          name: "USDC",
          risk: "low",
          coinId: "usdc-circle",
          decimals: 6,
          totalSupplied: 70,
          totalBorrowed: 20,
          available: 50,
          paused: false,
          pausedStatusUnavailable: false,
        },
        {
          address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
          name: "USDT",
          risk: "low",
          coinId: "usdt-tether",
          decimals: 6,
          totalSupplied: 30,
          totalBorrowed: 0,
          available: 30,
          paused: true,
          pausedStatusUnavailable: false,
        },
      ],
    });

    expect(result.slices).toEqual([
      { sourceKey: "cap-vault:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", name: "USDC", pct: 70, risk: "low", coinId: "usdc-circle" },
      { sourceKey: "cap-vault:0xdac17f958d2ee523a2206206994597c13d831ec7", name: "USDT", pct: 30, risk: "low", coinId: "usdt-tether" },
    ]);
    expect(result.metadata).toMatchObject({
      totalReserveUsd: 100,
      supplyUsd: 100,
      redemption: {
        capacityUsd: 50,
        capacityRatioOfSupply: 0.5,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus: "degraded",
        routeStatusSource: "onchain",
        settlementDelaySec: 0,
      },
    });
    expect(result.warnings?.some((warning) => warning.code === "cap-asset-paused")).toBe(true);
  });

  it("emits the on-chain redeem fee in redemption telemetry and passes validation", () => {
    const result = adaptCapVaultState({
      contractAddress: "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc",
      supplyUsd: 100,
      redemptionFeeBps: 0,
      assets: [makeCapAsset({ coinId: "usdc-circle", priceUsd: 1 })],
    });

    expect(result.metadata).not.toHaveProperty("redemptionFeeBps");
    expect(result.metadata?.redemption).toMatchObject({ feeBps: 0 });
    expectValidAdapterOutput("cap-vault", result);
  });

  it("omits the redemption fee telemetry when the redeem fee could not be read", () => {
    const result = adaptCapVaultState({
      contractAddress: "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc",
      supplyUsd: 100,
      redemptionFeeBps: null,
      assets: [makeCapAsset({ priceUsd: 1 })],
    });

    expect(result.metadata).not.toHaveProperty("redemptionFeeBps");
    expect(result.metadata?.redemption).not.toHaveProperty("feeBps");
  });

  it("marks the route paused when no unpaused capacity remains", () => {
    const result = adaptCapVaultState({
      contractAddress: "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc",
      supplyUsd: 100,
      assets: [makeCapAsset({ totalBorrowed: 100, available: 0 })],
    });

    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 0,
      routeStatus: "paused",
    });
  });

  it("emits cap-vault-asset-status-unavailable info warning when paused status cannot be read", () => {
    const result = adaptCapVaultState({
      contractAddress: "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc",
      supplyUsd: 100,
      assets: [makeCapAsset({ paused: true, pausedStatusUnavailable: true })],
    });

    const statusWarning = result.warnings?.find((w) => w.code === "cap-vault-asset-status-unavailable");
    expect(statusWarning).toBeDefined();
    expect(statusWarning?.severity).toBe("info");
    // Paused-treated-as-true must exclude the asset from immediate redeemable capacity.
    expect(result.metadata?.redemption?.capacityUsd).toBe(0);
  });

  it("emits cap-vault-peg-assumed info warning when any active asset lacks priceUsd", () => {
    const result = adaptCapVaultState({
      contractAddress: "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc",
      supplyUsd: 100,
      assets: [makeCapAsset()],
    });

    const pegWarning = result.warnings?.find((w) => w.code === "cap-vault-peg-assumed");
    expect(pegWarning).toBeDefined();
    expect(pegWarning?.severity).toBe("info");
    expect(result.metadata?.totalReserveUsd).toBe(100);
    expect(result.metadata?.redemption?.capacityUsd).toBe(100);
  });

  it("classifies unknown active vault assets as high risk with a degraded warning", () => {
    const result = adaptCapVaultState({
      contractAddress: "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc",
      supplyUsd: 100,
      assets: [makeCapAsset({
        address: "0x9999999999999999999999999999999999999999",
        name: "Cap asset 0x9999...9999",
        risk: "high",
        configured: false,
        decimals: 18,
        totalSupplied: 25,
        available: 25,
      })],
    });

    expect(result.slices).toEqual([
      { sourceKey: "cap-vault:0x9999999999999999999999999999999999999999", name: "Cap asset 0x9999...9999", pct: 100, risk: "high" },
    ]);
    const warning = result.warnings?.find((w) => w.code === "unknown-vault-asset");
    expect(warning).toBeDefined();
    expect(warning?.effect).toBe("degraded");
    expect(result.metadata?.unknownExposurePct).toBe(100);
    // Unconfigured, unpriced, non-USD-like assets are valued at $1.00; surface
    // that the fallback may misstate reserve totals.
    const pegWarning = result.warnings?.find((w) => w.code === "cap-vault-unknown-asset-peg-assumed");
    expect(pegWarning).toBeDefined();
    expect(pegWarning?.severity).toBe("info");
  });

  it("fails closed for configured non-USD-like assets without priceUsd", () => {
    expect(() =>
      adaptCapVaultState({
        contractAddress: "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc",
        supplyUsd: 100,
        assets: [
          {
            address: "0x4200000000000000000000000000000000000006",
            name: "WETH",
            risk: "medium",
            decimals: 18,
            totalSupplied: 1,
            totalBorrowed: 0,
            available: 1,
            paused: false,
            pausedStatusUnavailable: false,
          },
        ],
      }),
    ).toThrow(/missing priceUsd/);
  });

  it("scales totals by priceUsd when configured and omits the peg-assumed warning", () => {
    const result = adaptCapVaultState({
      contractAddress: "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc",
      supplyUsd: null,
      assets: [
        {
          address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          name: "USDC",
          risk: "low",
          decimals: 6,
          totalSupplied: 50,
          totalBorrowed: 0,
          available: 50,
          paused: false,
          pausedStatusUnavailable: false,
          priceUsd: 1,
        },
        {
          address: "0x7712c34205737192402172409a8f7ccef8aa2aec",
          name: "BUIDL",
          risk: "low",
          decimals: 6,
          totalSupplied: 20,
          totalBorrowed: 0,
          available: 20,
          paused: false,
          pausedStatusUnavailable: false,
          priceUsd: 1.05,
        },
      ],
    });

    expect(result.warnings?.some((w) => w.code === "cap-vault-peg-assumed") ?? false).toBe(false);
    // 50 * 1 + 20 * 1.05 = 71
    expect(result.metadata?.totalReserveUsd).toBe(71);
    expect(result.metadata?.redemption?.capacityUsd).toBe(71);
  });
});

describe("fetchCapVaultReserves", () => {
  it("fails closed when the vault contract is not configured for the input chain", async () => {
    const network = installAdapterNetwork(capNetwork());
    await expect(runAdapter("cap-vault", "cusd-cap", {
      network,
      coin: { contracts: [] },
      nowSec: CAP_NOW,
    })).rejects.toThrow(/could not find a ethereum contract/);
    expect(network.rpcCalls).toEqual([]);
  });

  it("fails closed when assets() returns an empty array", async () => {
    const network = installAdapterNetwork(capNetwork({ assets: [] }));
    await expect(runAdapter("cap-vault", "cusd-cap", {
      network,
      nowSec: CAP_NOW,
    })).rejects.toThrow(/assets\(\) returned no assets/);
    expect(network.rpcCalls.some((call) => call.selector === "0x9782e821")).toBe(false);
  });

  it.each([
    ["totalSupplies", /totalSupplies/],
    ["decimals", /decimals/],
    ["totalBorrows", /totalBorrows/],
    ["available", /available/],
  ] as const)("fails closed when %s returns null", async (field, error) => {
    await expect(runAdapter("cap-vault", "cusd-cap", {
      network: capNetwork({ nullField: field }),
      nowSec: CAP_NOW,
    })).rejects.toThrow(error);
  });

  it("fails closed when an asset decimals value is outside the safe range", async () => {
    await expect(runAdapter("cap-vault", "cusd-cap", {
      network: capNetwork({ decimals: { [USDC]: 37n } }),
      nowSec: CAP_NOW,
    })).rejects.toThrow(/expected safe integer 0-36/);
  });

  it("treats paused() undecodable value as paused (conservative) and emits an info warning", async () => {
    const { result } = await runAdapter("cap-vault", "cusd-cap", {
      network: capNetwork({ paused: null }),
      nowSec: CAP_NOW,
    });
    const warning = result.warnings?.find((w) => w.code === "cap-vault-asset-status-unavailable");
    expect(warning).toBeDefined();
    // Paused-treated-as-true must exclude from immediateRedeemable.
    expect(result.metadata?.redemption?.capacityUsd).toBe(0);
  });

  it("reads getRedeemFee() and converts the ray value to bps", async () => {
    const { result, network } = await runAdapter("cap-vault", "cusd-cap", {
      network: capNetwork({ redeemFee: 1_000000000000000000000000n }),
      nowSec: CAP_NOW,
    });
    expect(result.metadata?.observedBlock).toEqual({ chain: "ethereum", number: 12345, timestamp: CAP_NOW });
    expect(network.rpcCalls.every((call) => call.block === "0x3039")).toBe(true);
    expect(result.metadata).not.toHaveProperty("redemptionFeeBps");
    expect(result.metadata?.redemption).toMatchObject({ feeBps: 10 });
    expectValidAdapterOutput("cap-vault", result);
  });

  it("omits the redemption fee when getRedeemFee() is unreadable", async () => {
    const { result } = await runAdapter("cap-vault", "cusd-cap", {
      network: capNetwork({ redeemFee: null }),
      nowSec: CAP_NOW,
    });
    expect(result.metadata).not.toHaveProperty("redemptionFeeBps");
    expect(result.metadata?.redemption).not.toHaveProperty("feeBps");
  });

  it("defaults an unconfigured on-chain asset to high risk and emits a degraded warning", async () => {
    const { result } = await runAdapter("cap-vault", "cusd-cap", {
      network: capNetwork(),
      params: { assets: [] },
      nowSec: CAP_NOW,
    });
    expect(result.slices).toEqual([
      expect.objectContaining({ name: "Cap asset 0xa0b8...eb48", risk: "high" }),
    ]);
    const warning = result.warnings?.find((w) => w.code === "unknown-vault-asset");
    expect(warning).toBeDefined();
    expect(warning?.effect).toBe("degraded");
  });

  it("maps current cusd-cap WTGXX vault asset when explicitly configured", async () => {
    const now = CAP_NOW;
    const navObservedAt = now - 60;
    const { result } = await runAdapter("cap-vault", "cusd-cap", {
      network: capNetwork({
        assets: [USDC, WTGXX],
        navUpdatedAt: navObservedAt,
      }),
      nowSec: now,
    });

    expect(result.slices).toEqual([
      { sourceKey: "cap-vault:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", name: "USDC", pct: 50, risk: "low", coinId: "usdc-circle" },
      { sourceKey: "cap-vault:0x434558cb1ebe9950e8a66f1ef8a15a473dce7d8c", name: "WTGXX", pct: 50, risk: "low", coinId: "wtgxx-wisdomtree", depType: "collateral" },
    ]);
    expect(result.warnings?.some((warning) => warning.code === "unknown-vault-asset") ?? false).toBe(false);
    expect(result.metadata).toMatchObject({
      assetCount: 2,
      totalReserveUsd: 100,
      redemption: {
        outputValuation: {
          sourceId: "cap-vault:chainlink-nav:0xd13cb763c43b5c058e7ec40176962c5030f4eb49",
          observedAt: navObservedAt,
          unitValueUsd: 1,
          basketWeights: [
            { assetId: "usdc-circle", weight: 0.5 },
            { assetId: "wtgxx-wisdomtree", weight: 0.5 },
          ],
        },
      },
    });
  });

  it("fails the CUSD basket snapshot closed when WTGXX Chainlink NAV is stale", async () => {
    const now = CAP_NOW;
    await expect(runAdapter("cap-vault", "cusd-cap", {
      network: capNetwork({ assets: [USDC, WTGXX], navUpdatedAt: now - 345_601 }),
      nowSec: now,
    })).rejects.toThrow(/WTGXX Chainlink NAV is stale/);
  });
});
