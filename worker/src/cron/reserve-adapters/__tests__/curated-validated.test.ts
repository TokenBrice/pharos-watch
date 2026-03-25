import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    probeOnchainTotalSupply: vi.fn(),
  };
});

import { fetchCuratedValidatedReserves } from "../curated-validated";
import { probeOnchainTotalSupply } from "../helpers";

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
  it("returns coin.reserves as slices when probe succeeds", async () => {
    vi.mocked(probeOnchainTotalSupply).mockResolvedValue(1000000n);

    const result = await fetchCuratedValidatedReserves(
      makeCoin(MULTI_SLICE_RESERVES, [{ chain: "ethereum", address: "0x1234" }]),
      BASE_CONFIG,
      signal,
    );

    expect(result.slices).toEqual(MULTI_SLICE_RESERVES);
    expect(result.metadata?.totalSupplyRaw).toBe("1000000");
  });

  it("preserves coinId and depType from curated reserves", async () => {
    vi.mocked(probeOnchainTotalSupply).mockResolvedValue(500n);

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

  it("throws when on-chain probe fails", async () => {
    vi.mocked(probeOnchainTotalSupply).mockRejectedValue(
      new Error("curated-validated totalSupply probe failed for test-coin"),
    );

    await expect(
      fetchCuratedValidatedReserves(
        makeCoin(MULTI_SLICE_RESERVES, [{ chain: "ethereum", address: "0x1234" }]),
        BASE_CONFIG,
        signal,
      ),
    ).rejects.toThrow("totalSupply probe failed");
  });

  it("throws when probe cannot find contract", async () => {
    vi.mocked(probeOnchainTotalSupply).mockRejectedValue(
      new Error("curated-validated could not find a ethereum contract for test-coin"),
    );

    await expect(
      fetchCuratedValidatedReserves(
        makeCoin(MULTI_SLICE_RESERVES, [{ chain: "arbitrum", address: "0xABCD" }]),
        BASE_CONFIG,
        signal,
      ),
    ).rejects.toThrow("could not find a ethereum contract");
  });
});
