import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchEscrowBalanceReserves } from "../escrow-balance";
import { fetchOnchainRawCall, fetchOnchainUint256 } from "../helpers";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  const { makeOnchainCallersMock } = await import("./helpers/onchain-callers-mock");
  const fetchOnchainUint256 = vi.fn();
  const fetchOnchainRawCall = vi.fn();
  return {
    ...actual,
    fetchOnchainRawCall,
    fetchOnchainUint256,
    makeOnchainCallers: makeOnchainCallersMock({
      uint256: fetchOnchainUint256,
      raw: fetchOnchainRawCall,
    }),
  };
});

const XRESERVE = "0x8888888199b2Df864bf678259607d6D5EBb4e3Ce";
const USDC_WORD = "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const MOVEMENT_DOMAIN_WORD = "0x0000000000000000000000000000000000000000000000000000000000002715";
const PARALLELIZER = "0x6efeDDF9269c3683Ba516cb0e2124FE335F262a2";
const PARALLEL_USDP = "0x9B3a8f7CEC208e247d97dEE13313690977e24459";
const FRXUSD_WORD = "0x000000000000000000000000cacd6fd266af91b8aed52accc382b4e165586e29";

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

const multiReadConfig: LiveReservesConfig = {
  adapter: "escrow-balance",
  version: 1,
  semantics: "single-asset",
  inputs: {
    primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
  },
  params: {
    reads: [
      {
        contract: PARALLELIZER,
        selector: "0x94e35d9e",
        args: [FRXUSD_WORD],
        decimals: 6,
        identityCheck: {
          selector: "0x1978a5ed",
          expectedAddress: PARALLEL_USDP,
        },
      },
      {
        contract: "0xCAcd6fd266aF91b8AeD52aCCc382b4e165586E29",
        erc20BalanceOf: PARALLELIZER,
        decimals: 18,
      },
    ],
    pauseCheck: {
      contract: PARALLELIZER,
      selector: "0x0d126627",
      args: [
        FRXUSD_WORD,
        "0x0000000000000000000000000000000000000000000000000000000000000002",
      ],
    },
    slice: {
      name: "Parallelizer redemption capacity",
      risk: "medium",
    },
    sourceUrls: ["https://docs.parallel.best/"],
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

  it("sums bounded selector and ERC-20 balance reads after checking identity", async () => {
    vi.mocked(fetchOnchainUint256)
      .mockResolvedValueOnce(BigInt(PARALLEL_USDP))
      .mockResolvedValueOnce(2_000_000_000_000_000_000n)
      .mockResolvedValueOnce(0n);
    vi.mocked(fetchOnchainRawCall).mockResolvedValueOnce(
      `0x${1_250_000n.toString(16).padStart(64, "0")}${4_000_000n.toString(16).padStart(64, "0")}`,
    );

    const result = await fetchEscrowBalanceReserves(
      { id: "usdp-parallel", symbol: "USDp" } as StablecoinMeta,
      multiReadConfig,
      new AbortController().signal,
    );

    expect(vi.mocked(fetchOnchainUint256).mock.calls.map(([call]) => call.data)).toEqual([
      "0x1978a5ed",
      `0x70a08231${PARALLELIZER.slice(2).toLowerCase().padStart(64, "0")}`,
      `0x0d126627${FRXUSD_WORD.slice(2)}0000000000000000000000000000000000000000000000000000000000000002`,
    ]);
    expect(vi.mocked(fetchOnchainRawCall)).toHaveBeenCalledWith(expect.objectContaining({
      contract: PARALLELIZER,
      data: `0x94e35d9e${FRXUSD_WORD.slice(2)}`,
    }));
    expect(result.metadata).toMatchObject({
      contractAddresses: [
        PARALLELIZER,
        "0xCAcd6fd266aF91b8AeD52aCCc382b4e165586E29",
      ],
      escrowBalanceReadCount: 2,
      escrowBalancesRaw: ["1250000", "2000000000000000000"],
      escrowBalanceUsd: 3.25,
      immediateRedeemableUsd: 3.25,
      redemption: {
        capacityUsd: 3.25,
        capacityKind: "live-direct",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusSource: "onchain",
        routeStatusReason: expect.stringContaining("positive sum"),
      },
    });
  });

  it("withholds the whole multi-read observation when one capacity read fails", async () => {
    vi.mocked(fetchOnchainUint256)
      .mockResolvedValueOnce(BigInt(PARALLEL_USDP))
      .mockResolvedValueOnce(null);
    vi.mocked(fetchOnchainRawCall).mockResolvedValueOnce(
      `0x${1_250_000n.toString(16).padStart(64, "0")}${4_000_000n.toString(16).padStart(64, "0")}`,
    );

    await expect(
      fetchEscrowBalanceReserves(
        { id: "usdp-parallel", symbol: "USDp" } as StablecoinMeta,
        multiReadConfig,
        new AbortController().signal,
      ),
    ).rejects.toThrow("capacity read 2 failed");
  });

  it("rejects multi-read configs above the bounded item cap", async () => {
    const params = multiReadConfig.params as Record<string, unknown>;
    const reads = params.reads as unknown[];
    const overCapConfig: LiveReservesConfig = {
      ...multiReadConfig,
      params: {
        ...params,
        reads: Array.from({ length: 17 }, () => reads[0]),
      },
    };

    await expect(
      fetchEscrowBalanceReserves(
        { id: "usdp-parallel", symbol: "USDp" } as StablecoinMeta,
        overCapConfig,
        new AbortController().signal,
      ),
    ).rejects.toThrow("adapter params invalid");
    expect(vi.mocked(fetchOnchainUint256)).not.toHaveBeenCalled();
    expect(vi.mocked(fetchOnchainRawCall)).not.toHaveBeenCalled();
  });
});
