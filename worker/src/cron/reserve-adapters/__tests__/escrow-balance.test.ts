import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { describe, expect, it } from "vitest";
import { fetchEscrowBalanceReserves } from "../escrow-balance";
import { installAdapterNetwork } from "./reserve-adapter.test-support";

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

const escrowCall = `0xc47cf5ef${USDC_WORD.slice(2)}${MOVEMENT_DOMAIN_WORD.slice(2)}`;
const pauseCall = "0x5c975abb";
const multiSelectorCall = `0x94e35d9e${FRXUSD_WORD.slice(2)}`;
const multiBalanceCall = `0x70a08231${PARALLELIZER.slice(2).toLowerCase().padStart(64, "0")}`;
const multiPauseCall = `0x0d126627${FRXUSD_WORD.slice(2)}0000000000000000000000000000000000000000000000000000000000000002`;

function escrowNetwork(options: {
  balance?: bigint | null;
  paused?: bigint | null;
  identity?: bigint | null;
  selectorBalance?: string | null;
  tokenBalance?: bigint | null;
  pauseCheck?: bigint | null;
} = {}) {
  const network = installAdapterNetwork({
    chains: { ethereum: "https://rpc.example" },
    rpc: {
      [`${XRESERVE}:${escrowCall}`]: options.balance === undefined ? 1_791_066_499_458n : options.balance,
      [`${XRESERVE}:${pauseCall}`]: options.paused === undefined ? 0n : options.paused,
      [`${PARALLELIZER}:0x1978a5ed`]: options.identity === undefined ? BigInt(PARALLEL_USDP) : options.identity,
      [`${PARALLELIZER}:${multiSelectorCall}`]: options.selectorBalance === undefined
        ? `0x${1_250_000n.toString(16).padStart(64, "0")}${4_000_000n.toString(16).padStart(64, "0")}`
        : options.selectorBalance,
      [`${"0xCAcd6fd266aF91b8AeD52aCCc382b4e165586E29"}:${multiBalanceCall}`]:
        options.tokenBalance === undefined ? 2_000_000_000_000_000_000n : options.tokenBalance,
      [`${PARALLELIZER}:${multiPauseCall}`]: options.pauseCheck === undefined ? 0n : options.pauseCheck,
    },
  });
  return network;
}

async function runEscrow(
  testCoin: StablecoinMeta,
  testConfig: LiveReservesConfig,
  options: Parameters<typeof escrowNetwork>[0] = {},
) {
  const network = escrowNetwork(options);
  const result = await fetchEscrowBalanceReserves(
    testCoin,
    testConfig,
    new AbortController().signal,
    { chainRpcs: network.chainRpcs },
  );
  return { result, network };
}


describe("fetchEscrowBalanceReserves", () => {
  it("emits the escrowed slice and same-run direct capacity from one pinned view call", async () => {
    const { result, network } = await runEscrow(coin, config);

    expect(network.rpcCalls[0]).toMatchObject({
      chain: "ethereum",
      contract: XRESERVE.toLowerCase(),
      data: escrowCall,
    });
    expect(result.slices).toEqual([
      {
        sourceKey: "escrow-balance:0x8888888199b2df864bf678259607d6d5ebb4e3ce",
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
    const { result } = await runEscrow(coin, config, { paused: 1n });
    expect(result.metadata?.redemption).toMatchObject({ routeStatus: "paused" });
  });

  it("skips the pause call when no pause selector is configured", async () => {
    const { pausedSelector: _pausedSelector, ...params } = config.params as Record<string, unknown>;
    const { result, network } = await runEscrow(coin, { ...config, params });

    expect(network.rpcCalls).toHaveLength(1);
    expect(result.metadata?.redemption).toMatchObject({ routeStatus: "open" });
  });

  it("throws when the escrow read fails", async () => {
    await expect(runEscrow(coin, config, { balance: null })).rejects.toThrow("escrow balance call failed");
  });

  it("throws instead of publishing an empty escrow as zero capacity", async () => {
    await expect(runEscrow(coin, config, { balance: 0n })).rejects.toThrow("escrow balance is zero");
  });

  it("throws when the pause read fails rather than assuming an open route", async () => {
    await expect(runEscrow(coin, config, { paused: null })).rejects.toThrow("pause check failed");
  });

  it("sums bounded selector and ERC-20 balance reads after checking identity", async () => {
    const { result, network } = await runEscrow(
      { id: "usdp-parallel", symbol: "USDp" } as StablecoinMeta,
      multiReadConfig,
    );

    expect(network.rpcCalls.map((call) => call.data)).toEqual([
      "0x1978a5ed",
      multiSelectorCall,
      multiBalanceCall,
      multiPauseCall,
    ]);
    expect(result.metadata).toMatchObject({
      contractAddresses: [
        PARALLELIZER,
        "0xCAcd6fd266aF91b8AeD52aCCc382b4e165586E29",
      ],
      escrowBalanceReadCount: 2,
      escrowBalancesRaw: ["1250000", "2000000000000000000"],
      escrowBalanceUsd: 3.25,
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
    await expect(runEscrow(
      { id: "usdp-parallel", symbol: "USDp" } as StablecoinMeta,
      multiReadConfig,
      { tokenBalance: null },
    )).rejects.toThrow("capacity read 2 failed");
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
    const network = escrowNetwork();

    await expect(fetchEscrowBalanceReserves(
      { id: "usdp-parallel", symbol: "USDp" } as StablecoinMeta,
      overCapConfig,
      new AbortController().signal,
      { chainRpcs: network.chainRpcs },
    )).rejects.toThrow("adapter params invalid");
    expect(network.rpcCalls).toHaveLength(0);
  });
});
