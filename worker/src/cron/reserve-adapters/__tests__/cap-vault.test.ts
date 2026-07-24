import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { encodeAddress, encodeUint256 } from "../../../lib/evm-selectors";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  const fetchOnchainUint256 = vi.fn();
  const fetchOnchainRawCall = vi.fn();
  return {
    ...actual,
    fetchOnchainUint256,
    fetchOnchainRawCall,
    makeOnchainCallers: vi.fn((
      input: { chain?: string; rpcMode?: unknown },
      options: { signal: AbortSignal; ctx?: unknown; rpcUrl?: string; fallbackRpcUrl?: string; timeoutMs?: number },
    ) => ({
      uint256: (contract: string, data: string) =>
        fetchOnchainUint256({
          contract,
          data,
          signal: options.signal,
          ctx: options.ctx,
          rpcMode: input.rpcMode,
          chain: input.chain,
          rpcUrl: options.rpcUrl,
          fallbackRpcUrl: options.fallbackRpcUrl,
          timeoutMs: options.timeoutMs,
        }),
      raw: (contract: string, data: string) =>
        fetchOnchainRawCall({
          contract,
          data,
          signal: options.signal,
          ctx: options.ctx,
          rpcMode: input.rpcMode,
          chain: input.chain,
          rpcUrl: options.rpcUrl,
          fallbackRpcUrl: options.fallbackRpcUrl,
          timeoutMs: options.timeoutMs,
        }),
    })),
  };
});

import { adaptCapVaultState, fetchCapVaultReserves } from "../cap-vault";
import { fetchOnchainUint256, fetchOnchainRawCall } from "../helpers";
import { getReserveAdapter } from "../index";
import { validateAdapterOutput } from "../validate";

function makeSignal(): AbortSignal {
  return AbortSignal.timeout(5_000);
}

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
      assets: [
        {
          address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          name: "USDC",
          risk: "low",
          coinId: "usdc-circle",
          decimals: 6,
          totalSupplied: 100,
          totalBorrowed: 0,
          available: 100,
          paused: false,
          pausedStatusUnavailable: false,
          priceUsd: 1,
        },
      ],
    });

    expect(result.metadata?.redemptionFeeBps).toBe(0);
    expect(result.metadata?.redemption).toMatchObject({ feeBps: 0 });
    expect(validateAdapterOutput(result, { adapter: getReserveAdapter("cap-vault") ?? undefined }).valid).toBe(true);
  });

  it("omits the redemption fee telemetry when the redeem fee could not be read", () => {
    const result = adaptCapVaultState({
      contractAddress: "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc",
      supplyUsd: 100,
      redemptionFeeBps: null,
      assets: [
        {
          address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          name: "USDC",
          risk: "low",
          decimals: 6,
          totalSupplied: 100,
          totalBorrowed: 0,
          available: 100,
          paused: false,
          pausedStatusUnavailable: false,
          priceUsd: 1,
        },
      ],
    });

    expect(result.metadata?.redemptionFeeBps).toBeUndefined();
    expect(result.metadata?.redemption).not.toHaveProperty("feeBps");
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

  it("emits cap-vault-peg-assumed info warning when any active asset lacks priceUsd", () => {
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
          paused: false,
          pausedStatusUnavailable: false,
        },
      ],
    });

    const pegWarning = result.warnings?.find((w) => w.code === "cap-vault-peg-assumed");
    expect(pegWarning).toBeDefined();
    expect(pegWarning?.severity).toBe("info");
    expect(result.metadata?.totalReserveUsd).toBe(100);
    expect(result.metadata?.immediateRedeemableUsd).toBe(100);
  });

  it("classifies unknown active vault assets as high risk with a degraded warning", () => {
    const result = adaptCapVaultState({
      contractAddress: "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc",
      supplyUsd: 100,
      assets: [
        {
          address: "0x9999999999999999999999999999999999999999",
          name: "Cap asset 0x9999...9999",
          risk: "high",
          configured: false,
          decimals: 18,
          totalSupplied: 25,
          totalBorrowed: 0,
          available: 25,
          paused: false,
          pausedStatusUnavailable: false,
        },
      ],
    });

    expect(result.slices).toEqual([
      { name: "Cap asset 0x9999...9999", pct: 100, risk: "high" },
    ]);
    const warning = result.warnings?.find((w) => w.code === "unknown-vault-asset");
    expect(warning).toBeDefined();
    expect(warning?.effect).toBe("degraded");
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
    expect(result.metadata?.immediateRedeemableUsd).toBe(71);
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

  function encodeAddressArray(addresses: string[]): string {
    const offset = encodeUint256(32);
    const length = encodeUint256(addresses.length);
    const encodedAddresses = addresses.map((address) => encodeAddress(address)).join("");
    return `0x${offset}${length}${encodedAddresses}`;
  }

  function encodeLatestRoundData(answer: bigint, updatedAt: number): `0x${string}` {
    const word = (value: bigint) => value.toString(16).padStart(64, "0");
    return `0x${word(1n)}${word(answer)}${word(BigInt(updatedAt))}${word(BigInt(updatedAt))}${word(1n)}`;
  }

  // Encodes a single-address dynamic-array result for assets() = [assetAddress]
  function encodeSingleAddressArray(address: string): string {
    return encodeAddressArray([address]);
  }

  // Helper: fill the mock queue for assets(), totalSupply(), getRedeemFee(), then per-asset calls.
  function primeMocks(options: {
    decimals: bigint | null;
    totalSupplies: bigint | null;
    totalBorrows: bigint | null;
    available: bigint | null;
    paused: string | null;
    redeemFee?: bigint | null;
  }) {
    // fetchOnchainRawCall order: assets() → paused()
    vi.mocked(fetchOnchainRawCall)
      .mockResolvedValueOnce(encodeSingleAddressArray(assetAddress))
      .mockResolvedValueOnce(options.paused);

    // fetchOnchainUint256 order: totalSupply(vault), getRedeemFee(vault) → decimals(asset), totalSupplies(asset), totalBorrows(asset), available(asset)
    vi.mocked(fetchOnchainUint256)
      .mockResolvedValueOnce(100_000000000000000000n) // vault totalSupply (18 decimals)
      .mockResolvedValueOnce(options.redeemFee === undefined ? 0n : options.redeemFee) // vault getRedeemFee() (ray)
      .mockResolvedValueOnce(options.decimals) // asset decimals
      .mockResolvedValueOnce(options.totalSupplies) // totalSupplies(asset)
      .mockResolvedValueOnce(options.totalBorrows) // totalBorrows(asset)
      .mockResolvedValueOnce(options.available); // available(asset)
  }

  const encodedFalse = `0x${encodeUint256(0n)}`;
  const wtgxxAddress = "0x434558cb1ebe9950e8a66f1ef8a15a473dce7d8c";
  const basketConfig: LiveReservesConfig = {
    ...config,
    params: {
      assets: [
        {
          address: assetAddress,
          name: "USDC",
          risk: "low",
          coinId: "usdc-circle",
          priceUsd: 1,
        },
        {
          address: wtgxxAddress,
          name: "WTGXX",
          risk: "low",
          coinId: "wtgxx-wisdomtree",
          depType: "collateral",
          priceUsd: 1,
        },
      ],
    },
  };

  function primeWtgxxBasketMocks(navObservedAt: number) {
    vi.mocked(fetchOnchainRawCall)
      .mockResolvedValueOnce(encodeAddressArray([assetAddress, wtgxxAddress]))
      .mockResolvedValueOnce(encodedFalse)
      .mockResolvedValueOnce(encodedFalse)
      .mockResolvedValueOnce(encodeLatestRoundData(100_000_000n, navObservedAt));

    vi.mocked(fetchOnchainUint256)
      .mockResolvedValueOnce(100_000000000000000000n) // vault totalSupply (18 decimals)
      .mockResolvedValueOnce(0n) // vault getRedeemFee() (ray)
      .mockResolvedValueOnce(6n) // USDC decimals
      .mockResolvedValueOnce(50_000000n) // USDC totalSupplies
      .mockResolvedValueOnce(0n) // USDC totalBorrows
      .mockResolvedValueOnce(50_000000n) // USDC available
      .mockResolvedValueOnce(18n) // WTGXX decimals
      .mockResolvedValueOnce(50_000000000000000000n) // WTGXX totalSupplies
      .mockResolvedValueOnce(0n) // WTGXX totalBorrows
      .mockResolvedValueOnce(50_000000000000000000n) // WTGXX available
      .mockResolvedValueOnce(8n); // WTGXX Chainlink NAV decimals
  }

  it("fails closed when the vault contract is not configured for the input chain", async () => {
    const unsupportedCoin = {
      id: "cusd-cap-vault",
      contracts: [],
    } as unknown as StablecoinMeta;

    await expect(fetchCapVaultReserves(unsupportedCoin, config, makeSignal()))
      .rejects.toThrow(/could not find a ethereum contract/);
    expect(fetchOnchainRawCall).not.toHaveBeenCalled();
    expect(fetchOnchainUint256).not.toHaveBeenCalled();
  });

  it("fails closed when assets() returns an empty array", async () => {
    vi.mocked(fetchOnchainRawCall).mockResolvedValueOnce(encodeAddressArray([]));

    await expect(fetchCapVaultReserves(coin, config, makeSignal()))
      .rejects.toThrow(/assets\(\) returned no assets/);
    expect(fetchOnchainUint256).not.toHaveBeenCalled();
  });

  it("fails closed when totalSupplies() returns null", async () => {
    primeMocks({
      decimals: 6n,
      totalSupplies: null,
      totalBorrows: 0n,
      available: 1_000000n,
      paused: encodedFalse,
    });

    await expect(fetchCapVaultReserves(coin, config, makeSignal()))
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

    await expect(fetchCapVaultReserves(coin, config, makeSignal()))
      .rejects.toThrow(/decimals/);
  });

  it("fails closed when decimals() returns an out-of-bound value", async () => {
    primeMocks({
      decimals: 37n,
      totalSupplies: 50_000000n,
      totalBorrows: 0n,
      available: 50_000000n,
      paused: encodedFalse,
    });

    await expect(fetchCapVaultReserves(coin, config, makeSignal()))
      .rejects.toThrow(/expected safe integer 0-36/);
  });

  it("fails closed when totalBorrows() returns null", async () => {
    primeMocks({
      decimals: 6n,
      totalSupplies: 50_000000n,
      totalBorrows: null,
      available: 50_000000n,
      paused: encodedFalse,
    });

    await expect(fetchCapVaultReserves(coin, config, makeSignal()))
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

    await expect(fetchCapVaultReserves(coin, config, makeSignal()))
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

    const result = await fetchCapVaultReserves(coin, config, makeSignal());
    const warning = result.warnings?.find((w) => w.code === "cap-vault-asset-status-unavailable");
    expect(warning).toBeDefined();
    // Paused-treated-as-true must exclude from immediateRedeemable
    expect(result.metadata?.immediateRedeemableUsd).toBe(0);
  });

  it("reads getRedeemFee() and converts the ray value to bps", async () => {
    primeMocks({
      decimals: 6n,
      totalSupplies: 50_000000n,
      totalBorrows: 0n,
      available: 50_000000n,
      paused: encodedFalse,
      redeemFee: 1_000000000000000000000000n, // 1e24 ray == 10 bps
    });

    const result = await fetchCapVaultReserves(coin, config, makeSignal());
    expect(result.metadata?.redemptionFeeBps).toBe(10);
    expect(result.metadata?.redemption).toMatchObject({ feeBps: 10 });
    expect(validateAdapterOutput(result, { adapter: getReserveAdapter("cap-vault") ?? undefined }).valid).toBe(true);
  });

  it("omits the redemption fee when getRedeemFee() is unreadable", async () => {
    primeMocks({
      decimals: 6n,
      totalSupplies: 50_000000n,
      totalBorrows: 0n,
      available: 50_000000n,
      paused: encodedFalse,
      redeemFee: null,
    });

    const result = await fetchCapVaultReserves(coin, config, makeSignal());
    expect(result.metadata?.redemptionFeeBps).toBeUndefined();
    expect(result.metadata?.redemption).not.toHaveProperty("feeBps");
  });

  it("defaults an unconfigured on-chain asset to high risk and emits a degraded warning", async () => {
    primeMocks({
      decimals: 6n,
      totalSupplies: 50_000000n,
      totalBorrows: 0n,
      available: 50_000000n,
      paused: encodedFalse,
    });

    const result = await fetchCapVaultReserves(
      coin,
      {
        ...config,
        params: { assets: [] },
      },
      makeSignal(),
    );

    expect(result.slices).toEqual([
      expect.objectContaining({ name: "Cap asset 0xa0b8...eb48", risk: "high" }),
    ]);
    const warning = result.warnings?.find((w) => w.code === "unknown-vault-asset");
    expect(warning).toBeDefined();
    expect(warning?.effect).toBe("degraded");
  });

  it("maps current cusd-cap WTGXX vault asset when explicitly configured", async () => {
    const now = Date.UTC(2026, 6, 24) / 1_000;
    const navObservedAt = now - 60;
    primeWtgxxBasketMocks(navObservedAt);

    const result = await fetchCapVaultReserves(
      coin,
      basketConfig,
      makeSignal(),
      { nowSec: now },
    );

    expect(result.slices).toEqual([
      { name: "USDC", pct: 50, risk: "low", coinId: "usdc-circle" },
      { name: "WTGXX", pct: 50, risk: "low", coinId: "wtgxx-wisdomtree", depType: "collateral" },
    ]);
    expect(result.warnings?.some((warning) => warning.code === "unknown-vault-asset") ?? false).toBe(false);
    expect(result.metadata).toMatchObject({
      assetCount: 2,
      totalReserveUsd: 100,
      immediateRedeemableUsd: 100,
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
    const now = Date.UTC(2026, 6, 24) / 1_000;
    primeWtgxxBasketMocks(now - 345_601);

    await expect(fetchCapVaultReserves(
      coin,
      basketConfig,
      makeSignal(),
      { nowSec: now },
    )).rejects.toThrow(/WTGXX Chainlink NAV is stale/);
  });
});
