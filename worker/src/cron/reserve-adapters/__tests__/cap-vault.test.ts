import { describe, expect, it } from "vitest";
import { encodeAddress, encodeUint256 } from "../../../lib/evm-selectors";

import { adaptCapVaultState } from "../cap-vault";
import { deriveEffectiveDependencySet } from "@shared/lib/dependency-derivation";
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

describe("untyped Cap declarations", () => {
  it("preserves a missing type so dependency derivation withholds the holding", () => {
    const result = adaptCapVaultState({
      contractAddress: CAP_VAULT, supplyUsd: 100,
      assets: [makeCapAsset({ coinId: "usdc-circle" })],
    });
    expect(result.slices[0]).toMatchObject({ coinId: "usdc-circle", pct: 100 });
    expect(result.slices[0].depType).toBeUndefined();
    const derived = deriveEffectiveDependencySet({}, { liveReserveSlices: result.slices });
    expect(derived.dependencies).toEqual([]);
    expect(derived.coinIdWithoutDepTypeCount).toBe(1);
    expect(derived.rejectionReasons).toContainEqual(expect.objectContaining({
      reason: "coinId-without-depType", upstreamAssetId: "usdc-circle",
    }));
  });
});


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
          depType: "collateral",
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
          depType: "collateral",
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
      { sourceKey: "cap-vault:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", name: "USDC", pct: 70, risk: "low", coinId: "usdc-circle", depType: "collateral" },
      { sourceKey: "cap-vault:0xdac17f958d2ee523a2206206994597c13d831ec7", name: "USDT", pct: 30, risk: "low", coinId: "usdt-tether", depType: "collateral" },
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

  it("fails closed for an unknown non-USD-like asset with positive supply", () => {
    expect(() =>
      adaptCapVaultState({
        contractAddress: "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc",
        supplyUsd: 100,
        assets: [makeCapAsset({
          address: "0x9999999999999999999999999999999999999999",
          name: "WBTC",
          risk: "high",
          configured: false,
          decimals: 8,
          totalSupplied: 25,
          available: 25,
        })],
      }),
    ).toThrow('cap-vault asset "WBTC" missing priceUsd and is not USD-like');
  });

  it("warns when an unknown USD-like asset uses the 1 USD peg assumption", () => {
    const result = adaptCapVaultState({
      contractAddress: "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc",
      supplyUsd: 100,
      assets: [makeCapAsset({
        address: "0x9999999999999999999999999999999999999999",
        name: "USDC",
        risk: "high",
        configured: false,
        decimals: 6,
        totalSupplied: 25,
        available: 25,
      })],
    });

    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unknown-vault-asset", effect: "degraded" }),
      expect.objectContaining({ code: "cap-vault-unknown-asset-peg-assumed", severity: "info" }),
    ]));
    expect(result.metadata?.totalReserveUsd).toBe(25);
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

describe("Cap redemption output valuation", () => {
  it("values a single source-priced holding without treating its NAV as a fixed peg", () => {
    const result = adaptCapVaultState({
      contractAddress: CAP_VAULT,
      supplyUsd: 100,
      assets: [makeCapAsset({
        address: WTGXX, name: "WTGXX", coinId: "wtgxx-wisdomtree", depType: "collateral",
        totalSupplied: 80, available: 40, priceUsd: 1.25,
        priceSourceId: `chainlink-nav:${WTGXX_ORACLE}`, priceObservedAt: CAP_NOW - 60,
      })],
    });
    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 50,
      outputValuation: {
        sourceId: `cap-vault:chainlink-nav:${WTGXX_ORACLE}`,
        observedAt: CAP_NOW - 60, unitValueUsd: 1,
        basketWeights: [{ assetId: "wtgxx-wisdomtree", weight: 1 }],
      },
    });
    expectValidAdapterOutput("cap-vault", result);
  });

  it("weights every holding by its sourced dollar value and dates the basket to the oldest price", () => {
    const result = adaptCapVaultState({
      contractAddress: CAP_VAULT,
      supplyUsd: 100,
      assets: [
        makeCapAsset({
          coinId: "usdc-circle", depType: "collateral", totalSupplied: 50, available: 50,
          priceUsd: 0.9, priceSourceId: "market:usdc", priceObservedAt: CAP_NOW - 120,
        }),
        makeCapAsset({
          address: WTGXX, name: "WTGXX", coinId: "wtgxx-wisdomtree", depType: "collateral",
          totalSupplied: 50, available: 50, priceUsd: 1.1,
          priceSourceId: `chainlink-nav:${WTGXX_ORACLE}`, priceObservedAt: CAP_NOW - 60,
        }),
      ],
    });
    const valuation = result.metadata?.redemption?.outputValuation;
    expect(valuation).toMatchObject({
      sourceId: `cap-vault:chainlink-nav:${WTGXX_ORACLE}+market:usdc`,
      observedAt: CAP_NOW - 120, unitValueUsd: 1,
    });
    expect(valuation?.basketWeights?.[0]).toMatchObject({ assetId: "usdc-circle" });
    expect(valuation?.basketWeights?.[0]?.weight).toBeCloseTo(0.45);
    expect(valuation?.basketWeights?.[1]).toMatchObject({ assetId: "wtgxx-wisdomtree" });
    expect(valuation?.basketWeights?.[1]?.weight).toBeCloseTo(0.55);
    expectValidAdapterOutput("cap-vault", result);
  });

  it.each([
    ["identity", { coinId: undefined }],
    ["price", { priceUsd: undefined }],
    ["source", { priceSourceId: undefined }],
    ["observation", { priceObservedAt: undefined }],
  ] as const)("withholds the entire basket valuation when one active holding lacks %s", (_field, missing) => {
    const result = adaptCapVaultState({
      contractAddress: CAP_VAULT, supplyUsd: 100,
      assets: [
        makeCapAsset({
          coinId: "usdc-circle", totalSupplied: 50, available: 50,
          priceUsd: 1, priceSourceId: "market:usdc", priceObservedAt: CAP_NOW - 60,
        }),
        makeCapAsset({
          address: "0xdac17f958d2ee523a2206206994597c13d831ec7", name: "USDT",
          coinId: "usdt-tether", totalSupplied: 50, available: 50,
          priceUsd: 1, priceSourceId: "market:usdt", priceObservedAt: CAP_NOW - 60,
          ...missing,
        }),
      ],
    });
    expect(result.metadata?.totalReserveUsd).toBe(100);
    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 100 });
    expect(result.metadata?.redemption).not.toHaveProperty("outputValuation");
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

  it("fails closed for an unconfigured on-chain asset that is not symbol-recognized as USD-like", async () => {
    await expect(runAdapter("cap-vault", "cusd-cap", {
      network: capNetwork(),
      params: { assets: [] },
      nowSec: CAP_NOW,
    })).rejects.toThrow(/missing priceUsd and is not USD-like/);
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
      { sourceKey: "cap-vault:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", name: "USDC", pct: 50, risk: "low", coinId: "usdc-circle", depType: "collateral" },
      { sourceKey: "cap-vault:0x434558cb1ebe9950e8a66f1ef8a15a473dce7d8c", name: "WTGXX", pct: 50, risk: "low", coinId: "wtgxx-wisdomtree", depType: "collateral" },
    ]);
    expect(result.warnings?.some((warning) => warning.code === "unknown-vault-asset") ?? false).toBe(false);
    expect(result.metadata).toMatchObject({
      assetCount: 2,
      totalReserveUsd: 100,
    });
    expect(result.metadata).not.toHaveProperty("redemption.outputValuation");
  });

  it("publishes a source-bound NAV for a WTGXX-only vault at the maximum accepted oracle age", async () => {
    const { result } = await runAdapter("cap-vault", "cusd-cap", {
      network: capNetwork({ assets: [WTGXX], navAnswer: 120_000_000n, navUpdatedAt: CAP_NOW - 345_600 }),
      nowSec: CAP_NOW,
    });
    expect(result.metadata?.totalReserveUsd).toBe(60);
    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 60,
      outputValuation: {
        sourceId: `cap-vault:chainlink-nav:${WTGXX_ORACLE}`,
        observedAt: CAP_NOW - 345_600, unitValueUsd: 0.6,
        basketWeights: [{ assetId: "wtgxx-wisdomtree", weight: 1 }],
      },
    });
    expectValidAdapterOutput("cap-vault", result);
  });

  it.each(["0x313ce567", "0xfeaf968c"])("rejects the snapshot when WTGXX NAV read %s reverts", async (selector) => {
    const network = capNetwork({ assets: [WTGXX] });
    network.rpc[`${WTGXX_ORACLE}:${selector}`] = null;
    await expect(runAdapter("cap-vault", "cusd-cap", {
      network, nowSec: CAP_NOW,
    })).rejects.toThrow("WTGXX Chainlink NAV read failed");
  });

  it("accepts the future-clock allowance boundary and rejects a NAV one second beyond it", async () => {
    const { result } = await runAdapter("cap-vault", "cusd-cap", {
      network: capNetwork({ assets: [WTGXX], navUpdatedAt: CAP_NOW + 600 }), nowSec: CAP_NOW,
    });
    expect(result.metadata?.redemption?.outputValuation?.observedAt).toBe(CAP_NOW + 600);
    await expect(runAdapter("cap-vault", "cusd-cap", {
      network: capNetwork({ assets: [WTGXX], navUpdatedAt: CAP_NOW + 601 }), nowSec: CAP_NOW,
    })).rejects.toThrow("WTGXX Chainlink NAV timestamp is in the future (601s)");
  });

  it("fails the CUSD basket snapshot closed when WTGXX Chainlink NAV is stale", async () => {
    const now = CAP_NOW;
    await expect(runAdapter("cap-vault", "cusd-cap", {
      network: capNetwork({ assets: [USDC, WTGXX], navUpdatedAt: now - 345_601 }),
      nowSec: now,
    })).rejects.toThrow(/WTGXX Chainlink NAV is stale/);
  });
});
