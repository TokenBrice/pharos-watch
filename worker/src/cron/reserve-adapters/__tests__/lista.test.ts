import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchErc20Balance: vi.fn(),
    fetchDefiLlamaPrices: vi.fn(),
  };
});

import { adaptListaReserves, fetchListaReserves } from "../lista";
import { fetchDefiLlamaPrices, fetchErc20Balance } from "../helpers";

import { TEST_SIGNAL as signal } from "./reserve-adapter.test-support";
const coin = { id: "lisusd-lista" } as unknown as StablecoinMeta;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("adaptListaReserves", () => {
  it("computes percentage slices from branch balances and prices", () => {
    const result = adaptListaReserves({
      balances: [
        {
          branch: {
            name: "WBNB",
            holder: "0xAAA",
            token: { chain: "bsc", address: "0xBBB", decimals: 18 },
            risk: "high",
          },
          balanceRaw: 10_000_000_000_000_000_000n, // 10 BNB
        },
        {
          branch: {
            name: "slisBNB (Lista BNB LST)",
            holder: "0xCCC",
            token: { chain: "bsc", address: "0xDDD", decimals: 18 },
            risk: "high",
          },
          balanceRaw: 5_000_000_000_000_000_000n, // 5 slisBNB
        },
        {
          branch: {
            name: "USDT (via PSM)",
            holder: "0xEEE",
            token: { chain: "bsc", address: "0xFFF", decimals: 18 },
            risk: "low",
            coinId: "usdt-tether",
            priceUsd: 1,
          },
          balanceRaw: 2000_000_000_000_000_000_000n, // 2000 USDT
        },
      ],
      priceMap: new Map([
        ["WBNB", 600],
        ["slisBNB (Lista BNB LST)", 620],
      ]),
    });

    expect(result.slices).toHaveLength(3);

    const sum = Math.round(result.slices.reduce((s, r) => s + r.pct, 0) * 10) / 10;
    expect(sum).toBe(100);

    // WBNB = 6000, slisBNB = 3100, USDT = 2000 => total = 11100
    // WBNB = 54.1%, slisBNB = 27.9%, USDT = 18.0%
    expect(result.slices[0].name).toBe("WBNB");
    expect(result.slices[0].risk).toBe("high");
    expect(result.slices[0].pct).toBeCloseTo(54.1, 0);

    expect(result.slices[1].name).toBe("slisBNB (Lista BNB LST)");
    expect(result.slices[1].pct).toBeCloseTo(27.9, 0);

    expect(result.slices[2].name).toBe("USDT (via PSM)");
    expect(result.slices[2].risk).toBe("low");
    expect(result.slices[2].pct).toBeCloseTo(18.0, 0);

    expect(result.metadata).toMatchObject({
      branchCount: 3,
      freshnessMode: "not-applicable",
      details: {
        proofKind: "onchain-branch-balances",
        protocol: "lista-dao",
      },
    });
  });

  it("throws when a branch balance is null", () => {
    expect(() =>
      adaptListaReserves({
        balances: [
          {
            branch: {
              name: "WBNB",
              holder: "0xAAA",
              token: { chain: "bsc", address: "0xBBB", decimals: 18 },
              risk: "high",
            },
            balanceRaw: null,
          },
        ],
        priceMap: new Map(),
      }),
    ).toThrow("could not read balances for: WBNB");
  });

  it("throws when all balances are zero", () => {
    expect(() =>
      adaptListaReserves({
        balances: [
          {
            branch: {
              name: "WBNB",
              holder: "0xAAA",
              token: { chain: "bsc", address: "0xBBB", decimals: 18 },
              risk: "high",
            },
            balanceRaw: 0n,
          },
        ],
        priceMap: new Map(),
      }),
    ).toThrow("no non-zero balances");
  });

  it("filters out zero-balance branches", () => {
    const result = adaptListaReserves({
      balances: [
        {
          branch: {
            name: "WBNB",
            holder: "0xAAA",
            token: { chain: "bsc", address: "0xBBB", decimals: 18 },
            risk: "high",
          },
          balanceRaw: 0n,
        },
        {
          branch: {
            name: "slisBNB",
            holder: "0xCCC",
            token: { chain: "bsc", address: "0xDDD", decimals: 18 },
            risk: "high",
          },
          balanceRaw: 1_000_000_000_000_000_000n,
        },
      ],
      priceMap: new Map([["slisBNB", 620]]),
    });

    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].name).toBe("slisBNB");
    expect(result.slices[0].pct).toBe(100);
  });

  it("uses fixed priceUsd when provided instead of price map", () => {
    const result = adaptListaReserves({
      balances: [
        {
          branch: {
            name: "USDT (via PSM)",
            holder: "0xAAA",
            token: { chain: "bsc", address: "0xBBB", decimals: 18 },
            risk: "low",
            priceUsd: 1,
          },
          balanceRaw: 5000_000_000_000_000_000_000n, // 5000 USDT
        },
      ],
      priceMap: new Map(),
    });

    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].name).toBe("USDT (via PSM)");
    expect(result.slices[0].pct).toBe(100);
  });

  it("propagates coinId and depType to slices", () => {
    const result = adaptListaReserves({
      balances: [
        {
          branch: {
            name: "USDT (via PSM)",
            holder: "0xAAA",
            token: { chain: "bsc", address: "0xBBB", decimals: 18 },
            risk: "low",
            coinId: "usdt-tether",
            depType: "wrapper",
            priceUsd: 1,
          },
          balanceRaw: 1000_000_000_000_000_000_000n,
        },
      ],
      priceMap: new Map(),
    });

    expect(result.slices[0].coinId).toBe("usdt-tether");
    expect(result.slices[0].depType).toBe("wrapper");
  });

  it("throws when DefiLlama price is missing for a branch", () => {
    expect(() =>
      adaptListaReserves({
        balances: [
          {
            branch: {
              name: "WBNB",
              holder: "0xAAA",
              token: { chain: "bsc", address: "0xBBB", decimals: 18 },
              risk: "high",
            },
            balanceRaw: 1_000_000_000_000_000_000n,
          },
        ],
        priceMap: new Map(), // no price for WBNB
      }),
    ).toThrow("Missing DefiLlama price for WBNB");
  });
});

describe("fetchListaReserves", () => {
  it("fetches balances and prices, then delegates to adaptListaReserves", async () => {
    vi.mocked(fetchErc20Balance)
      .mockResolvedValueOnce(10_000_000_000_000_000_000n) // 10 WBNB
      .mockResolvedValueOnce(5_000_000_000_000_000_000n); // 5 slisBNB

    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(
      new Map([
        ["WBNB", 600],
        ["slisBNB", 620],
      ]),
    );

    const config: LiveReservesConfig = {
      adapter: "lista",
      version: 1,
      semantics: "collateral-mix",
      inputs: {
        primary: { kind: "onchain-evm", chain: "bsc", rpcMode: "public-rpc" },
      },
      params: {
        branches: [
          {
            name: "WBNB",
            holder: "0xAAA",
            token: { chain: "bsc", address: "0xBBB", decimals: 18 },
            risk: "high",
          },
          {
            name: "slisBNB",
            holder: "0xCCC",
            token: { chain: "bsc", address: "0xDDD", decimals: 18 },
            risk: "high",
          },
        ],
      },
    };

    const result = await fetchListaReserves(coin, config, signal);
    expect(result.slices).toHaveLength(2);

    const sum = Math.round(result.slices.reduce((s, r) => s + r.pct, 0) * 10) / 10;
    expect(sum).toBe(100);

    // WBNB = 6000 (65.9%), slisBNB = 3100 (34.1%)
    expect(result.slices[0].name).toBe("WBNB");
    expect(result.slices[0].pct).toBeCloseTo(65.9, 0);
    expect(result.slices[1].name).toBe("slisBNB");
    expect(result.slices[1].pct).toBeCloseTo(34.1, 0);
  });

  it("throws when input is not onchain-evm", async () => {
    const config: LiveReservesConfig = {
      adapter: "lista",
      version: 1,
      semantics: "collateral-mix",
      inputs: {
        primary: { kind: "http-json", url: "https://example.com" },
      },
      params: {
        branches: [
          {
            name: "WBNB",
            holder: "0xAAA",
            token: { chain: "bsc", address: "0xBBB", decimals: 18 },
            risk: "high",
          },
        ],
      },
    };

    await expect(fetchListaReserves(coin, config, signal)).rejects.toThrow(
      "lista adapter requires an onchain-evm primary input",
    );
  });

  it("throws when branches are missing", async () => {
    const config: LiveReservesConfig = {
      adapter: "lista",
      version: 1,
      semantics: "collateral-mix",
      inputs: {
        primary: { kind: "onchain-evm", chain: "bsc", rpcMode: "public-rpc" },
      },
      params: {},
    };

    await expect(fetchListaReserves(coin, config, signal)).rejects.toThrow(
      "lista adapter params invalid",
    );
  });
});
