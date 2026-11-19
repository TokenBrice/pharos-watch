import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import * as evmRpc from "../../../../lib/evm-rpc";
import { fetchCuratedAggregateOnChainMcap } from "../onchain-supply";

const readers = vi.hoisted(() => ({
  evm: vi.fn(), solana: vi.fn(), solanaObserved: vi.fn(), stellar: vi.fn(), noble: vi.fn(), sui: vi.fn(), aptos: vi.fn(), starknet: vi.fn(),
}));
vi.mock("../stellar-supply", () => ({ fetchStellarSupply: readers.stellar }));
vi.mock("../noble-supply", () => ({ fetchNobleSupply: readers.noble }));
vi.mock("../usdy-sui-supply", () => ({ fetchUsdySuiSupply: readers.sui }));
vi.mock("../usdy-aptos-supply", () => ({ fetchAptosSupply: readers.aptos }));
vi.mock("../../../reserve-adapters/helpers", () => ({
  fetchErc20TotalSupply: readers.evm, fetchStarknetTotalSupply: readers.starknet,
  probeTrackedTokenSupply: (_meta: unknown, input: { kind: string }) => input.kind === "onchain-solana" ? readers.solana() : readers.evm(input),
}));
vi.mock("../../../../lib/chain-observation", () => ({ fetchSolanaTokenSupply: readers.solana }));
vi.mock("../../../../lib/native-token-supply", () => ({ observeSolanaTokenSupply: readers.solanaObserved }));
beforeEach(() => {
  vi.clearAllMocks();
  for (const [family, reader] of Object.entries(readers)) reader.mockResolvedValue(family === "noble" ? 10n ** 18n : 10n ** 6n);
  const now = Math.floor(Date.now() / 1000);
  vi.spyOn(Date, "now").mockReturnValue(now * 1000);
  readers.aptos.mockResolvedValue({ rawSupply: 10n ** 6n, observedAt: now - 30 });
  readers.solanaObserved.mockResolvedValue({ rawSupply: 10n ** 6n, slot: 101, observedAt: now - 40 });
  vi.spyOn(evmRpc, "fetchEvmBlockNumber").mockResolvedValue(100);
  vi.spyOn(evmRpc, "fetchEvmBlockHeader").mockResolvedValue({ number: 100, hash: `0x${"1".repeat(64)}`, timestamp: now - 20 });
  vi.spyOn(evmRpc, "fetchEvmUint256AtBlock").mockImplementation(async (chain) => readers.evm({ chain }));
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it("keeps Solana supply and finalized slot time on the same RPC", async () => {
  const { observeSolanaTokenSupply } = await vi.importActual<typeof import("../../../../lib/native-token-supply")>("../../../../lib/native-token-supply");
  const post = vi.fn()
    .mockResolvedValueOnce({ result: { context: { slot: 101 }, value: { amount: "100" } } })
    .mockResolvedValueOnce({ result: null })
    .mockResolvedValueOnce({ result: { context: { slot: 102 }, value: { amount: "200" } } })
    .mockResolvedValueOnce({ result: 1_799_999_999 });
  const rpcA = "https://solana-one.example";
  const rpcB = "https://solana-two.example";
  const result = await observeSolanaTokenSupply("mint", new AbortController().signal,
    { jsonRequestExecutor: { get: vi.fn(), post } }, rpcA, rpcB);
  expect(result).toEqual({ rawSupply: 200n, slot: 102, observedAt: 1_799_999_999 });
  expect(post.mock.calls.map(([url, body]) => [url, body.method, body.params])).toEqual([
    [rpcA, "getTokenSupply", ["mint", { commitment: "finalized" }]], [rpcA, "getBlockTime", [101]],
    [rpcB, "getTokenSupply", ["mint", { commitment: "finalized" }]], [rpcB, "getBlockTime", [102]],
  ]);
});

describe.each([["usdy-ondo-finance", 12, 7], ["buidl-blackrock", 10, 8]] as const)("%s native supply dispatch", (id, count, evmCount) => {
  const meta = TRACKED_META_BY_ID.get(id)!;
  beforeEach(() => { readers.evm.mockImplementation(async (input: { chain: string }) =>
    10n ** BigInt(meta.contracts!.find(c => c.chain === input.chain)!.decimals!)); });
  it("sums complete stock with the oldest clock", async () => {

    readers.stellar.mockResolvedValue(10n ** 7n);
    const result = await fetchCuratedAggregateOnChainMcap(meta, 1.2);
    expect(result?.mcap).toBeCloseTo(count * 1.2);
    expect(result?.observedAt).toBe(Math.floor(Date.now() / 1000) - (id === "buidl-blackrock" ? 40 : 30));
    expect(result).toMatchObject({
      chainCirculating: id === "usdy-ondo-finance" ? { Noble: { current: 1.2 }, Stellar: { current: 1.2 } } : { Ethereum: { current: 2.4 } },
    });
    expect(readers.evm).toHaveBeenCalledTimes(evmCount);
    for (const family of ["noble", "stellar", "sui", "aptos", "solana"] as const) expect(readers[family === "solana" && id === "buidl-blackrock" ? "solanaObserved" : family]).toHaveBeenCalledTimes(Number(meta.contracts!.some(c => c.chain === family)));
  });
  it.each((["evm", "solana", "stellar", "noble", "sui", "aptos"] as const).filter(f => f === "evm" || meta.contracts!.some(c => c.chain === f)))("withholds the whole aggregate on an unreadable %s leg", async (family) => {
    const reader = readers[family === "solana" && id === "buidl-blackrock" ? "solanaObserved" : family];
    if (id === "buidl-blackrock") {
      reader.mockResolvedValueOnce(family === "evm" ? 0n : { rawSupply: 0n, observedAt: Math.floor(Date.now() / 1000) });
      expect(await fetchCuratedAggregateOnChainMcap(meta, 1.2)).toBeNull();
    }
    reader.mockRejectedValue(new Error("unreadable"));
    expect(await fetchCuratedAggregateOnChainMcap(meta, 1.2)).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"reason":"supply-probe-failed"'));
  });
  it("propagates cancellation", async () => {
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    await expect(fetchCuratedAggregateOnChainMcap(meta, 1.2, undefined, controller.signal)).rejects.toThrow("cancelled");
    expect(readers.evm).not.toHaveBeenCalled();
  });
});

it.each(["arbitrum", "solana"] as const)("withholds BUIDL when %s serves an otherwise valid stale state", async (chain) => {
  const meta = TRACKED_META_BY_ID.get("buidl-blackrock")!;
  const now = Math.floor(Date.now() / 1000);
  if (chain === "arbitrum") {
    vi.mocked(evmRpc.fetchEvmBlockHeader).mockImplementation(async (network) => ({
      number: 100, hash: `0x${"1".repeat(64)}`, timestamp: now - (network === chain ? 301 : 30),
    }));
  } else {
    readers.solanaObserved.mockResolvedValue({ rawSupply: 10n ** 6n, slot: 101, observedAt: now - 301 });
  }
  await expect(fetchCuratedAggregateOnChainMcap(meta, 1.2)).resolves.toBeNull();
});
