import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { MINT_BURN_CONFIGS } from "../mint-burn-contracts";
import { fetchEvmRpcBatchDetailed } from "../evm-rpc";
import { auditMintBurnConservation, getMintBurnConservationEligibility, mintBurnConservationCacheKey,
  persistMintBurnConservation, readMintBurnConservationRecords, validateMintBurnParsedConservation, verifyPersistedMintBurnConservation } from "../mint-burn-conservation";
import type { AlchemyLogEntry } from "../alchemy-logs";
import type { MintBurnRow } from "../mint-burn-pipeline/types";
vi.mock("../evm-rpc", () => ({ fetchEvmRpcBatchDetailed: vi.fn() }));
const config = MINT_BURN_CONFIGS.find((item) => item.stablecoinId === "gusd-gemini")!;
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
const headers = [{ number: "0x64", timestamp: "0x3e8", hash: word(10n) },
  { number: "0x66", timestamp: "0x400", hash: word(12n) }];
const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());
beforeEach(() => vi.resetAllMocks());
function log(direction: "mint" | "burn", amount: bigint, index = 0): AlchemyLogEntry {
  return { address: config.contractAddress, topics: [config.events[0].topicHash,
    direction === "mint" ? word(0n) : word(1n), direction === "burn" ? word(0n) : word(1n)],
  data: word(amount), blockNumber: "0x66", blockHash: word(12n), transactionHash: word(20n),
  transactionIndex: "0x0", logIndex: `0x${index.toString(16)}`, removed: false };
}
function input(logs = [log("mint", 2n), log("burn", 1n, 1)]) {
  return { config, logs: config.events.map((eventDef) => ({ eventDef,
    logs: logs.filter((item) => item.topics[eventDef.direction === "mint" ? 1 : 2] === word(0n)) })),
  fromBlock: 101, toBlock: 102, checkedAt: 1100, complete: true, rpcUrl: "https://rpc.example", budget: { count: 0, limit: 3 } };
}
function rpc(delta = 1n) {
  vi.mocked(fetchEvmRpcBatchDetailed).mockResolvedValueOnce({ results: headers, errors: [] })
    .mockResolvedValueOnce({ results: [word(100n), word(100n + delta)], errors: [] })
    .mockResolvedValueOnce({ results: headers, errors: [] });
}
describe("raw token conservation", () => {
  it("admits exactly fifteen reviewed identities and rejects changed decimals/events", () => {
    expect(MINT_BURN_CONFIGS.filter((item) => getMintBurnConservationEligibility(item).supported)).toHaveLength(15);
    expect(getMintBurnConservationEligibility({ ...config, decimals: 18 }).supported).toBe(false);
    expect(getMintBurnConservationEligibility({ ...config, adapterKind: "mixed" }).supported).toBe(false);
    expect(getMintBurnConservationEligibility({ ...config, events: [config.events[0]] }).supported).toBe(false);
  });
  it("includes dust and atomic/bridge legs in exact BigInt arithmetic using canonical hash calls", async () => {
    rpc();
    const args = input();
    const result = await auditMintBurnConservation(args);
    expect(result).toMatchObject({ status: "ok", mintRaw: "2", burnRaw: "1", supplyDeltaRaw: "1", residualRaw: "0", fromBlock: 100 });
    expect(args.budget.count).toBe(3);
    expect(vi.mocked(fetchEvmRpcBatchDetailed).mock.calls[1][1]).toEqual(headers.map((header) => ({ method: "eth_call",
      params: [{ to: config.contractAddress, data: "0x18160ddd" }, { blockHash: header.hash, requireCanonical: true }] })));
  });
  it("retains signed exact residuals rather than floating-point tolerance", async () => {
    rpc(3n);
    expect(await auditMintBurnConservation(input())).toMatchObject({ status: "mismatch", residualRaw: "-2" });
  });
  it("deduplicates identical provider logs", async () => {
    rpc(2n);
    const one = log("mint", 2n);
    expect(await auditMintBurnConservation(input([one, one]))).toMatchObject({ status: "ok", mintRaw: "2", logCount: 1 });
  });
  it.each(["removed", "hash", "word", "range", "topic", "duplicate"])("rejects %s raw-log corruption", async (kind) => {
    const one = log("mint", 2n);
    const rows = [one];
    if (kind === "removed") one.removed = true;
    if (kind === "hash") one.blockHash = "0x123";
    if (kind === "word") one.data = "0x2";
    if (kind === "range") one.blockNumber = "0x64";
    if (kind === "topic") one.topics[0] = word(7n);
    if (kind === "duplicate") rows.push({ ...one, data: word(3n) });
    expect((await auditMintBurnConservation(input(rows))).status).toBe("unavailable");
    expect(fetchEvmRpcBatchDetailed).not.toHaveBeenCalled();
  });
  it("does no RPC on partial coverage or exhausted budget", async () => {
    expect((await auditMintBurnConservation({ ...input(), complete: false })).reason).toBe("incomplete-log-range");
    expect((await auditMintBurnConservation({ ...input(), budget: { count: 3, limit: 3 } })).reason).toBe("audit-budget-or-deadline");
    expect(fetchEvmRpcBatchDetailed).not.toHaveBeenCalled();
  });
  it("never falls back to latest when hash calls fail and rejects post-call reorg", async () => {
    vi.mocked(fetchEvmRpcBatchDetailed).mockResolvedValueOnce({ results: headers, errors: [] }).mockResolvedValueOnce(null);
    expect((await auditMintBurnConservation(input())).reason).toBe("audit-rpc-unavailable");
    expect(fetchEvmRpcBatchDetailed).toHaveBeenCalledTimes(2);
    vi.resetAllMocks();
    rpc();
    vi.mocked(fetchEvmRpcBatchDetailed).mockReset().mockResolvedValueOnce({ results: headers, errors: [] })
      .mockResolvedValueOnce({ results: [word(100n), word(101n)], errors: [] })
      .mockResolvedValueOnce({ results: [headers[0], { ...headers[1], hash: word(99n) }], errors: [] });
    expect((await auditMintBurnConservation(input())).reason).toBe("boundary-reorg");
  });
  it("propagates aborts", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(auditMintBurnConservation({ ...input(), signal: controller.signal })).rejects.toThrow();
  });
  it("detects eligible parser omissions and amount errors even with balanced raw net", () => {
    const args = input([log("mint", 1_000_000n)]);
    expect(() => validateMintBurnParsedConservation(config, args.logs, 101, 102, [])).toThrow("count-mismatch");
    const row = { id: `ethereum-${word(20n)}-0`, direction: "mint", amount: 10_000 } as MintBurnRow;
    expect(() => validateMintBurnParsedConservation(config, args.logs, 101, 102, [row])).not.toThrow();
    expect(() => validateMintBurnParsedConservation(config, args.logs, 101, 102, [{ ...row, amount: 1 }])).toThrow("amount-or-identity");
  });
  it("atomically retains a mismatch through unavailable/older attempts until verified pass", async () => {
    const { db } = fixtures.open(); rpc(3n);
    const mismatch = await auditMintBurnConservation(input());
    await persistMintBurnConservation(db, mismatch);
    await persistMintBurnConservation(db, { ...mismatch, status: "unavailable", checkedAt: 1200 });
    const read = async () => (await readMintBurnConservationRecords(db, [config])).get(mintBurnConservationCacheKey(config));
    expect(await read()).toEqual(mismatch);
    await persistMintBurnConservation(db, { ...mismatch, status: "ok", checkedAt: 1000 });
    expect(await read()).toEqual(mismatch);
    await persistMintBurnConservation(db, { ...mismatch, status: "ok", fromBlock: 101, checkedAt: 1201 });
    expect(await read()).toEqual(mismatch);
    await persistMintBurnConservation(db, { ...mismatch, status: "mismatch", fromBlock: 103, toBlock: 104, checkedAt: 1202 });
    expect(await read()).toEqual(mismatch);
    await persistMintBurnConservation(db, { ...mismatch, status: "ok", fromBlock: 103, toBlock: 104, checkedAt: 1203 });
    expect(await read()).toEqual(mismatch);
    const pass = { ...mismatch, status: "ok" as const, residualRaw: "0", checkedAt: 1201 };
    await persistMintBurnConservation(db, pass);
    expect(await read()).toEqual(pass);
  });
  it.each(["broken", "{}", '{"status":"mismatch"}'])("repairs invalid cached JSON %s", async (value) => {
    const { db, sqlite } = fixtures.open(); rpc();
    const pass = await auditMintBurnConservation(input());
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(pass.key, value, 1000);
    await persistMintBurnConservation(db, pass);
    expect((await readMintBurnConservationRecords(db, [config])).get(pass.key)).toEqual(pass);
  });

  it("readback rejects a corrupt INSERT OR IGNORE survivor and missing row", async () => {
    const { db, sqlite } = fixtures.open();
    const expected = { id: "test", stablecoin_id: config.stablecoinId, chain_id: "ethereum", direction: "mint",
      amount: 10_000, block_number: 102, timestamp: 1100 } as MintBurnRow;
    expect(await verifyPersistedMintBurnConservation(db, [expected])).toBe("mismatch");
    sqlite.prepare(`INSERT INTO mint_burn_events (id, stablecoin_id, symbol, chain_id, direction, amount,
      tx_hash, block_number, timestamp, explorer_tx_url) VALUES (?, ?, 'GUSD', 'ethereum', 'mint', ?, 'tx', 102, 1100, '')`)
      .run("test", config.stablecoinId, 9999);
    expect(await verifyPersistedMintBurnConservation(db, [expected])).toBe("mismatch");
    sqlite.prepare("UPDATE mint_burn_events SET amount = 10000 WHERE id = 'test'").run();
    expect(await verifyPersistedMintBurnConservation(db, [expected])).toBe("ok");
    expect(await verifyPersistedMintBurnConservation(db, [expected], undefined, 0)).toBe("deadline");
  });

});
