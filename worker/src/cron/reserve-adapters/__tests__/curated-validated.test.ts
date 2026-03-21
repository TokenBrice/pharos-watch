import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchErc20TotalSupply: vi.fn(),
  };
});

import { fetchCuratedValidatedReserves } from "../curated-validated";
import { fetchErc20TotalSupply } from "../helpers";

const signal = AbortSignal.timeout(5000);

function makeCoin(
  reserves?: ReserveSlice[],
  contracts?: Array<{ chain: string; address: string }>,
): StablecoinMeta {
  return { id: "test-coin", name: "Test", ticker: "TST", reserves, contracts } as unknown as StablecoinMeta;
}

const BASE_CONFIG: LiveReservesConfig = {
  adapter: "curated-validated",
  version: 1,
  semantics: "collateral-mix",
  inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } },
};

const MULTI_SLICE_RESERVES: ReserveSlice[] = [
  { name: "U.S. Treasury bills", pct: 60, risk: "very-low" },
  { name: "Cash deposits", pct: 25, risk: "very-low" },
  { name: "USDC", pct: 15, risk: "low", coinId: "usdc-circle", depType: "wrapper" },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchCuratedValidatedReserves", () => {
  it("returns coin.reserves as slices when totalSupply > 0", async () => {
    vi.mocked(fetchErc20TotalSupply).mockResolvedValue(1000000n);

    const result = await fetchCuratedValidatedReserves(
      makeCoin(MULTI_SLICE_RESERVES, [{ chain: "ethereum", address: "0x1234" }]),
      BASE_CONFIG,
      signal,
    );

    expect(result.slices).toEqual(MULTI_SLICE_RESERVES);
    expect(result.metadata?.totalSupplyRaw).toBe("1000000");
  });

  it("preserves coinId and depType from curated reserves", async () => {
    vi.mocked(fetchErc20TotalSupply).mockResolvedValue(500n);

    const result = await fetchCuratedValidatedReserves(
      makeCoin(MULTI_SLICE_RESERVES, [{ chain: "ethereum", address: "0xABCD" }]),
      BASE_CONFIG,
      signal,
    );

    const usdcSlice = result.slices.find((s) => s.name === "USDC");
    expect(usdcSlice?.coinId).toBe("usdc-circle");
    expect(usdcSlice?.depType).toBe("wrapper");
  });

  it("throws when coin.reserves is empty", async () => {
    await expect(
      fetchCuratedValidatedReserves(
        makeCoin([], [{ chain: "ethereum", address: "0x1234" }]),
        BASE_CONFIG,
        signal,
      ),
    ).rejects.toThrow("coin.reserves to be defined and non-empty");
  });

  it("throws when coin.reserves is undefined", async () => {
    await expect(
      fetchCuratedValidatedReserves(
        makeCoin(undefined, [{ chain: "ethereum", address: "0x1234" }]),
        BASE_CONFIG,
        signal,
      ),
    ).rejects.toThrow("coin.reserves to be defined and non-empty");
  });

  it("throws when totalSupply is null", async () => {
    vi.mocked(fetchErc20TotalSupply).mockResolvedValue(null);

    await expect(
      fetchCuratedValidatedReserves(
        makeCoin(MULTI_SLICE_RESERVES, [{ chain: "ethereum", address: "0x1234" }]),
        BASE_CONFIG,
        signal,
      ),
    ).rejects.toThrow("totalSupply probe failed");
  });

  it("throws when totalSupply is zero", async () => {
    vi.mocked(fetchErc20TotalSupply).mockResolvedValue(0n);

    await expect(
      fetchCuratedValidatedReserves(
        makeCoin(MULTI_SLICE_RESERVES, [{ chain: "ethereum", address: "0x1234" }]),
        BASE_CONFIG,
        signal,
      ),
    ).rejects.toThrow("totalSupply probe failed");
  });

  it("throws when no contract matches the chain", async () => {
    await expect(
      fetchCuratedValidatedReserves(
        makeCoin(MULTI_SLICE_RESERVES, [{ chain: "arbitrum", address: "0xABCD" }]),
        BASE_CONFIG,
        signal,
      ),
    ).rejects.toThrow("could not find a ethereum contract");
  });

  it("throws when coin has no contracts", async () => {
    await expect(
      fetchCuratedValidatedReserves(
        makeCoin(MULTI_SLICE_RESERVES),
        BASE_CONFIG,
        signal,
      ),
    ).rejects.toThrow("could not find a ethereum contract");
  });
});
