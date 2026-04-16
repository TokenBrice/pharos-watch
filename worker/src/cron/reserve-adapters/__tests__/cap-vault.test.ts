import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchOnchainUint256: vi.fn(),
    fetchOnchainRawCall: vi.fn(),
  };
});

import { adaptCapVaultState, fetchCapVaultReserves } from "../cap-vault";
import { fetchOnchainUint256, fetchOnchainRawCall } from "../helpers";

const signal = AbortSignal.timeout(5_000);

beforeEach(() => {
  vi.clearAllMocks();
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
      { name: "USDC", pct: 70, risk: "low", coinId: "usdc-circle" },
      { name: "USDT", pct: 30, risk: "low", coinId: "usdt-tether" },
    ]);
    expect(result.metadata).toMatchObject({
      totalReserveUsd: 100,
      supplyUsd: 100,
      immediateRedeemableUsd: 50,
      immediateRedeemableRatio: 0.5,
      redemption: {
        capacityUsd: 50,
        capacityRatioOfSupply: 0.5,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus: "degraded",
      },
    });
    expect(result.warnings?.some((warning) => warning.code === "cap-asset-paused")).toBe(true);
  });

  it("marks the route paused when no unpaused capacity remains", () => {
    const result = adaptCapVaultState({
      contractAddress: "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc",
      supplyUsd: 100,
      assets: [
        {
          address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          name: "USDC",
          risk: "low",
          decimals: 6,
          totalSupplied: 100,
          totalBorrowed: 100,
          available: 0,
          paused: false,
          pausedStatusUnavailable: false,
        },
      ],
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
      assets: [
        {
          address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          name: "USDC",
          risk: "low",
          decimals: 6,
          totalSupplied: 100,
          totalBorrowed: 0,
          available: 100,
          // Conservative fallback: treat unknown paused status as paused.
          paused: true,
          pausedStatusUnavailable: true,
        },
      ],
    });

    const statusWarning = result.warnings?.find((w) => w.code === "cap-vault-asset-status-unavailable");
    expect(statusWarning).toBeDefined();
    expect(statusWarning?.severity).toBe("info");
    // Paused-treated-as-true must exclude the asset from immediate redeemable capacity.
    expect(result.metadata?.immediateRedeemableUsd).toBe(0);
  });
});

describe("fetchCapVaultReserves", () => {
  const coin = {
    id: "cusd-cap-vault",
    contracts: [
      { chain: "ethereum", address: "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc", decimals: 18 },
    ],
  } as StablecoinMeta;

  const assetAddress = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

  const config: LiveReservesConfig = {
    adapter: "cap-vault",
    version: 1,
    semantics: "collateral-mix",
    inputs: {
      primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
    },
    params: {
      assets: [
        {
          address: assetAddress,
          name: "USDC",
          risk: "low",
        },
      ],
    },
  };

  // Encodes a single-address dynamic-array result for assets() = [assetAddress]
  function encodeSingleAddressArray(address: string): string {
    const stripped = address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    const offset = "0000000000000000000000000000000000000000000000000000000000000020"; // 32
    const length = "0000000000000000000000000000000000000000000000000000000000000001";
    return `0x${offset}${length}${stripped}`;
  }

  // Helper: fill the mock queue for assets(), totalSupply(), then per-asset calls.
  function primeMocks(options: {
    decimals: bigint | null;
    totalSupplies: bigint | null;
    totalBorrows: bigint | null;
    available: bigint | null;
    paused: string | null;
  }) {
    // fetchOnchainRawCall order: assets() → paused()
    vi.mocked(fetchOnchainRawCall)
      .mockResolvedValueOnce(encodeSingleAddressArray(assetAddress))
      .mockResolvedValueOnce(options.paused);

    // fetchOnchainUint256 order: totalSupply(vault) → decimals(asset), totalSupplies(asset), totalBorrows(asset), available(asset)
    vi.mocked(fetchOnchainUint256)
      .mockResolvedValueOnce(100_000000000000000000n) // vault totalSupply (18 decimals)
      .mockResolvedValueOnce(options.decimals) // asset decimals
      .mockResolvedValueOnce(options.totalSupplies) // totalSupplies(asset)
      .mockResolvedValueOnce(options.totalBorrows) // totalBorrows(asset)
      .mockResolvedValueOnce(options.available); // available(asset)
  }

  const encodedFalse = `0x${"0".padStart(64, "0")}`;

  it("fails closed when totalSupplies() returns null", async () => {
    primeMocks({
      decimals: 6n,
      totalSupplies: null,
      totalBorrows: 0n,
      available: 1_000000n,
      paused: encodedFalse,
    });

    await expect(fetchCapVaultReserves(coin, config, signal))
      .rejects.toThrow(/totalSupplies/);
  });

  it("fails closed when decimals() returns null", async () => {
    primeMocks({
      decimals: null,
      totalSupplies: 50_000000n,
      totalBorrows: 0n,
      available: 50_000000n,
      paused: encodedFalse,
    });

    await expect(fetchCapVaultReserves(coin, config, signal))
      .rejects.toThrow(/decimals/);
  });

  it("fails closed when totalBorrows() returns null", async () => {
    primeMocks({
      decimals: 6n,
      totalSupplies: 50_000000n,
      totalBorrows: null,
      available: 50_000000n,
      paused: encodedFalse,
    });

    await expect(fetchCapVaultReserves(coin, config, signal))
      .rejects.toThrow(/totalBorrows/);
  });

  it("fails closed when available() returns null", async () => {
    primeMocks({
      decimals: 6n,
      totalSupplies: 50_000000n,
      totalBorrows: 0n,
      available: null,
      paused: encodedFalse,
    });

    await expect(fetchCapVaultReserves(coin, config, signal))
      .rejects.toThrow(/available/);
  });

  it("treats paused() undecodable value as paused (conservative) and emits an info warning", async () => {
    primeMocks({
      decimals: 6n,
      totalSupplies: 50_000000n,
      totalBorrows: 0n,
      available: 50_000000n,
      paused: null,
    });

    const result = await fetchCapVaultReserves(coin, config, signal);
    const warning = result.warnings?.find((w) => w.code === "cap-vault-asset-status-unavailable");
    expect(warning).toBeDefined();
    // Paused-treated-as-true must exclude from immediateRedeemable
    expect(result.metadata?.immediateRedeemableUsd).toBe(0);
  });
});
