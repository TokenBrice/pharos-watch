import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchErc20TotalSupply: vi.fn(),
    fetchOnchainMulticall3: vi.fn(),
  };
});

import { fetchErc20TotalSupply, fetchOnchainMulticall3 } from "../helpers";
import { fetchAnzenUsdzReserves } from "../anzen-usdz";
import { getReserveAdapter } from "../index";
import { validateAdapterOutput } from "../validate";

const signal = AbortSignal.timeout(5_000);

const SPCT_POOL_CONTRACT = "0xf30a29F1C540724Fd8c5c4Be1AF604a6C6800D29";
const USDC_CONTRACT = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const ORACLE_CONTRACT = "0x900fff3bbf47ded50fd4940d055e1324f38b0d4f";
const FEE_COEFFICIENT = 100_000_000n;

function word(value: bigint | boolean | string): `0x${string}` {
  if (typeof value === "string") {
    return `0x${value.replace(/^0x/, "").toLowerCase().padStart(64, "0")}` as `0x${string}`;
  }
  const uint = typeof value === "boolean" ? (value ? 1n : 0n) : value;
  return `0x${uint.toString(16).padStart(64, "0")}` as `0x${string}`;
}

/**
 * Route the mocked multicall by label: the probe reads the three pinned
 * identities, both pause flags, the SPCT reserve and both USDC balances in one
 * batch, so an ordered mock queue would be fragile here.
 */
function primeUsdzRedeemMocks(overrides: Partial<Record<string, `0x${string}`>> = {}, options: { fail?: boolean } = {}) {
  const defaults: Record<string, `0x${string}`> = {
    "usdz:usdc": word(USDC_CONTRACT),
    "usdz:spct": word(SPCT_POOL_CONTRACT),
    "usdz:oracle": word(ORACLE_CONTRACT),
    "usdz:paused": word(false),
    "usdz:collateral-rate": word(1n),
    "usdz:redeem-fee-rate": word(0n),
    "usdz:fee-coefficient": word(FEE_COEFFICIENT),
    "spct:reserve-usd": word(4_000_000_000n),
    "spct:paused": word(false),
    "spct:redeem-fee-rate": word(0n),
    "spct:fee-coefficient": word(FEE_COEFFICIENT),
    "spct:usdz-whitelisted": word(true),
    "usdc:spct-balance": word(4_000_000_000n),
    "usdc:usdz-balance": word(0n),
    "oracle:price": word(10n ** 18n),
  };
  const values = { ...defaults, ...overrides };
  vi.mocked(fetchOnchainMulticall3).mockImplementation((args: unknown) => {
    if (options.fail) return Promise.resolve(null);
    const { calls } = args as { calls: Array<{ label: string }> };
    return Promise.resolve(
      calls.map((call) => ({ label: call.label, success: true, returnData: values[call.label] ?? word(0n) })),
    );
  });
}

function primeSupplyMocks() {
  vi.mocked(fetchErc20TotalSupply)
    .mockResolvedValueOnce(10_000_000n * 10n ** 18n)
    .mockResolvedValueOnce(4_000_000n * 10n ** 18n)
    .mockResolvedValueOnce(2_500_000n * 10n ** 18n)
    .mockResolvedValueOnce(750_000n * 10n ** 18n)
    .mockResolvedValueOnce(250_000n * 10n ** 18n)
    .mockResolvedValueOnce(17_600_000n * 10n ** 18n);
}

function makeCoin(): StablecoinMeta {
  return {
    id: "usdz-anzen",
    name: "Anzen USDz",
    ticker: "USDz",
    contracts: [
      { chain: "ethereum", address: "0xA469B7Ee9ee773642b3e93E842e5D9b5BaA10067", decimals: 18 },
      { chain: "base", address: "0x04D5ddf5f3a8939889F11E97f8c4BB48317F1938", decimals: 18 },
      { chain: "arbitrum", address: "0x5018609AB477cC502e170A5aCcf5312B86a4b94f", decimals: 18 },
      { chain: "blast", address: "0x52056ED29Fe015f4Ba2e3b079D10C0B87f46e8c6", decimals: 18 },
      { chain: "manta", address: "0x73d23F3778a90Be8846E172354A115543dF2a7E4", decimals: 18 },
    ],
  } as unknown as StablecoinMeta;
}

const config: LiveReservesConfig = {
  adapter: "anzen-usdz",
  version: 1,
  semantics: "single-asset",
  inputs: {
    primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  primeUsdzRedeemMocks();
});

describe("fetchAnzenUsdzReserves", () => {
  it("computes multichain USDz supply against the onchain SPCT reserve pool", async () => {
    vi.mocked(fetchErc20TotalSupply)
      .mockResolvedValueOnce(10_000_000n * 10n ** 18n)
      .mockResolvedValueOnce(4_000_000n * 10n ** 18n)
      .mockResolvedValueOnce(2_500_000n * 10n ** 18n)
      .mockResolvedValueOnce(750_000n * 10n ** 18n)
      .mockResolvedValueOnce(250_000n * 10n ** 18n)
      .mockResolvedValueOnce(17_600_000n * 10n ** 18n);

    const result = await fetchAnzenUsdzReserves(makeCoin(), config, signal);

    expect(result.slices).toEqual([
      { name: "SPCT (Secured Private Credit Token)", pct: 100, risk: "high" },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      totalReserveUsd: 17_600_000,
      supplyUsd: 17_500_000,
      collateralizationRatio: 17_600_000 / 17_500_000,
      details: {
        proofKind: "multichain-usdz-vs-spct-total-supply",
        reserveSourceLabel: "SPCT pool total supply",
        supplyByChainUsd: {
          ethereum: 10_000_000,
          base: 4_000_000,
          arbitrum: 2_500_000,
          blast: 750_000,
          manta: 250_000,
        },
      },
    });

    expect(fetchErc20TotalSupply).toHaveBeenCalledTimes(6);
    expect(vi.mocked(fetchErc20TotalSupply).mock.calls[3]?.[4]).toBe("https://rpc.blast.io");
    expect(vi.mocked(fetchErc20TotalSupply).mock.calls[4]?.[4]).toBe("https://pacific-rpc.manta.network/http");
  });

  it("does not infer redemption capacity from SPCT collateralization alone", async () => {
    vi.mocked(fetchErc20TotalSupply)
      .mockResolvedValueOnce(5_000_000n * 10n ** 18n)
      .mockResolvedValueOnce(1n)
      .mockResolvedValueOnce(1n)
      .mockResolvedValueOnce(1n)
      .mockResolvedValueOnce(1n)
      .mockResolvedValueOnce(10_000_000n * 10n ** 18n);

    const result = await fetchAnzenUsdzReserves(makeCoin(), config, signal);

    expect(result.metadata).toMatchObject({
      totalReserveUsd: 10_000_000,
      collateralizationRatio: expect.any(Number),
    });
    expect(result.metadata?.immediateRedeemableUsd).toBeUndefined();
    expect(result.metadata?.immediateRedeemableRatio).toBeUndefined();
    // Capacity tracks the redeem route's own USDC, never the $10m SPCT pool.
    expect(result.metadata?.redemption?.capacityUsd).toBe(4_000);
  });

  it("fails closed when required chain metadata is missing", async () => {
    const coin = makeCoin();
    coin.contracts = coin.contracts?.filter((entry) => entry.chain !== "blast");

    await expect(fetchAnzenUsdzReserves(coin, config, signal)).rejects.toThrow(
      "anzen-usdz missing blast contract metadata",
    );
  });

  it("fails closed when a supply probe returns zero or null", async () => {
    vi.mocked(fetchErc20TotalSupply)
      .mockResolvedValueOnce(10_000_000n * 10n ** 18n)
      .mockResolvedValueOnce(4_000_000n * 10n ** 18n)
      .mockResolvedValueOnce(2_500_000n * 10n ** 18n)
      .mockResolvedValueOnce(null);

    await expect(fetchAnzenUsdzReserves(makeCoin(), config, signal)).rejects.toThrow(
      "anzen-usdz totalSupply probe failed for usdz-anzen on blast",
    );
  });
});

describe("fetchAnzenUsdzReserves redeem-route telemetry", () => {
  it("reports the route open and binds capacity to the SPCT reserve and settleable USDC", async () => {
    primeSupplyMocks();
    const result = await fetchAnzenUsdzReserves(makeCoin(), config, signal);

    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 4_000,
      capacityKind: "live-direct",
      freshnessKind: "same-run-onchain",
      holderEligibility: "any-holder",
      settlementDelaySec: 0,
      routeStatus: "open",
      routeStatusSource: "onchain",
      feeBps: 0,
    });
    expect(result.metadata?.redemption?.routeStatusReason).toContain("reserveUSD()");
    expect(result.metadata?.details).toMatchObject({
      redeemRoute: {
        proofKind: "usdz-redeem-spct-reserve-and-usdc-settlement",
        spctReserveUsdRaw: "4000000000",
        spctUsdcBalanceRaw: "4000000000",
        usdzUsdcBalanceRaw: "0",
        routeOpen: true,
      },
    });
    expect(result.warnings).toBeUndefined();
    expect(validateAdapterOutput(result, { adapter: getReserveAdapter("anzen-usdz") ?? undefined }).valid).toBe(true);
  });

  it("binds capacity to the settlement leg when the SPCT pool cannot pay out its accounted reserve", async () => {
    primeSupplyMocks();
    primeUsdzRedeemMocks({
      "spct:reserve-usd": word(9_000_000_000n),
      "usdc:spct-balance": word(1_200_000_000n),
      "usdc:usdz-balance": word(300_000_000n),
    });

    const result = await fetchAnzenUsdzReserves(makeCoin(), config, signal);

    expect(result.metadata?.redemption?.capacityUsd).toBe(1_500);
  });

  it("publishes the measured zero capacity without claiming the route is open", async () => {
    // A drained SPCT pool is not a paused one, so neither "open" nor "paused"
    // is an honest claim while the route has nothing to pay out.
    primeSupplyMocks();
    primeUsdzRedeemMocks({
      "spct:reserve-usd": word(0n),
      "usdc:spct-balance": word(0n),
      "usdc:usdz-balance": word(0n),
    });

    const result = await fetchAnzenUsdzReserves(makeCoin(), config, signal);

    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 0, feeBps: 0 });
    expect(result.metadata?.redemption?.routeStatus).toBeUndefined();
    expect(result.metadata?.redemption?.routeStatusSource).toBeUndefined();
    expect(validateAdapterOutput(result, { adapter: getReserveAdapter("anzen-usdz") ?? undefined }).valid).toBe(true);
  });

  it("withholds route openness while the SPCT pool is paused", async () => {
    primeSupplyMocks();
    primeUsdzRedeemMocks({ "spct:paused": word(true) });

    const result = await fetchAnzenUsdzReserves(makeCoin(), config, signal);

    expect(result.metadata?.redemption?.capacityUsd).toBe(4_000);
    expect(result.metadata?.redemption?.routeStatus).toBeUndefined();
    expect(result.metadata?.details).toMatchObject({ redeemRoute: { routeOpen: false } });
  });

  it("withholds route openness while the oracle price sits under the collateral rate", async () => {
    primeSupplyMocks();
    primeUsdzRedeemMocks({ "oracle:price": word(10n ** 18n - 1n) });

    const result = await fetchAnzenUsdzReserves(makeCoin(), config, signal);

    expect(result.metadata?.redemption?.routeStatus).toBeUndefined();
  });

  it("composes the USDz and SPCT redeem fees instead of adding them", async () => {
    primeSupplyMocks();
    // 1% then 1% of the remainder retains 0.99 * 0.99, so 199bps rather than 200.
    primeUsdzRedeemMocks({
      "usdz:redeem-fee-rate": word(1_000_000n),
      "spct:redeem-fee-rate": word(1_000_000n),
    });

    const result = await fetchAnzenUsdzReserves(makeCoin(), config, signal);

    expect(result.metadata?.redemption?.feeBps).toBe(199);
  });

  it("withholds the fee when a rate exceeds its own contract coefficient", async () => {
    primeSupplyMocks();
    primeUsdzRedeemMocks({ "usdz:redeem-fee-rate": word(FEE_COEFFICIENT + 1n) });

    const result = await fetchAnzenUsdzReserves(makeCoin(), config, signal);

    expect(result.metadata?.redemption?.capacityUsd).toBe(4_000);
    expect(result.metadata?.redemption?.feeBps).toBeUndefined();
  });

  it("withholds the whole redemption block when the pinned SPCT identity no longer matches", async () => {
    primeSupplyMocks();
    primeUsdzRedeemMocks({ "usdz:spct": word("0x1111111111111111111111111111111111111111") });

    const result = await fetchAnzenUsdzReserves(makeCoin(), config, signal);

    expect(result.metadata?.redemption).toBeUndefined();
    expect(result.metadata?.details).not.toHaveProperty("redeemRoute");
    expect(result.warnings ?? []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "anzen-usdz-redeem-route-unreadable", effect: "info" }),
      ]),
    );
    expect(validateAdapterOutput(result, { adapter: getReserveAdapter("anzen-usdz") ?? undefined }).valid).toBe(true);
  });

  it("withholds the whole redemption block when the multicall cannot be read", async () => {
    primeSupplyMocks();
    primeUsdzRedeemMocks({}, { fail: true });

    const result = await fetchAnzenUsdzReserves(makeCoin(), config, signal);

    expect(result.metadata?.redemption).toBeUndefined();
    expect(result.warnings ?? []).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "anzen-usdz-redeem-route-unreadable" })]),
    );
  });
});
