import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LiveReservesConfig, StablecoinMeta } from "@shared/types";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchErc20Balance: vi.fn(),
    fetchDefiLlamaPrices: vi.fn(),
  };
});

import { fetchEvmBranchBalancesReserves } from "../evm-branch-balances";
import { fetchErc20Balance, fetchDefiLlamaPrices } from "../helpers";

const signal = AbortSignal.timeout(5000);
const coin = { id: "test-coin" } as unknown as StablecoinMeta;

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
          {
            name: "WBTC",
            holder: "0xCCC",
            token: { chain: "ethereum", address: "0xDDD", decimals: 8 },
            risk: "medium",
          },
        ],
      },
    };

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);
    expect(result.slices).toHaveLength(2);

    const sum = Math.round(result.slices.reduce((s, r) => s + r.pct, 0) * 10) / 10;
    expect(sum).toBe(100);

    // slicesFromValues preserves insertion order (no sorting)
    expect(result.slices[0].name).toBe("wstETH");
    expect(result.slices[0].risk).toBe("low");
    expect(result.slices[1].name).toBe("WBTC");
    expect(result.slices[1].risk).toBe("medium");

    // WBTC value = 60000 (96.8%), wstETH = 2000 (3.2%)
    expect(result.slices[0].pct).toBeCloseTo(3.2, 0);
    expect(result.slices[1].pct).toBeCloseTo(96.8, 0);

    expect(result.metadata).toEqual({ branchCount: 2 });
  });

  it("filters out branches with null balances", async () => {
    vi.mocked(fetchErc20Balance)
      .mockResolvedValueOnce(null) // first branch returns null
      .mockResolvedValueOnce(500_000_000n); // 5 WBTC (8 dec)

    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(
      new Map([["WBTC", 60000]]),
    );

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
          {
            name: "WBTC",
            holder: "0xCCC",
            token: { chain: "ethereum", address: "0xDDD", decimals: 8 },
            risk: "medium",
          },
        ],
      },
    };

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].name).toBe("WBTC");
    expect(result.slices[0].pct).toBe(100);
    expect(result.metadata).toEqual({ branchCount: 1 });
  });

  it("filters out branches with zero balances", async () => {
    vi.mocked(fetchErc20Balance)
      .mockResolvedValueOnce(0n) // zero balance
      .mockResolvedValueOnce(100_000_000n); // 1 WBTC (8 dec)

    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(
      new Map([["WBTC", 60000]]),
    );

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
          {
            name: "WBTC",
            holder: "0xCCC",
            token: { chain: "ethereum", address: "0xDDD", decimals: 8 },
            risk: "medium",
          },
        ],
      },
    };

    const result = await fetchEvmBranchBalancesReserves(coin, config, signal);
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].name).toBe("WBTC");
    expect(result.slices[0].pct).toBe(100);
  });

  it("throws when all balances are zero", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValue(0n);

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

    await expect(fetchEvmBranchBalancesReserves(coin, config, signal)).rejects.toThrow(
      "no non-zero balances",
    );
  });

  it("throws when all balances are null", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValue(null);

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

    await expect(fetchEvmBranchBalancesReserves(coin, config, signal)).rejects.toThrow(
      "no non-zero balances",
    );
  });

  it("propagates optional coinId and depType to slices", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValue(1_000_000_000_000_000_000n);

    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(
      new Map([["wstETH", 2000]]),
    );

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

    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(
      new Map([["USYC", 1.12]]),
    );

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
      { name: "USYC", pct: 35.9, risk: "low" },
      { name: "Wrapped stable", pct: 64.1, risk: "low" },
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
    );
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
      "requires params.branches",
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
      "requires params.branches",
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
      "invalid priceUsd",
    );
  });
});
