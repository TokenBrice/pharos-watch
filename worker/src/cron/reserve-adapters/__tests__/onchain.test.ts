import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReserveInput } from "@shared/types/live-reserves";
import { TOTAL_SUPPLY_SELECTOR } from "../../../lib/evm-selectors";
import type { OnchainRateProbe } from "../onchain";

const evmRpcMocks = vi.hoisted(() => ({
  fetchEtherscanUint256AtBlock: vi.fn(),
  fetchEvmUint256AtBlock: vi.fn(),
  fetchEvmRpcBatchDetailed: vi.fn(),
}));

vi.mock("../../../lib/evm-rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/evm-rpc")>();
  return {
    ...actual,
    fetchEtherscanUint256AtBlock: evmRpcMocks.fetchEtherscanUint256AtBlock,
    fetchEvmUint256AtBlock: evmRpcMocks.fetchEvmUint256AtBlock,
    fetchEvmRpcBatchDetailed: evmRpcMocks.fetchEvmRpcBatchDetailed,
  };
});

import { fetchOnchainLogs, fetchOnchainRateBps } from "../onchain";
import { probeOnchainTotalSupply } from "../token-supply";
import { buildChainRpcs } from "../../../lib/chain-registry";

describe("fetchOnchainRateBps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scales an explicitly 18-decimal redemption rate into basis points", async () => {
    evmRpcMocks.fetchEvmUint256AtBlock.mockResolvedValue(5_000_000_394_208_505n);

    await expect(
      fetchOnchainRateBps(
        { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
        {
          contract: "0xA39739EF8b0231DbFA0DcdA07d7e29faAbCf4bb2",
          selector: "0xc52861f2",
          decimals: 18,
        },
        AbortSignal.timeout(5_000),
      ),
    ).resolves.toBe(50);
  });

  it("skips a rate probe when decimals are missing", async () => {
    const probe: OnchainRateProbe = {
      contract: "0x0000000000000000000000000000000000000001",
      selector: "0x12345678",
    };

    await expect(
      fetchOnchainRateBps(
        { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
        probe,
        AbortSignal.timeout(5_000),
      ),
    ).resolves.toBeNull();
    expect(evmRpcMocks.fetchEvmUint256AtBlock).not.toHaveBeenCalled();
    expect(evmRpcMocks.fetchEtherscanUint256AtBlock).not.toHaveBeenCalled();
  });
});

describe("probeOnchainTotalSupply", () => {
  const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
  const coin = {
    id: "test-coin",
    contracts: [{ chain: "ethereum", address: DAI }],
  } as unknown as StablecoinMeta;
  // etherscan-proxy is the only mode with a second read path, so it shows
  // whether the RPC layer treated an answer as delivered or as missing.
  const ethereum: LiveReserveInput = { kind: "onchain-evm", chain: "ethereum", rpcMode: "etherscan-proxy" };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a zero total supply as a delivered but unusable answer", async () => {
    evmRpcMocks.fetchEvmUint256AtBlock.mockResolvedValue(0n);

    await expect(
      probeOnchainTotalSupply(coin, ethereum, new AbortController().signal, "test-adapter"),
    ).rejects.toThrow("test-adapter totalSupply probe failed for test-coin");

    const [chain, contract, data, blockTag] = evmRpcMocks.fetchEvmUint256AtBlock.mock.calls[0] ?? [];
    expect({ chain, contract, data, blockTag }).toEqual({
      chain: "ethereum",
      contract: DAI,
      data: TOTAL_SUPPLY_SELECTOR,
      blockTag: "latest",
    });
    // Zero is an answer, not a gap: the Etherscan fallback is never consulted.
    expect(evmRpcMocks.fetchEtherscanUint256AtBlock).not.toHaveBeenCalled();
  });

  it("escalates a missing RPC answer to the Etherscan fallback and accepts its supply", async () => {
    evmRpcMocks.fetchEvmUint256AtBlock.mockResolvedValue(null);
    evmRpcMocks.fetchEtherscanUint256AtBlock.mockResolvedValue(4_200n);

    await expect(
      probeOnchainTotalSupply(coin, ethereum, new AbortController().signal, "test-adapter"),
    ).resolves.toBe(4_200n);
  });

  it("fails a chain without a tracked deployment before issuing any read", async () => {
    await expect(
      probeOnchainTotalSupply(
        coin,
        { kind: "onchain-evm", chain: "base", rpcMode: "etherscan-proxy" },
        new AbortController().signal,
        "test-adapter",
      ),
    ).rejects.toThrow("test-adapter could not find a base contract for test-coin");

    expect(evmRpcMocks.fetchEvmUint256AtBlock).not.toHaveBeenCalled();
    expect(evmRpcMocks.fetchEtherscanUint256AtBlock).not.toHaveBeenCalled();
  });
});

describe("reserve log span bounds", () => {
  const options = { chain: "gnosis", contract: "0x0000000000000000000000000000000000000001", topics: [],
    fromBlock: 1, toBlock: 20_001, signal: new AbortController().signal };

  beforeEach(() => evmRpcMocks.fetchEvmRpcBatchDetailed.mockReset());

  it("preserves caller windows within the admitted Alchemy span", async () => {
    evmRpcMocks.fetchEvmRpcBatchDetailed.mockResolvedValue({ results: [[]], errors: [] });
    const chainRpcs = buildChainRpcs("test-alchemy");
    expect(await fetchOnchainLogs({ ...options, chain: "arbitrum", toBlock: 500_000, ctx: { chainRpcs } }))
      .toMatchObject({ complete: true, calls: 1 });
    expect(evmRpcMocks.fetchEvmRpcBatchDetailed.mock.calls[0][1][0].params[0])
      .toMatchObject({ fromBlock: "0x1", toBlock: "0x7a120" });
  });
  it("covers the M0 window in contiguous Alchemy pages without Dwellir", async () => {
    evmRpcMocks.fetchEvmRpcBatchDetailed.mockResolvedValue({ results: [[]], errors: [] });
    const chainRpcs = buildChainRpcs("test-alchemy");
    expect(await fetchOnchainLogs({ ...options, chain: "ethereum", toBlock: 18_001, ctx: { chainRpcs } }))
      .toMatchObject({ complete: true, calls: 2 });
    expect(evmRpcMocks.fetchEvmRpcBatchDetailed.mock.calls.map((call) => call[1][0].params[0])).toEqual([
      { address: options.contract, topics: [], fromBlock: "0x1", toBlock: "0x2710" },
      { address: options.contract, topics: [], fromBlock: "0x2711", toBlock: "0x4651" },
    ]);
  });
  it("clamps initial ranges to admitted endpoint spans", async () => {
    evmRpcMocks.fetchEvmRpcBatchDetailed.mockResolvedValue({ results: [[]], errors: [] });
    const chainRpcs = buildChainRpcs(undefined, undefined, { dwellirApiKey: "test" });
    const result = await fetchOnchainLogs({ ...options, ctx: { chainRpcs } });
    expect(result).toMatchObject({ complete: true, calls: 3 });
    expect(evmRpcMocks.fetchEvmRpcBatchDetailed.mock.calls.map((call) => call[1][0].params[0])).toEqual([
      { address: options.contract, topics: [], fromBlock: "0x1", toBlock: "0x2710" },
      { address: options.contract, topics: [], fromBlock: "0x2711", toBlock: "0x4e20" },
      { address: options.contract, topics: [], fromBlock: "0x4e21", toBlock: "0x4e21" },
    ]);
  });
  it("sizes pages for Dwellir rather than a smaller later fallback span", async () => {
    evmRpcMocks.fetchEvmRpcBatchDetailed.mockResolvedValue({ results: [[]], errors: [] });
    const chainRpcs = buildChainRpcs(undefined, undefined, { dwellirApiKey: "test" });
    const configured = chainRpcs.get("gnosis")!;
    chainRpcs.set("gnosis", { ...configured, endpoints: configured.endpoints.map(endpoint =>
      endpoint.operator === "dwellir" ? endpoint : { ...endpoint, maxLogBlockSpan: 1000 }) });
    expect(await fetchOnchainLogs({ ...options, toBlock: 18_001, ctx: { chainRpcs } }))
      .toMatchObject({ complete: true, calls: 2 });
    expect(evmRpcMocks.fetchEvmRpcBatchDetailed.mock.calls.map(call => call[1][0].params[0])).toEqual([
      { address: options.contract, topics: [], fromBlock: "0x1", toBlock: "0x2710" },
      { address: options.contract, topics: [], fromBlock: "0x2711", toBlock: "0x4651" },
    ]);
  });
  it("retries unexecuted members within the existing sequential split budget", async () => {
    evmRpcMocks.fetchEvmRpcBatchDetailed
      .mockResolvedValueOnce({ results: [null], errors: [{ index: 0, code: -32000, message: "batch not executed: member 1 (eth_getLogs) violated the log range policy" }] })
      .mockResolvedValue({ results: [[]], errors: [] });
    expect(await fetchOnchainLogs({ ...options, toBlock: 2000 })).toMatchObject({ complete: true, calls: 3 });
  });
  it.each(["alchemy", "dwellir"] as const)("withholds all logs when %s pages exhaust the call budget", async (provider) => {
    evmRpcMocks.fetchEvmRpcBatchDetailed.mockResolvedValue({ results: [[{
      address: options.contract, topics: [`0x${"a".repeat(64)}`], data: "0x", blockNumber: "0x1",
    }]], errors: [] });
    const chainRpcs = provider === "alchemy"
      ? buildChainRpcs("test-alchemy")
      : buildChainRpcs(undefined, undefined, { dwellirApiKey: "test" });
    expect(await fetchOnchainLogs({ ...options, chain: provider === "alchemy" ? "ethereum" : options.chain,
      maxCalls: 1, ctx: { chainRpcs } }))
      .toMatchObject({ complete: false, logs: [], calls: 1 });
  });
});
