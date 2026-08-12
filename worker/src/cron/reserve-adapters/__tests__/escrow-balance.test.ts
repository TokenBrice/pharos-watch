import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchEscrowBalanceReserves } from "../escrow-balance";
import { fetchOnchainUint256 } from "../helpers";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  const fetchOnchainUint256 = vi.fn();
  return {
    ...actual,
    fetchOnchainUint256,
    makeOnchainCallers: vi.fn((
      input: { chain?: string; rpcMode?: unknown },
      options: { signal: AbortSignal; ctx?: unknown; rpcUrl?: string; fallbackRpcUrl?: string },
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
        }),
      raw: vi.fn(),
    })),
  };
});

const XRESERVE = "0x8888888199b2Df864bf678259607d6D5EBb4e3Ce";
const USDC_WORD = "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const MOVEMENT_DOMAIN_WORD = "0x0000000000000000000000000000000000000000000000000000000000002715";

const coin = { id: "usdcx-movement", symbol: "USDCx" } as StablecoinMeta;

const config: LiveReservesConfig = {
  adapter: "escrow-balance",
  version: 1,
  semantics: "single-asset",
  inputs: {
    primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
  },
  params: {
    contract: XRESERVE,
    selector: "0xc47cf5ef",
    args: [USDC_WORD, MOVEMENT_DOMAIN_WORD],
    decimals: 6,
    pausedSelector: "0x5c975abb",
    slice: {
      name: "USDC held as Circle xReserve native collateral for the Movement domain",
      risk: "very-low",
      coinId: "usdc-circle",
      depType: "wrapper",
    },
    sourceUrls: ["https://developers.circle.com/xreserve/concepts/technical-guide"],
    holderEligibility: "any-holder",
    settlementDelaySec: 0,
  },
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("fetchEscrowBalanceReserves", () => {
  it("emits the escrowed slice and same-run direct capacity from one pinned view call", async () => {
    vi.mocked(fetchOnchainUint256)
      .mockResolvedValueOnce(1_791_066_499_458n)
      .mockResolvedValueOnce(0n);

    const result = await fetchEscrowBalanceReserves(coin, config, new AbortController().signal);

    expect(vi.mocked(fetchOnchainUint256).mock.calls[0]?.[0]).toMatchObject({
      chain: "ethereum",
      contract: XRESERVE,
      data: `0xc47cf5ef${USDC_WORD.slice(2)}${MOVEMENT_DOMAIN_WORD.slice(2)}`,
    });
    expect(result.slices).toEqual([
      {
        name: "USDC held as Circle xReserve native collateral for the Movement domain",
        pct: 100,
        risk: "very-low",
        coinId: "usdc-circle",
        depType: "wrapper",
      },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      chain: "ethereum",
      contractAddress: XRESERVE,
      escrowBalanceRaw: "1791066499458",
      escrowBalanceUsd: 1_791_066.499458,
      redemption: {
        capacityUsd: 1_791_066.499458,
        capacityKind: "live-direct",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusSource: "onchain",
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
      },
    });
  });

  it("marks the route paused when the pause view reports true", async () => {
    vi.mocked(fetchOnchainUint256)
      .mockResolvedValueOnce(1_791_066_499_458n)
      .mockResolvedValueOnce(1n);

    const result = await fetchEscrowBalanceReserves(coin, config, new AbortController().signal);

    expect(result.metadata?.redemption).toMatchObject({ routeStatus: "paused" });
  });

  it("skips the pause call when no pause selector is configured", async () => {
    const { pausedSelector: _pausedSelector, ...params } = config.params as Record<string, unknown>;
    vi.mocked(fetchOnchainUint256).mockResolvedValueOnce(1_791_066_499_458n);

    const result = await fetchEscrowBalanceReserves(coin, { ...config, params }, new AbortController().signal);

    expect(vi.mocked(fetchOnchainUint256)).toHaveBeenCalledTimes(1);
    expect(result.metadata?.redemption).toMatchObject({ routeStatus: "open" });
  });

  it("throws when the escrow read fails", async () => {
    vi.mocked(fetchOnchainUint256).mockResolvedValueOnce(null);

    await expect(
      fetchEscrowBalanceReserves(coin, config, new AbortController().signal),
    ).rejects.toThrow("escrow balance call failed");
  });

  it("throws instead of publishing an empty escrow as zero capacity", async () => {
    vi.mocked(fetchOnchainUint256).mockResolvedValueOnce(0n);

    await expect(
      fetchEscrowBalanceReserves(coin, config, new AbortController().signal),
    ).rejects.toThrow("escrow balance is zero");
  });

  it("throws when the pause read fails rather than assuming an open route", async () => {
    vi.mocked(fetchOnchainUint256)
      .mockResolvedValueOnce(1_791_066_499_458n)
      .mockResolvedValueOnce(null);

    await expect(
      fetchEscrowBalanceReserves(coin, config, new AbortController().signal),
    ).rejects.toThrow("pause check failed");
  });
});
