import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  const fetchOnchainUint256 = vi.fn();
  return {
    ...actual,
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
    fetchDefiLlamaPrices: vi.fn(),
  };
});

import { adaptAbracadabraReserves, fetchAbracadabraReserves } from "../abracadabra";
import type { CauldronCollateralReading } from "../abracadabra";
import { fetchDefiLlamaPrices, fetchOnchainUint256 } from "../helpers";

const signal = AbortSignal.timeout(5_000);
const coin = { id: "mim-abracadabra" } as StablecoinMeta;
const BENTOBOX = "0xd96f48665a1410c0cd669a88898eca36b9fc2cce";
const YVDAI_ADDRESS = "0x1111111111111111111111111111111111111111";
const WSTETH_ADDRESS = "0x2222222222222222222222222222222222222222";
const YVUSDC_ADDRESS = "0x3333333333333333333333333333333333333333";

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
          collateralAddress: YVDAI_ADDRESS,
          collateralDecimals: 18,
          risk: "high",
        },
        collateralAmountRaw: 500_000_000_000_000_000_000n,
      },
      {
        cauldron: {
          address: "0xBBB",
          collateralSymbol: "wstETH",
          collateralAddress: WSTETH_ADDRESS,
          collateralDecimals: 18,
          risk: "low",
        },
        collateralAmountRaw: 1_000_000_000_000_000_000n,
      },
    ];

    const priceMap = new Map([
      [YVDAI_ADDRESS, 1.0],
      [WSTETH_ADDRESS, 2500],
    ]);

    const result = adaptAbracadabraReserves(readings, priceMap);

    expect(result.slices).toHaveLength(2);
    const sum = Math.round(result.slices.reduce((s, r) => s + r.pct, 0) * 10) / 10;
    expect(sum).toBe(100);

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
          collateralAddress: YVDAI_ADDRESS,
          collateralDecimals: 18,
          risk: "high",
        },
        collateralAmountRaw: 0n,
      },
      {
        cauldron: {
          address: "0xBBB",
          collateralSymbol: "wstETH",
          collateralAddress: WSTETH_ADDRESS,
          collateralDecimals: 18,
          risk: "low",
        },
        collateralAmountRaw: 5_000_000_000_000_000_000n,
      },
    ];

    const priceMap = new Map([[WSTETH_ADDRESS, 2000]]);
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
          collateralAddress: YVDAI_ADDRESS,
          collateralDecimals: 18,
          risk: "high",
        },
        collateralAmountRaw: 0n,
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
          collateralAddress: YVDAI_ADDRESS,
          collateralDecimals: 18,
          risk: "high",
        },
        collateralAmountRaw: 1_000_000_000_000_000_000n,
      },
    ];

    expect(() => adaptAbracadabraReserves(readings, new Map())).toThrow(
      "missing DefiLlama price for yvDAI",
    );
  });

  it("propagates optional coinId and depType to slices", () => {
    const readings: CauldronCollateralReading[] = [
      {
        cauldron: {
          address: "0xAAA",
          collateralSymbol: "yvUSDC",
          collateralAddress: YVUSDC_ADDRESS,
          collateralDecimals: 6,
          risk: "high",
          coinId: "usdc-circle",
          depType: "wrapper",
        },
        collateralAmountRaw: 1_000_000n,
      },
    ];

    const priceMap = new Map([[YVUSDC_ADDRESS, 1.0]]);
    const result = adaptAbracadabraReserves(readings, priceMap);

    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].coinId).toBe("usdc-circle");
    expect(result.slices[0].depType).toBe("wrapper");
  });
});

describe("fetchAbracadabraReserves", () => {
  it("reads totalCollateralShare and converts share to amount via BentoBox.toAmount", async () => {
    vi.mocked(fetchOnchainUint256)
      .mockResolvedValueOnce(100_000_000_000_000_000_000n)
      .mockResolvedValueOnce(2_000_000_000_000_000_000n)
      .mockResolvedValueOnce(110_000_000_000_000_000_000n)
      .mockResolvedValueOnce(2_100_000_000_000_000_000n);

    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(
      new Map([
        [YVDAI_ADDRESS, 1.0],
        [WSTETH_ADDRESS, 2500],
      ]),
    );

    const config: LiveReservesConfig = {
      adapter: "abracadabra",
      version: 1,
      semantics: "collateral-mix",
      inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } },
      params: {
        bentoBoxAddress: BENTOBOX,
        cauldrons: [
          { address: "0xCauldron1", collateralSymbol: "yvDAI", collateralAddress: YVDAI_ADDRESS, collateralDecimals: 18, risk: "high" },
          { address: "0xCauldron2", collateralSymbol: "wstETH", collateralAddress: WSTETH_ADDRESS, collateralDecimals: 18, risk: "low" },
        ],
      },
    };

    const result = await fetchAbracadabraReserves(coin, config, signal);
    expect(result.slices).toHaveLength(2);
    expect(result.slices[0].name).toBe("wstETH");
    expect(result.slices[1].name).toBe("yvDAI");
    expect(fetchOnchainUint256).toHaveBeenCalledTimes(4);
  });

  it("skips BentoBox.toAmount when share is zero", async () => {
    vi.mocked(fetchOnchainUint256)
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(2_000_000_000_000_000_000n)
      .mockResolvedValueOnce(2_100_000_000_000_000_000n);

    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([[WSTETH_ADDRESS, 2500]]));

    const config: LiveReservesConfig = {
      adapter: "abracadabra",
      version: 1,
      semantics: "collateral-mix",
      inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } },
      params: {
        bentoBoxAddress: BENTOBOX,
        cauldrons: [
          { address: "0xCauldron1", collateralSymbol: "yvDAI", collateralAddress: YVDAI_ADDRESS, collateralDecimals: 18, risk: "high" },
          { address: "0xCauldron2", collateralSymbol: "wstETH", collateralAddress: WSTETH_ADDRESS, collateralDecimals: 18, risk: "low" },
        ],
      },
    };

    const result = await fetchAbracadabraReserves(coin, config, signal);
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].name).toBe("wstETH");
    expect(fetchOnchainUint256).toHaveBeenCalledTimes(3);
  });

  it("throws when a cauldron share read returns null", async () => {
    vi.mocked(fetchOnchainUint256).mockResolvedValue(null);
    const config: LiveReservesConfig = {
      adapter: "abracadabra",
      version: 1,
      semantics: "collateral-mix",
      inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } },
      params: {
        bentoBoxAddress: BENTOBOX,
        cauldrons: [
          { address: "0xCauldron1", collateralSymbol: "yvDAI", collateralAddress: YVDAI_ADDRESS, collateralDecimals: 18, risk: "high" },
        ],
      },
    };
    await expect(fetchAbracadabraReserves(coin, config, signal)).rejects.toThrow(
      "could not read totalCollateralShare",
    );
  });

  it("throws when BentoBox.toAmount returns null", async () => {
    vi.mocked(fetchOnchainUint256)
      .mockResolvedValueOnce(100_000_000_000_000_000_000n)
      .mockResolvedValueOnce(null);
    const config: LiveReservesConfig = {
      adapter: "abracadabra",
      version: 1,
      semantics: "collateral-mix",
      inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } },
      params: {
        bentoBoxAddress: BENTOBOX,
        cauldrons: [
          { address: "0xCauldron1", collateralSymbol: "yvDAI", collateralAddress: YVDAI_ADDRESS, collateralDecimals: 18, risk: "high" },
        ],
      },
    };
    await expect(fetchAbracadabraReserves(coin, config, signal)).rejects.toThrow(
      "could not convert share to amount",
    );
  });

  it("caches BentoBox.toAmount calls for identical (token, share) tuples", async () => {
    const share = 100_000_000_000_000_000_000n;
    vi.mocked(fetchOnchainUint256)
      .mockResolvedValueOnce(share)
      .mockResolvedValueOnce(share)
      .mockResolvedValueOnce(110_000_000_000_000_000_000n);

    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([[YVDAI_ADDRESS, 1.0]]));

    const config: LiveReservesConfig = {
      adapter: "abracadabra",
      version: 1,
      semantics: "collateral-mix",
      inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } },
      params: {
        bentoBoxAddress: BENTOBOX,
        cauldrons: [
          { address: "0xCauldronA", collateralSymbol: "yvDAI", collateralAddress: YVDAI_ADDRESS, collateralDecimals: 18, risk: "high" },
          { address: "0xCauldronB", collateralSymbol: "yvDAI", collateralAddress: YVDAI_ADDRESS, collateralDecimals: 18, risk: "high" },
        ],
      },
    };

    const cache = new Map<string, Promise<unknown>>();
    await fetchAbracadabraReserves(coin, config, signal, { requestCache: cache });
    expect(fetchOnchainUint256).toHaveBeenCalledTimes(3);
  });

  it("throws on invalid params (empty cauldrons array)", async () => {
    const config: LiveReservesConfig = {
      adapter: "abracadabra",
      version: 1,
      semantics: "collateral-mix",
      inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } },
      params: { bentoBoxAddress: BENTOBOX, cauldrons: [] },
    };
    await expect(fetchAbracadabraReserves(coin, config, signal)).rejects.toThrow(
      "abracadabra adapter params invalid",
    );
  });

  it("throws on invalid params (missing bentoBoxAddress)", async () => {
    const config: LiveReservesConfig = {
      adapter: "abracadabra",
      version: 1,
      semantics: "collateral-mix",
      inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } },
      params: {
        cauldrons: [
          { address: "0xCauldron1", collateralSymbol: "yvDAI", collateralAddress: YVDAI_ADDRESS, collateralDecimals: 18, risk: "high" },
        ],
      } as never,
    };
    await expect(fetchAbracadabraReserves(coin, config, signal)).rejects.toThrow(
      "abracadabra adapter params invalid",
    );
  });
});
