import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchOnchainLogs } from "../onchain";
import { fetchEvmRpcBatchDetailed } from "../../../lib/evm-rpc";
import { buildChainRpcs } from "../../../lib/chain-registry";
import type * as EvmRpcModule from "../../../lib/evm-rpc";

vi.mock("../../../lib/evm-rpc", async (original) => ({
  ...await original<typeof EvmRpcModule>(), fetchEvmRpcBatchDetailed: vi.fn(),
}));

const options = { chain: "gnosis", contract: "0x0000000000000000000000000000000000000001", topics: [],
  fromBlock: 1, toBlock: 20_001, signal: new AbortController().signal };

describe("reserve log span bounds", () => {
  beforeEach(() => vi.mocked(fetchEvmRpcBatchDetailed).mockReset());
  it("preserves incumbent Alchemy caller windows without admitted Dwellir logs", async () => {
    vi.mocked(fetchEvmRpcBatchDetailed).mockResolvedValue({ results: [[]], errors: [] });
    const chainRpcs = buildChainRpcs("test-alchemy");
    expect(await fetchOnchainLogs({ ...options, chain: "base", toBlock: 500_000, ctx: { chainRpcs } }))
      .toMatchObject({ complete: true, calls: 1 });
    expect(vi.mocked(fetchEvmRpcBatchDetailed).mock.calls[0][1][0].params[0])
      .toMatchObject({ fromBlock: "0x1", toBlock: "0x7a120" });
  });
  it("clamps initial ranges to admitted endpoint spans", async () => {
    vi.mocked(fetchEvmRpcBatchDetailed).mockResolvedValue({ results: [[]], errors: [] });
    const chainRpcs = buildChainRpcs(undefined, undefined, { dwellirApiKey: "test" });
    const result = await fetchOnchainLogs({ ...options, ctx: { chainRpcs } });
    expect(result).toMatchObject({ complete: true, calls: 3 });
    expect(vi.mocked(fetchEvmRpcBatchDetailed).mock.calls.map((call) => call[1][0].params[0])).toEqual([
      { address: options.contract, topics: [], fromBlock: "0x1", toBlock: "0x2710" },
      { address: options.contract, topics: [], fromBlock: "0x2711", toBlock: "0x4e20" },
      { address: options.contract, topics: [], fromBlock: "0x4e21", toBlock: "0x4e21" },
    ]);
  });
  it("retries unexecuted members within the existing sequential split budget", async () => {
    vi.mocked(fetchEvmRpcBatchDetailed)
      .mockResolvedValueOnce({ results: [null], errors: [{ index: 0, code: -32000, message: "batch not executed: member 1 (eth_getLogs) violated the log range policy" }] })
      .mockResolvedValue({ results: [[]], errors: [] });
    expect(await fetchOnchainLogs({ ...options, toBlock: 2000 })).toMatchObject({ complete: true, calls: 3 });
  });
  it("withholds all logs when clamped pages exhaust the call budget", async () => {
    vi.mocked(fetchEvmRpcBatchDetailed).mockResolvedValue({ results: [[]], errors: [] });
    const chainRpcs = buildChainRpcs(undefined, undefined, { dwellirApiKey: "test" });
    expect(await fetchOnchainLogs({ ...options, maxCalls: 1, ctx: { chainRpcs } }))
      .toMatchObject({ complete: false, logs: [], calls: 1 });
  });
});
