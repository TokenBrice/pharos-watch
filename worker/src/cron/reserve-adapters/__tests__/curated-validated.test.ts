import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    probeTrackedTokenSupply: vi.fn(),
  };
});

vi.mock("@shared/lib/redemption-backstop-configs", () => ({
  REDEMPTION_BACKSTOP_CONFIGS: {
    "coin-with-open-route": { routeStatus: "open" },
    "coin-with-unknown-route": { routeStatus: "unknown" },
    "coin-without-route": {},
  },
}));

import { fetchCuratedValidatedReserves } from "../curated-validated";
import { probeTrackedTokenSupply } from "../helpers";

let signal: AbortSignal;

function makeCoin(
  reserves?: ReserveSlice[],
  contracts?: Array<{ chain: string; address: string }>,
  id = "test-coin",
): StablecoinMeta {
  return { id, name: "Test", ticker: "TST", reserves, contracts } as unknown as StablecoinMeta;
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

const unexpectedProbeRequests: unknown[] = [];
afterEach(() => { expect(unexpectedProbeRequests).toEqual([]); });
beforeEach(() => {
  signal = new AbortController().signal;
  vi.clearAllMocks();
  unexpectedProbeRequests.length = 0;
});

describe("fetchCuratedValidatedReserves", () => {
  it("returns coin.reserves as slices when probe succeeds", async () => {
    vi.mocked(probeTrackedTokenSupply).mockResolvedValue(1000000n);

    const result = await fetchCuratedValidatedReserves(
      makeCoin(MULTI_SLICE_RESERVES, [{ chain: "ethereum", address: "0x1234" }]),
      BASE_CONFIG,
      signal,
    );

    expect(result.slices).toEqual(MULTI_SLICE_RESERVES);
    expect(result.metadata?.totalSupplyRaw).toBe("1000000");
  });

  it("passes scheduled chain RPC context through to the supply probe", async () => {
    vi.mocked(probeTrackedTokenSupply).mockResolvedValue(1000000n);
    const adapterContext = { chainRpcs: new Map() };
    const config: LiveReservesConfig = {
      ...BASE_CONFIG,
      inputs: { primary: { kind: "onchain-solana" } },
    };
    const coin = makeCoin(MULTI_SLICE_RESERVES, [{ chain: "solana", address: "Mint123" }]);

    await fetchCuratedValidatedReserves(coin, config, signal, adapterContext);

    expect(probeTrackedTokenSupply).toHaveBeenCalledWith(
      coin,
      config.inputs.primary,
      signal,
      "curated-validated",
      adapterContext,
      undefined,
      undefined,
    );
  });

  it("preserves coinId and depType from curated reserves", async () => {
    vi.mocked(probeTrackedTokenSupply).mockResolvedValue(500n);

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
    vi.mocked(probeTrackedTokenSupply).mockRejectedValue(
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
    vi.mocked(probeTrackedTokenSupply).mockRejectedValue(
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

  it("supports non-EVM onchain probe paths when the helper resolves supply", async () => {
    vi.mocked(probeTrackedTokenSupply).mockResolvedValue(42n);

    const result = await fetchCuratedValidatedReserves(
      makeCoin(MULTI_SLICE_RESERVES, [{ chain: "solana", address: "Mint1111111111111111111111111111111111" }]),
      {
        ...BASE_CONFIG,
        inputs: {
          primary: { kind: "onchain-solana" },
        },
      },
      signal,
    );

    expect(result.slices).toEqual(MULTI_SLICE_RESERVES);
    expect(result.metadata?.totalSupplyRaw).toBe("42");
  });

  it("derives routeStatus 'open' from the coin's redemption-backstop config", async () => {
    vi.mocked(probeTrackedTokenSupply).mockResolvedValue(1n);
    const result = await fetchCuratedValidatedReserves(
      makeCoin(MULTI_SLICE_RESERVES, [{ chain: "ethereum", address: "0x1234" }], "coin-with-open-route"),
      BASE_CONFIG,
      signal,
    );
    const redemption = result.metadata?.redemption as { routeStatus?: string; routeStatusSource?: string };
    expect(redemption.routeStatus).toBe("open");
    expect(redemption.routeStatusSource).toBe("static-config");
  });

  it("falls back to routeStatus 'unknown' when the coin has no backstop config", async () => {
    vi.mocked(probeTrackedTokenSupply).mockResolvedValue(1n);
    const result = await fetchCuratedValidatedReserves(
      makeCoin(MULTI_SLICE_RESERVES, [{ chain: "ethereum", address: "0x1234" }], "coin-unmapped"),
      BASE_CONFIG,
      signal,
    );
    const redemption = result.metadata?.redemption as { routeStatus?: string };
    expect(redemption.routeStatus).toBe("unknown");
  });

  it("falls back to routeStatus 'unknown' when the backstop config does not specify one", async () => {
    vi.mocked(probeTrackedTokenSupply).mockResolvedValue(1n);
    const result = await fetchCuratedValidatedReserves(
      makeCoin(MULTI_SLICE_RESERVES, [{ chain: "ethereum", address: "0x1234" }], "coin-without-route"),
      BASE_CONFIG,
      signal,
    );
    const redemption = result.metadata?.redemption as { routeStatus?: string };
    expect(redemption.routeStatus).toBe("unknown");
  });

  it("never opens an on-chain call for a coin without redemptionCapacity params", async () => {
    vi.mocked(probeTrackedTokenSupply).mockResolvedValue(1n);
    const result = await fetchCuratedValidatedReserves(
      makeCoin(MULTI_SLICE_RESERVES, [{ chain: "ethereum", address: "0x1234" }], "coin-with-open-route"),
      BASE_CONFIG,
      signal,
    );
    expect(result.metadata?.redemption).toMatchObject({
      capacityKind: "documented-eventual",
      routeStatusSource: "static-config",
    });
    expect(result.metadata?.redemption).not.toHaveProperty("capacityUsd");
  });
});
