import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { mockD1 } from "../../../test-helpers/__shared/mock-d1";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  const fetchOnchainUint256 = vi.fn();
  return {
    ...actual,
    fetchErc20Balance: vi.fn(),
    fetchDefiLlamaPrices: vi.fn(),
    fetchOnchainUint256,
    makeOnchainCallers: vi.fn((input, options) => ({
      uint256: (contract: string, data: string) =>
        fetchOnchainUint256({
          ...options,
          contract,
          data,
          rpcMode: input.rpcMode,
          chain: input.chain,
        }),
      raw: vi.fn(),
    })),
    probeOptionalRedemptionRateBps: vi.fn(),
  };
});

import { fetchEvmBranchBalancesReserves } from "../evm-branch-balances";
import {
  fetchDefiLlamaPrices,
  fetchErc20Balance,
  fetchOnchainUint256,
  probeOptionalRedemptionRateBps,
} from "../helpers";

const signal = AbortSignal.timeout(5000);
const coin = { id: "test-coin" } as unknown as StablecoinMeta;

function wstEthBranch(overrides: Record<string, unknown> = {}) {
  return {
    name: "wstETH",
    holder: "0xAAA",
    token: { chain: "ethereum", address: "0xBBB", decimals: 18 },
    risk: "low",
    ...overrides,
  };
}

function wbtcBranch(overrides: Record<string, unknown> = {}) {
  return {
    name: "WBTC",
    holder: "0xCCC",
    token: { chain: "ethereum", address: "0xDDD", decimals: 8 },
    risk: "medium",
    ...overrides,
  };
}

function makeBranchConfig(
  branches: unknown[],
  options: { chain?: string; params?: Record<string, unknown> } = {},
): LiveReservesConfig {
  const chain = options.chain ?? "ethereum";
  return {
    adapter: "evm-branch-balances",
    version: 1,
    semantics: "collateral-mix",
    inputs: {
      primary: { kind: "onchain-evm", chain, rpcMode: "public-rpc" },
    },
    params: {
      branches,
      ...options.params,
    },
  } as LiveReservesConfig;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchEvmBranchBalancesReserves", () => {
  it("computes percentage slices from branch balances and prices", async () => {
    vi.mocked(fetchErc20Balance)
      .mockResolvedValueOnce(1_000_000_000_000_000_000n) // 1 wstETH (18 dec)
      .mockResolvedValueOnce(100_000_000n); // 1 WBTC (8 dec)

    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(
      new Map([
        ["wstETH", 2000],
        ["WBTC", 60000],
      ]),
    );

    const config = makeBranchConfig([wstEthBranch(), wbtcBranch()]);

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);
    expect(result.slices).toHaveLength(2);

    const sum = Math.round(result.slices.reduce((s, r) => s + r.pct, 0) * 10) / 10;
    expect(sum).toBe(100);

    expect(result.slices[0].name).toBe("WBTC");
    expect(result.slices[0].risk).toBe("medium");
    expect(result.slices[1].name).toBe("wstETH");
    expect(result.slices[1].risk).toBe("low");

    // WBTC value = 60000 (96.8%), wstETH = 2000 (3.2%)
    expect(result.slices[0].pct).toBeCloseTo(96.8, 0);
    expect(result.slices[1].pct).toBeCloseTo(3.2, 0);

    expect(result.metadata).toMatchObject({
      branchCount: 2,
      freshnessMode: "not-applicable",
      details: {
        proofKind: "onchain-branch-balances",
      },
    });
  });

  it("uses an explicit branch price token for DefiLlama price lookup", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValue(1_000_000_000_000_000_000n);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["Receipt token", 75_000]]));

    const config = makeBranchConfig(
      [
        {
          name: "Receipt token",
          holder: "0xAAA",
          token: { chain: "berachain", address: "0xWRAPPER", decimals: 18 },
          priceToken: { chain: "berachain", address: "0xUNDERLYING" },
          risk: "high",
        },
      ],
      { chain: "berachain" },
    );

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);

    expect(result.slices).toEqual([{ name: "Receipt token", pct: 100, risk: "high" }]);
    expect(fetchDefiLlamaPrices).toHaveBeenCalledWith(
      [
        {
          key: "Receipt token",
          chain: "berachain",
          address: "0xUNDERLYING",
        },
      ],
      signal,
      undefined,
    );
  });

  it("includes live redemption fee metadata when a probe is configured", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValue(1_000_000_000_000_000_000n);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["wstETH", 2000]]));
    vi.mocked(probeOptionalRedemptionRateBps).mockResolvedValue(50);

    const config = makeBranchConfig([wstEthBranch()], {
      params: {
        redemptionRateProbe: {
          contract: "0xf949982b91c8c61e952b3ba942cbbfaef5386684",
          selector: "0xc52861f2",
        },
      },
    });

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);
    expect(result.metadata).toMatchObject({
      branchCount: 1,
      freshnessMode: "not-applicable",
      redemptionFeeBps: 50,
      details: {
        proofKind: "onchain-branch-balances",
      },
    });
  });

  it("fails when any branch balance cannot be read", async () => {
    vi.mocked(fetchErc20Balance)
      .mockResolvedValueOnce(null) // first branch returns null
      .mockResolvedValueOnce(500_000_000n); // 5 WBTC (8 dec)

    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["WBTC", 60000]]));

    const config = makeBranchConfig([wstEthBranch(), wbtcBranch()]);

    await expect(fetchEvmBranchBalancesReserves(coin, config, signal)).rejects.toThrow(
      "could not read balances for: wstETH",
    );
  });

  it("filters out branches with zero balances", async () => {
    vi.mocked(fetchErc20Balance)
      .mockResolvedValueOnce(0n) // zero balance
      .mockResolvedValueOnce(100_000_000n); // 1 WBTC (8 dec)

    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["WBTC", 60000]]));

    const config = makeBranchConfig([wstEthBranch(), wbtcBranch()]);

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].name).toBe("WBTC");
    expect(result.slices[0].pct).toBe(100);
  });

  it("throws when all balances are zero", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValue(0n);

    const config = makeBranchConfig([wstEthBranch()]);

    await expect(fetchEvmBranchBalancesReserves(coin, config, signal)).rejects.toThrow("no non-zero balances");
  });

  it("throws when all balances are null", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValue(null);

    const config = makeBranchConfig([wstEthBranch()]);

    await expect(fetchEvmBranchBalancesReserves(coin, config, signal)).rejects.toThrow(
      "could not read balances for: wstETH",
    );
  });

  it("propagates optional coinId and depType to slices", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValue(1_000_000_000_000_000_000n);

    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["wstETH", 2000]]));

    const config: LiveReservesConfig = {
      adapter: "evm-branch-balances",
      version: 1,
      semantics: "collateral-mix",
      inputs: {
        primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      },
      params: {
        branches: [
          {
            name: "wstETH",
            holder: "0xAAA",
            token: { chain: "ethereum", address: "0xBBB", decimals: 18 },
            risk: "low",
            coinId: "wsteth",
            depType: "wrapper",
          },
        ],
      },
    };

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].coinId).toBe("wsteth");
    expect(result.slices[0].depType).toBe("wrapper");
  });

  it("uses fixed price overrides for branches without DefiLlama pricing", async () => {
    vi.mocked(fetchErc20Balance)
      .mockResolvedValueOnce(1_000_000n) // 1 USYC (6 dec)
      .mockResolvedValueOnce(2_000_000_000_000_000_000n); // 2 wrapper tokens (18 dec)

    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["USYC", 1.12]]));

    const config: LiveReservesConfig = {
      adapter: "evm-branch-balances",
      version: 1,
      semantics: "collateral-mix",
      inputs: {
        primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      },
      params: {
        branches: [
          {
            name: "USYC",
            holder: "0xAAA",
            token: { chain: "ethereum", address: "0xBBB", decimals: 6 },
            risk: "low",
          },
          {
            name: "Wrapped stable",
            holder: "0xCCC",
            token: { chain: "ethereum", address: "0xDDD", decimals: 18 },
            risk: "low",
            priceUsd: 1,
          },
        ],
      },
    };

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);
    expect(result.slices).toEqual([
      { name: "Wrapped stable", pct: 64.1, risk: "low" },
      { name: "USYC", pct: 35.9, risk: "low" },
    ]);
    expect(fetchDefiLlamaPrices).toHaveBeenCalledWith(
      [
        {
          key: "USYC",
          chain: "ethereum",
          address: "0xBBB",
        },
      ],
      signal,
      undefined,
    );
  });

  it("falls through to the underlying coin price when the wrapper address lookup is missing", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValue(50_000_000n);
    // First DefiLlama call (wrapper) returns empty; second call (underlying
    // usdc-circle contract) returns a live price near peg.
    vi.mocked(fetchDefiLlamaPrices)
      .mockResolvedValueOnce(new Map())
      .mockResolvedValueOnce(new Map([["USDC branch", 1.0]]));

    const config: LiveReservesConfig = {
      adapter: "evm-branch-balances",
      version: 1,
      semantics: "collateral-mix",
      inputs: {
        primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      },
      params: {
        branches: [
          {
            name: "USDC branch",
            holder: "0xAAA",
            token: { chain: "ethereum", address: "0xBBB", decimals: 6 },
            risk: "low",
            coinId: "usdc-circle",
          },
        ],
      },
    };

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);
    expect(result.slices).toEqual([{ name: "USDC branch", pct: 100, risk: "low", coinId: "usdc-circle" }]);
    expect(result.warnings).toBeUndefined();
  });

  it("falls back to the stablecoins cache price for tracked branches missing DefiLlama address prices", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValue(1_000_000n);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValueOnce(new Map()).mockResolvedValueOnce(new Map());
    const now = 1_700_000_000;
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["stablecoins"],
        rows: [
          {
            key: "stablecoins",
            value: JSON.stringify({
              peggedAssets: [
                {
                  id: "usyc-hashnote",
                  name: "Hashnote USYC",
                  symbol: "USYC",
                  price: 1.1245,
                },
              ],
            }),
            updated_at: now - 60,
          },
        ],
      },
    ]);

    const config: LiveReservesConfig = {
      adapter: "evm-branch-balances",
      version: 1,
      semantics: "collateral-mix",
      inputs: {
        primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      },
      params: {
        branches: [
          {
            name: "Hashnote USYC",
            holder: "0xAAA",
            token: { chain: "ethereum", address: "0xBBB", decimals: 6 },
            risk: "low",
            coinId: "usyc-hashnote",
          },
        ],
      },
    };

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal, { db, nowSec: now });
    expect(result.slices).toEqual([{ name: "Hashnote USYC", pct: 100, risk: "low", coinId: "usyc-hashnote" }]);
    expect(fetchDefiLlamaPrices).toHaveBeenCalledTimes(2);
  });

  it("emits degraded warning when a USD-pegged wrapper price is outside 5% but within 20% of peg", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValue(50_000_000n);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["USDC branch", 0.9]]));

    const config: LiveReservesConfig = {
      adapter: "evm-branch-balances",
      version: 1,
      semantics: "collateral-mix",
      inputs: {
        primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      },
      params: {
        branches: [
          {
            name: "USDC branch",
            holder: "0xAAA",
            token: { chain: "ethereum", address: "0xBBB", decimals: 6 },
            risk: "low",
            coinId: "usdc-circle",
          },
        ],
      },
    };

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);
    expect(result.warnings).toEqual([expect.objectContaining({ code: "wrapper-depeg-detected", severity: "warning" })]);
  });

  it("does not emit USD peg warnings for explicit wrapper dependencies", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValue(50_000_000_000_000_000_000n);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["sUSDe branch", 1.23]]));

    const config: LiveReservesConfig = {
      adapter: "evm-branch-balances",
      version: 1,
      semantics: "collateral-mix",
      inputs: {
        primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      },
      params: {
        branches: [
          {
            name: "sUSDe branch",
            holder: "0xAAA",
            token: { chain: "ethereum", address: "0xBBB", decimals: 18 },
            risk: "medium",
            coinId: "usde-ethena",
            depType: "wrapper",
          },
        ],
      },
    };

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);
    expect(result.warnings).toBeUndefined();
    expect(result.slices).toEqual([
      {
        name: "sUSDe branch",
        pct: 100,
        risk: "medium",
        coinId: "usde-ethena",
        depType: "wrapper",
      },
    ]);
  });

  it("throws when a USD-pegged wrapper price is outside the 0.5-1.5 fatal band", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValue(50_000_000n);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["USDC branch", 0.4]]));

    const config: LiveReservesConfig = {
      adapter: "evm-branch-balances",
      version: 1,
      semantics: "collateral-mix",
      inputs: {
        primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      },
      params: {
        branches: [
          {
            name: "USDC branch",
            holder: "0xAAA",
            token: { chain: "ethereum", address: "0xBBB", decimals: 6 },
            risk: "low",
            coinId: "usdc-circle",
          },
        ],
      },
    };

    await expect(fetchEvmBranchBalancesReserves(coin, config, signal)).rejects.toThrow(/extreme depeg/);
  });

  it("does not warn when a USD-pegged wrapper trades within 5% of peg", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValue(50_000_000n);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["USDC branch", 1.02]]));

    const config: LiveReservesConfig = {
      adapter: "evm-branch-balances",
      version: 1,
      semantics: "collateral-mix",
      inputs: {
        primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      },
      params: {
        branches: [
          {
            name: "USDC branch",
            holder: "0xAAA",
            token: { chain: "ethereum", address: "0xBBB", decimals: 6 },
            risk: "low",
            coinId: "usdc-circle",
          },
        ],
      },
    };

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);
    expect(result.warnings).toBeUndefined();
  });

  it("throws when params.branches is missing", async () => {
    const config: LiveReservesConfig = {
      adapter: "evm-branch-balances",
      version: 1,
      semantics: "collateral-mix",
      inputs: {
        primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      },
      params: {},
    };

    await expect(fetchEvmBranchBalancesReserves(coin, config, signal)).rejects.toThrow(
      "evm-branch-balances adapter params invalid",
    );
  });

  it("throws when params.branches is empty", async () => {
    const config: LiveReservesConfig = {
      adapter: "evm-branch-balances",
      version: 1,
      semantics: "collateral-mix",
      inputs: {
        primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      },
      params: { branches: [] },
    };

    await expect(fetchEvmBranchBalancesReserves(coin, config, signal)).rejects.toThrow(
      "evm-branch-balances adapter params invalid",
    );
  });

  it("throws on invalid fixed price overrides", async () => {
    const config: LiveReservesConfig = {
      adapter: "evm-branch-balances",
      version: 1,
      semantics: "collateral-mix",
      inputs: {
        primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      },
      params: {
        branches: [
          {
            name: "USYC",
            holder: "0xAAA",
            token: { chain: "ethereum", address: "0xBBB", decimals: 6 },
            risk: "low",
            priceUsd: 0,
          },
        ],
      },
    };

    await expect(fetchEvmBranchBalancesReserves(coin, config, signal)).rejects.toThrow(
      "evm-branch-balances adapter params invalid",
    );
  });

  it("emits collateralizationRatio metadata when a debtSelector is configured", async () => {
    // 1 WBTC at $60k = $60,000 collateral; debt = 50000 USD
    vi.mocked(fetchErc20Balance).mockResolvedValueOnce(100_000_000n);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["WBTC", 60000]]));
    vi.mocked(fetchOnchainUint256).mockResolvedValueOnce(50_000n * 10n ** 18n);

    const config: LiveReservesConfig = {
      adapter: "evm-branch-balances",
      version: 1,
      semantics: "collateral-mix",
      inputs: {
        primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      },
      params: {
        branches: [
          {
            name: "WBTC",
            holder: "0xAAA",
            token: { chain: "ethereum", address: "0xBBB", decimals: 8 },
            risk: "medium",
          },
        ],
        debtSelector: "0x18160ddd", // totalSupply() as example
        debtDecimals: 18,
      },
    };

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);
    expect(result.metadata?.totalDebtUsd).toBe(50000);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(1.2, 2);
    // Healthy ratio → no undercollateralized warning.
    expect(result.warnings?.some((w) => w.code === "undercollateralized") ?? false).toBe(false);
  });

  it("supports the USDN wstETH holder balance plus token supply debt shape", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValueOnce(729_665_660_446_827_366_025n);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["wstETH-backed USDN vault", 2879.58]]));
    vi.mocked(fetchOnchainUint256).mockResolvedValueOnce(1_256_625_428_863_930_548_011_778n);

    const config: LiveReservesConfig = {
      adapter: "evm-branch-balances",
      version: 1,
      semantics: "collateral-mix",
      inputs: {
        primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      },
      params: {
        branches: [
          {
            name: "wstETH-backed USDN vault",
            holder: "0x656cb8c6d154aad29d8771384089be5b5141f01a",
            token: {
              chain: "ethereum",
              address: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
              decimals: 18,
            },
            risk: "medium",
          },
        ],
        debtSelector: "0x18160ddd",
        debtContract: "0xde17a000ba631c5d7c2bd9fb692efea52d90dee2",
        debtDecimals: 18,
      },
    };

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);

    expect(fetchErc20Balance).toHaveBeenCalledWith(
      expect.objectContaining({ chain: "ethereum" }),
      "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
      "0x656cb8c6d154aad29d8771384089be5b5141f01a",
      signal,
      undefined,
      undefined,
      undefined,
    );
    expect(fetchOnchainUint256).toHaveBeenCalledWith(
      expect.objectContaining({
        contract: "0xde17a000ba631c5d7c2bd9fb692efea52d90dee2",
        data: "0x18160ddd",
      }),
    );
    expect(result.slices).toEqual([
      {
        name: "wstETH-backed USDN vault",
        pct: 100,
        risk: "medium",
      },
    ]);
    expect(result.metadata?.totalDebtUsd).toBeCloseTo(1_256_625.43, 2);
    expect(result.metadata?.collateralizationRatio).toBeGreaterThan(1);
    expect(result.warnings?.some((w) => w.code === "undercollateralized") ?? false).toBe(false);
  });

  it("emits an undercollateralized warning when collateralizationRatio < 1.0", async () => {
    // 1 WBTC at $60k = $60,000 collateral; debt = $80,000
    vi.mocked(fetchErc20Balance).mockResolvedValueOnce(100_000_000n);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["WBTC", 60000]]));
    vi.mocked(fetchOnchainUint256).mockResolvedValueOnce(80_000n * 10n ** 18n);

    const config: LiveReservesConfig = {
      adapter: "evm-branch-balances",
      version: 1,
      semantics: "collateral-mix",
      inputs: {
        primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      },
      params: {
        branches: [
          {
            name: "WBTC",
            holder: "0xAAA",
            token: { chain: "ethereum", address: "0xBBB", decimals: 8 },
            risk: "medium",
          },
        ],
        debtSelector: "0x18160ddd",
        debtDecimals: 18,
      },
    };

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(0.75, 2);
    const warning = result.warnings?.find((w) => w.code === "undercollateralized");
    expect(warning).toBeDefined();
    expect(warning?.severity).toBe("warning");
  });

  it("preserves wrapper depeg warnings when debt reconciliation also warns", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValueOnce(100_000_000n);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["USDC branch", 0.9]]));
    vi.mocked(fetchOnchainUint256).mockResolvedValueOnce(100n * 10n ** 18n);

    const config: LiveReservesConfig = {
      adapter: "evm-branch-balances",
      version: 1,
      semantics: "collateral-mix",
      inputs: {
        primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      },
      params: {
        branches: [
          {
            name: "USDC branch",
            holder: "0xAAA",
            token: { chain: "ethereum", address: "0xBBB", decimals: 6 },
            risk: "low",
            coinId: "usdc-circle",
          },
        ],
        debtSelector: "0x18160ddd",
        debtDecimals: 18,
      },
    };

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);
    expect(result.warnings?.map((warning) => warning.code)).toEqual(["wrapper-depeg-detected", "undercollateralized"]);
  });

  it("skips debt reconciliation when debtSelector is omitted", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValueOnce(1_000_000_000_000_000_000n);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["wstETH", 2000]]));

    const config: LiveReservesConfig = {
      adapter: "evm-branch-balances",
      version: 1,
      semantics: "collateral-mix",
      inputs: {
        primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      },
      params: {
        branches: [
          {
            name: "wstETH",
            holder: "0xAAA",
            token: { chain: "ethereum", address: "0xBBB", decimals: 18 },
            risk: "low",
          },
        ],
      },
    };

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);
    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.metadata?.totalDebtUsd).toBeUndefined();
    // No debt call should have been made.
    expect(fetchOnchainUint256).not.toHaveBeenCalled();
  });
});
