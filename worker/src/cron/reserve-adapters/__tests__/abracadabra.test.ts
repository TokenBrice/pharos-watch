import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchOnchainUint256: vi.fn(),
    fetchDefiLlamaPrices: vi.fn(),
  };
});

import { adaptAbracadabraReserves, fetchAbracadabraReserves } from "../abracadabra";
import type { CauldronCollateralReading } from "../abracadabra";
import { fetchDefiLlamaPrices, fetchOnchainUint256 } from "../helpers";

const signal = AbortSignal.timeout(5_000);
const coin = { id: "mim-abracadabra" } as StablecoinMeta;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("adaptAbracadabraReserves", () => {
  it("produces percentage slices from multi-cauldron readings", () => {
    const readings: CauldronCollateralReading[] = [
      {
        cauldron: {
          address: "0xAAA",
          collateralSymbol: "yvDAI",
          collateralAddress: "0x1111",
          collateralDecimals: 18,
          risk: "high",
        },
        collateralShareRaw: 500_000_000_000_000_000_000n, // 500 tokens
      },
      {
        cauldron: {
          address: "0xBBB",
          collateralSymbol: "wstETH",
          collateralAddress: "0x2222",
          collateralDecimals: 18,
          risk: "low",
        },
        collateralShareRaw: 1_000_000_000_000_000_000n, // 1 token
      },
    ];

    const priceMap = new Map([
      ["0x1111", 1.0],   // yvDAI ~= $1
      ["0x2222", 2500],  // wstETH ~= $2500
    ]);

    const result = adaptAbracadabraReserves(readings, priceMap);

    expect(result.slices).toHaveLength(2);
    const sum = Math.round(result.slices.reduce((s, r) => s + r.pct, 0) * 10) / 10;
    expect(sum).toBe(100);

    // wstETH = $2500, yvDAI = $500 => wstETH ~83.3%, yvDAI ~16.7%
    const wstSlice = result.slices.find((s) => s.name === "wstETH");
    const yvSlice = result.slices.find((s) => s.name === "yvDAI");
    expect(wstSlice).toBeDefined();
    expect(yvSlice).toBeDefined();
    expect(wstSlice!.pct).toBeCloseTo(83.3, 0);
    expect(wstSlice!.risk).toBe("low");
    expect(yvSlice!.pct).toBeCloseTo(16.7, 0);
    expect(yvSlice!.risk).toBe("high");

    expect(result.metadata).toMatchObject({
      cauldronCount: 2,
      activeCauldronCount: 2,
      freshnessMode: "not-applicable",
      details: {
        proofKind: "abracadabra-cauldron-collateral",
      },
    });
  });

  it("skips cauldrons with zero collateral", () => {
    const readings: CauldronCollateralReading[] = [
      {
        cauldron: {
          address: "0xAAA",
          collateralSymbol: "yvDAI",
          collateralAddress: "0x1111",
          collateralDecimals: 18,
          risk: "high",
        },
        collateralShareRaw: 0n,
      },
      {
        cauldron: {
          address: "0xBBB",
          collateralSymbol: "wstETH",
          collateralAddress: "0x2222",
          collateralDecimals: 18,
          risk: "low",
        },
        collateralShareRaw: 5_000_000_000_000_000_000n,
      },
    ];

    const priceMap = new Map([
      ["0x2222", 2000],
    ]);

    const result = adaptAbracadabraReserves(readings, priceMap);

    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].name).toBe("wstETH");
    expect(result.slices[0].pct).toBe(100);
    expect(result.metadata).toMatchObject({
      cauldronCount: 2,
      activeCauldronCount: 1,
    });
  });

  it("returns empty slices when all cauldrons have zero collateral", () => {
    const readings: CauldronCollateralReading[] = [
      {
        cauldron: {
          address: "0xAAA",
          collateralSymbol: "yvDAI",
          collateralAddress: "0x1111",
          collateralDecimals: 18,
          risk: "high",
        },
        collateralShareRaw: 0n,
      },
    ];

    const result = adaptAbracadabraReserves(readings, new Map());

    expect(result.slices).toEqual([]);
    expect(result.metadata).toMatchObject({
      cauldronCount: 1,
      activeCauldronCount: 0,
    });
  });

  it("throws when a non-zero cauldron has no price", () => {
    const readings: CauldronCollateralReading[] = [
      {
        cauldron: {
          address: "0xAAA",
          collateralSymbol: "yvDAI",
          collateralAddress: "0x1111",
          collateralDecimals: 18,
          risk: "high",
        },
        collateralShareRaw: 1_000_000_000_000_000_000n,
      },
    ];

    expect(() =>
      adaptAbracadabraReserves(readings, new Map()),
    ).toThrow("missing DefiLlama price for yvDAI");
  });

  it("propagates optional coinId and depType to slices", () => {
    const readings: CauldronCollateralReading[] = [
      {
        cauldron: {
          address: "0xAAA",
          collateralSymbol: "yvUSDC",
          collateralAddress: "0x3333",
          collateralDecimals: 6,
          risk: "high",
          coinId: "usdc-circle",
          depType: "wrapper",
        },
        collateralShareRaw: 1_000_000n, // 1 USDC worth
      },
    ];

    const priceMap = new Map([["0x3333", 1.0]]);
    const result = adaptAbracadabraReserves(readings, priceMap);

    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].coinId).toBe("usdc-circle");
    expect(result.slices[0].depType).toBe("wrapper");
  });
});

describe("fetchAbracadabraReserves", () => {
  it("reads totalCollateralShare from each cauldron and computes slices", async () => {
    vi.mocked(fetchOnchainUint256)
      .mockResolvedValueOnce(100_000_000_000_000_000_000n) // 100 yvDAI
      .mockResolvedValueOnce(2_000_000_000_000_000_000n);  // 2 wstETH

    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(
      new Map([
        ["0x1111", 1.0],
        ["0x2222", 2500],
      ]),
    );

    const config: LiveReservesConfig = {
      adapter: "abracadabra",
      version: 1,
      semantics: "collateral-mix",
      inputs: {
        primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      },
      params: {
        cauldrons: [
          {
            address: "0xCauldron1",
            collateralSymbol: "yvDAI",
            collateralAddress: "0x1111",
            collateralDecimals: 18,
            risk: "high",
          },
          {
            address: "0xCauldron2",
            collateralSymbol: "wstETH",
            collateralAddress: "0x2222",
            collateralDecimals: 18,
            risk: "low",
          },
        ],
      },
    };

    const result = await fetchAbracadabraReserves(coin, config, signal);

    expect(result.slices).toHaveLength(2);

    // wstETH = $5000, yvDAI = $100 => wstETH ~98%, yvDAI ~2%
    expect(result.slices[0].name).toBe("wstETH");
    expect(result.slices[0].risk).toBe("low");
    expect(result.slices[1].name).toBe("yvDAI");
    expect(result.slices[1].risk).toBe("high");

    expect(result.metadata).toMatchObject({
      cauldronCount: 2,
      activeCauldronCount: 2,
      freshnessMode: "not-applicable",
    });

    expect(fetchOnchainUint256).toHaveBeenCalledTimes(2);
  });

  it("throws when a cauldron read returns null", async () => {
    vi.mocked(fetchOnchainUint256).mockResolvedValue(null);

    const config: LiveReservesConfig = {
      adapter: "abracadabra",
      version: 1,
      semantics: "collateral-mix",
      inputs: {
        primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      },
      params: {
        cauldrons: [
          {
            address: "0xCauldron1",
            collateralSymbol: "yvDAI",
            collateralAddress: "0x1111",
            collateralDecimals: 18,
            risk: "high",
          },
        ],
      },
    };

    await expect(fetchAbracadabraReserves(coin, config, signal)).rejects.toThrow(
      "could not read totalCollateralShare",
    );
  });

  it("throws on invalid params (empty cauldrons array)", async () => {
    const config: LiveReservesConfig = {
      adapter: "abracadabra",
      version: 1,
      semantics: "collateral-mix",
      inputs: {
        primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      },
      params: { cauldrons: [] },
    };

    await expect(fetchAbracadabraReserves(coin, config, signal)).rejects.toThrow(
      "abracadabra adapter params invalid",
    );
  });
});
