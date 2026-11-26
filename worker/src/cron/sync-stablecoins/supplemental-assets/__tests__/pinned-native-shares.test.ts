import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import { JLTXX_ETHEREUM_CONTRACT, JLTXX_SOLANA_MINT, JLTXX_SOLANA_TOKEN_PROGRAM } from "@shared/types/reserve-nav-supply";
import type * as EvmRpc from "../../../../lib/evm-rpc";
import type * as ChainObservation from "../../../../lib/chain-observation";
import { SOLANA_TOKEN_PROGRAM } from "../../../../lib/solana-observation";

const { header, uint256, solanaAccounts } = vi.hoisted(() => ({
  header: vi.fn(), uint256: vi.fn(), solanaAccounts: vi.fn<typeof ChainObservation.fetchSolanaAccounts>(),
}));
vi.mock("../../../../lib/evm-rpc", async (o) => ({ ...(await o<typeof EvmRpc>()), fetchEvmBlockHeader: header, fetchEvmUint256AtBlock: uint256 }));
vi.mock("../../../../lib/chain-observation", async (o) => ({ ...(await o<typeof ChainObservation>()), fetchSolanaAccounts: solanaAccounts }));
import { fetchPinnedNativeShares as fetchShares } from "../onchain-supply";
import { DECIMALS_SELECTOR, TOTAL_SUPPLY_SELECTOR } from "../../../../lib/evm-selectors";

const ethC = { chain: "ethereum", address: JLTXX_ETHEREUM_CONTRACT, decimals: 2 };
const solC = { chain: "solana", address: JLTXX_SOLANA_MINT, decimals: 2 };
const coin: StablecoinMeta = {
  id: "jltxx-jpmorgan", symbol: "JLTXX", name: "JLTXX",
  flags: { backing: "rwa-backed", governance: "centralized", pegCurrency: "USD", yieldBearing: true, rwa: true, navToken: true },
  contracts: [ethC],
};
const twoLeg: StablecoinMeta = { ...coin, contracts: [ethC, solC] };
const now = () => Math.floor(Date.now() / 1000);
const ethBlock = () => ({ number: 100, hash: `0x${"a".repeat(64)}`, timestamp: now() - 900 });
const solSlot = 460_000_000;
const setEth = (s: bigint | null, d: bigint | null = 2n) => uint256.mockReset().mockResolvedValueOnce(s).mockResolvedValueOnce(d);

function mintBytes(supply: bigint, decimals = 2, init = true, tlv?: [number, number]): Uint8Array {
  const data = new Uint8Array(tlv ? 170 + tlv[1] : 82);
  const v = new DataView(data.buffer);
  v.setBigUint64(36, supply, true);
  data[44] = decimals;
  data[45] = init ? 1 : 0;
  if (tlv) {
    data[165] = 1;
    v.setUint16(166, tlv[0], true);
    v.setUint16(168, tlv[1], true);
    if (tlv[0] === 25) { v.setFloat64(202, 1, true); v.setBigInt64(210, 0n, true); v.setFloat64(218, 1, true); }
  }
  return data;
}

function solCensus(o: { supply?: bigint; decimals?: number; init?: boolean; owner?: string; exec?: boolean; missing?: boolean; slot?: number; ts?: number; tlv?: [number, number] } = {}) {
  const data = mintBytes(o.supply ?? 65_000_000_000n, o.decimals ?? 2, o.init ?? true, o.tlv);
  const acct = o.missing ? null : { owner: o.owner ?? JLTXX_SOLANA_TOKEN_PROGRAM, data, ...(o.exec ? { executable: true } : {}) };
  return { accounts: new Map([[JLTXX_SOLANA_MINT, acct]]), observedBlock: { chain: "solana", number: o.slot ?? solSlot, timestamp: o.ts ?? now() - 600 } };
}

describe("JLTXX native-share observation", () => {
  let block: ReturnType<typeof ethBlock>;
  let solTime: number;

  beforeEach(() => {
    block = ethBlock();
    solTime = now() - 600;
    header.mockReset().mockResolvedValue(block);
    setEth(62_671_284_229n);
    solanaAccounts.mockReset().mockResolvedValue(solCensus({ ts: solTime }));
  });

  it("retains the 1-leg Ethereum raw getter, actual decimals and canonical hash/time", async () => {
    expect(await fetchShares(coin)).toEqual({
      rawShares: "62671284229", decimals: 2, observedAt: block.timestamp,
      legs: [{ chain: "ethereum", contractAddress: JLTXX_ETHEREUM_CONTRACT, rawShares: "62671284229", decimals: 2, blockNumber: 100, blockHash: block.hash, observedAt: block.timestamp }],
    });
    expect(header).toHaveBeenNthCalledWith(1, "ethereum", "finalized", expect.any(Object));
    expect(header).toHaveBeenNthCalledWith(2, "ethereum", 100, expect.any(Object));
    expect(solanaAccounts).not.toHaveBeenCalled();
    for (const sel of [TOTAL_SUPPLY_SELECTOR, DECIMALS_SELECTOR]) {
      expect(uint256).toHaveBeenCalledWith("ethereum", JLTXX_ETHEREUM_CONTRACT, sel, 100, expect.objectContaining({ stateBlockHash: block.hash }));
    }
  });

  it.each([[ethC, solC], [solC, ethC]])("combines finalized Ethereum and Solana Token-2022 legs", async (...contracts) => {
    const older = block.timestamp - 120;
    setEth(5_000_000_000n);
    solanaAccounts.mockReset().mockResolvedValue(solCensus({ supply: 65_000_000_000n, ts: older, tlv: [18, 64] }));
    expect(await fetchShares({ ...twoLeg, contracts })).toEqual({
      rawShares: "70000000000", decimals: 2, observedAt: older,
      legs: [
        { chain: "ethereum", contractAddress: JLTXX_ETHEREUM_CONTRACT, rawShares: "5000000000", decimals: 2, blockNumber: 100, blockHash: block.hash, observedAt: block.timestamp },
        { chain: "solana", contractAddress: JLTXX_SOLANA_MINT, rawShares: "65000000000", decimals: 2, slot: solSlot, programOwner: JLTXX_SOLANA_TOKEN_PROGRAM, observedAt: older },
      ],
    });
    expect(solanaAccounts).toHaveBeenCalledWith([JLTXX_SOLANA_MINT], expect.any(AbortSignal), { chainRpcs: undefined });
  });

  it.each([[0n, 2n], [null, 2n], [100n, 18n], [100n, null]] as const)("rejects bad Ethereum supply/decimals (%s, %s)", async (raw, dec) => {
    setEth(raw, dec);
    expect(await fetchShares(coin)).toBeNull();
  });

  it.each([
    { supply: 0n }, { decimals: 6 }, { owner: SOLANA_TOKEN_PROGRAM }, { owner: "11111111111111111111111111111111" },
    { exec: true }, { missing: true }, { init: false }, { tlv: [25, 56] as [number, number] },
    { tlv: [10, 52] as [number, number] }, { tlv: [24, 32] as [number, number] },
    { slot: 0 }, { ts: 0 }, { ts: now() + 3600 }, { ts: 1 },
  ])("rejects invalid Solana Token-2022 state/extension/clock #%#", async (ov) => {
    solanaAccounts.mockReset().mockResolvedValue(solCensus({ ts: solTime, ...ov }));
    expect(await fetchShares(twoLeg)).toBeNull();
  });

  it("rejects Ethereum reorg and bad block clocks", async () => {
    header.mockReset().mockResolvedValueOnce(block).mockResolvedValueOnce({ ...block, hash: `0x${"b".repeat(64)}` });
    expect(await fetchShares(coin)).toBeNull();
    for (const v of [null, { ...block, timestamp: 0 }, { ...block, timestamp: now() + 3600 }, { ...block, timestamp: 1 }]) {
      header.mockReset().mockResolvedValue(v);
      uint256.mockReset();
      solanaAccounts.mockReset();
      expect(await fetchShares(twoLeg)).toBeNull();
      expect(uint256).not.toHaveBeenCalled();
      expect(solanaAccounts).not.toHaveBeenCalled();
    }
  });

  it.each(["header", "supply", "decimals", "closing", "solana"] as const)("withholds on %s RPC error", async (stage) => {
    const err = new Error("RPC unavailable");
    if (stage === "header") header.mockReset().mockRejectedValue(err);
    if (stage === "closing") header.mockReset().mockResolvedValueOnce(block).mockRejectedValueOnce(err);
    if (stage === "supply") uint256.mockReset().mockRejectedValue(err);
    if (stage === "decimals") uint256.mockReset().mockResolvedValueOnce(62_671_284_229n).mockRejectedValueOnce(err);
    if (stage === "solana") solanaAccounts.mockReset().mockRejectedValue(err);
    await expect(fetchShares(stage === "solana" ? twoLeg : coin)).resolves.toBeNull();
    expect(header).toHaveBeenCalledTimes(stage === "closing" || stage === "solana" ? 2 : 1);
    expect(uint256).toHaveBeenCalledTimes(stage === "header" ? 0 : stage === "supply" ? 1 : 2);
    expect(solanaAccounts).toHaveBeenCalledTimes(stage === "solana" ? 1 : 0);
  });

  it("propagates caller abort during Ethereum or Solana failure", async () => {
    const c1 = new AbortController(); const r1 = new Error("eth abort");
    uint256.mockReset().mockImplementation(async () => { c1.abort(r1); throw new Error("closed"); });
    await expect(fetchShares(coin, undefined, c1.signal)).rejects.toBe(r1);
    expect(header).toHaveBeenCalledTimes(1);
    expect(uint256).toHaveBeenCalledTimes(1);

    header.mockReset().mockResolvedValue(block);
    setEth(5_000_000_000n);
    const c2 = new AbortController(); const r2 = new Error("sol abort");
    solanaAccounts.mockReset().mockImplementation(async () => { c2.abort(r2); throw new Error("closed"); });
    await expect(fetchShares(twoLeg, undefined, c2.signal)).rejects.toBe(r2);
    expect(solanaAccounts).toHaveBeenCalledTimes(1);
  });

  it("rejects extra/duplicate/unknown deployments before making requests", async () => {
    for (const c of [
      { ...coin, id: "other" }, { ...coin, symbol: "OTHER" }, { ...coin, contracts: [] },
      { ...coin, contracts: [ethC, ethC] }, { ...coin, contracts: [solC, solC] }, { ...coin, contracts: [solC] },
      { ...coin, contracts: [ethC, solC, { chain: "base", address: `0x${"c".repeat(40)}`, decimals: 2 }] },
      { ...coin, contracts: [{ ...ethC, address: `0x${"b".repeat(40)}` }] }, { ...coin, contracts: [{ ...ethC, decimals: 18 }] },
      { ...coin, contracts: [ethC, { ...solC, address: JLTXX_SOLANA_MINT.toLowerCase() }] },
      { ...coin, contracts: [ethC, { ...solC, decimals: 6 }] },
    ]) expect(await fetchShares(c)).toBeNull();
    expect(header).not.toHaveBeenCalled();
    expect(solanaAccounts).not.toHaveBeenCalled();
  });
});
