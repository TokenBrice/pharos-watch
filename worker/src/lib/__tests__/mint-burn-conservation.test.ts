import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { MINT_BURN_CONFIGS } from "../mint-burn-contracts";
import { fetchEvmRpcBatchDetailed } from "../evm-rpc";
import { completeMintBurnConservationAudit, fetchConservationBoundaries, getMintBurnConservationEligibility,
  isMintBurnConservationUnsupportedReason, mintBurnConservationCacheKey, resolveMintBurnConservationEligibility,
  reviewedConservationIdentityKey, validateReviewedConservationEntry,
  persistMintBurnConservation, readMintBurnConservationRecords, validateMintBurnParsedConservation, verifyPersistedMintBurnConservation,
  type ConservationBoundaryEvidence, type ConservationBoundaryRequest, type ReviewedConservationEntry } from "../mint-burn-conservation";
import { renderMintBurnConservationRuntime } from "../../../../scripts/maintenance/generate-mint-burn-conservation-runtime";
import reviewedConservationSidecar from "../mint-burn-conservation-reviewed.json";
import type { AlchemyLogEntry } from "../alchemy-logs";
import type { MintBurnRow } from "../mint-burn-pipeline/types";
vi.mock("../evm-rpc", () => ({ fetchEvmRpcBatchDetailed: vi.fn() }));
const config = MINT_BURN_CONFIGS.find((item) => item.stablecoinId === "gusd-gemini")!;
const sidecarEntries = reviewedConservationSidecar.entries as unknown as ReviewedConservationEntry[];
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
  fromBlock: 101, toBlock: 102, checkedAt: 1100, complete: true, boundary: ready() };
}
function ready(delta = 1n): ConservationBoundaryEvidence {
  return { status: "ready", fromBlockHash: headers[0].hash, toBlockHash: headers[1].hash,
    fromTimestamp: 1000, toTimestamp: 1024, fromSupplyRaw: "100", toSupplyRaw: (100n + delta).toString() };
}
function boundaryInput(requests: ConservationBoundaryRequest[] = [{ key: "one", config, fromBlock: 101, toBlock: 102 }]) {
  return { requests, rpcUrlByChain: new Map([["ethereum", "https://rpc.example"]]),
    budget: { count: 0, limit: 100 }, checkedAt: 1100 };
}
async function auditWithBoundaries() {
  const boundaries = await fetchConservationBoundaries(boundaryInput());
  return completeMintBurnConservationAudit({ ...input(), boundary: boundaries.get("one") });
}
function rpc(delta = 1n) {
  vi.mocked(fetchEvmRpcBatchDetailed).mockResolvedValueOnce({ results: headers, errors: [] })
    .mockResolvedValueOnce({ results: [word(100n), word(100n + delta)], errors: [] })
    .mockResolvedValueOnce({ results: headers, errors: [] });
}

const disjointRequests: ConservationBoundaryRequest[] = [
  { key: "one", config, fromBlock: 101, toBlock: 102 },
  { key: "two", config, fromBlock: 105, toBlock: 106 },
];
function generatedHeader(block: number) {
  return { number: `0x${block.toString(16)}`, hash: word(BigInt(block)), timestamp: `0x${(900 + block).toString(16)}` };
}
function pooledRpc() {
  vi.mocked(fetchEvmRpcBatchDetailed).mockImplementation(async (_chain, calls) => ({
    results: calls.map((call) => call.method === "eth_call" ? word(100n) : generatedHeader(Number(call.params[0]))),
    errors: [],
  }));
}

describe("pooled conservation boundaries", () => {
  it("chunks N+1 calls into two POSTs in each of the three phases", async () => {
    pooledRpc();
    const args = { ...boundaryInput(disjointRequests), maxBatchCalls: 3 };
    const result = await fetchConservationBoundaries(args);
    expect([...result.values()].map((item) => item.status)).toEqual(["ready", "ready"]);
    expect(vi.mocked(fetchEvmRpcBatchDetailed).mock.calls.map((call) => call[1].length)).toEqual([3, 1, 3, 1, 3, 1]);
    expect(args.budget.count).toBe(6);
    expect(vi.mocked(fetchEvmRpcBatchDetailed).mock.calls[0][2]).toMatchObject({
      extraRpcUrls: ["https://rpc.example"], maxRetries: 0, timeoutMs: 15_000,
    });
  });
  it("deduplicates shared headers but keeps per-request supply reads", async () => {
    pooledRpc();
    const result = await fetchConservationBoundaries(boundaryInput([
      disjointRequests[0], { ...disjointRequests[0], key: "two" },
    ]));
    expect(result.get("one")?.status).toBe("ready");
    expect(result.get("two")?.status).toBe("ready");
    expect(vi.mocked(fetchEvmRpcBatchDetailed).mock.calls.map((call) => call[1].length)).toEqual([2, 4, 2]);
  });
  it.each(["header", "supply", "recheck"])("isolates a per-call %s error to its dependents", async (phase) => {
    pooledRpc();
    const normal = vi.mocked(fetchEvmRpcBatchDetailed).getMockImplementation()!;
    let pass = 0;
    vi.mocked(fetchEvmRpcBatchDetailed).mockImplementation(async (...args) => {
      const result = (await normal(...args))!;
      if (pass++ === ["header", "supply", "recheck"].indexOf(phase)) {
        result.results[0] = undefined;
        result.errors.push({ index: 0, code: -32000 });
      }
      return result;
    });
    const result = await fetchConservationBoundaries(boundaryInput(disjointRequests));
    expect(result.get("one")).toEqual({ status: "unavailable", reason: "audit-rpc-unavailable" });
    expect(result.get("two")?.status).toBe("ready");
  });
  it.each(["null", "throw"])("isolates a failed chunk (%s) without losing later chunks", async (kind) => {
    pooledRpc();
    if (kind === "null") vi.mocked(fetchEvmRpcBatchDetailed).mockResolvedValueOnce(null);
    else vi.mocked(fetchEvmRpcBatchDetailed).mockRejectedValueOnce(new Error("timeout"));
    const result = await fetchConservationBoundaries({ ...boundaryInput(disjointRequests), maxBatchCalls: 2 });
    expect(result.get("one")).toEqual({ status: "unavailable", reason: "audit-rpc-unavailable" });
    expect(result.get("two")?.status).toBe("ready");
  });
  it.each(["hash", "number", "timestamp", "malformed"])("isolates recheck %s changes", async (field) => {
    pooledRpc();
    const normal = vi.mocked(fetchEvmRpcBatchDetailed).getMockImplementation()!;
    let pass = 0;
    vi.mocked(fetchEvmRpcBatchDetailed).mockImplementation(async (...args) => {
      const result = (await normal(...args))!;
      if (pass++ === 2) {
        result.results[0] = { ...generatedHeader(100),
          ...(field === "hash" ? { hash: word(999n) } : field === "number" ? { number: "0x99" }
            : field === "timestamp" ? { timestamp: "0x999" } : { timestamp: "not-hex" }) };
      }
      return result;
    });
    const result = await fetchConservationBoundaries(boundaryInput(disjointRequests));
    expect(result.get("one")).toEqual({ status: "unavailable", reason: "boundary-reorg" });
    expect(result.get("two")?.status).toBe("ready");
  });
  it("marks every dependent of a shared failed block, not unrelated ranges", async () => {
    pooledRpc();
    vi.mocked(fetchEvmRpcBatchDetailed).mockResolvedValueOnce({
      results: [generatedHeader(100), undefined, generatedHeader(104), generatedHeader(106)],
      errors: [{ index: 1 }],
    });
    const result = await fetchConservationBoundaries(boundaryInput([
      disjointRequests[0], { key: "two", config, fromBlock: 103, toBlock: 104 },
      { key: "three", config, fromBlock: 105, toBlock: 106 },
    ]));
    expect(result.get("one")?.status).toBe("unavailable");
    expect(result.get("two")?.status).toBe("unavailable");
    expect(result.get("three")?.status).toBe("ready");
  });
  it("preserves finished rechecks when the budget exhausts mid-prepass", async () => {
    pooledRpc();
    const args = { ...boundaryInput(disjointRequests), maxBatchCalls: 2, budget: { count: 0, limit: 5 } };
    const result = await fetchConservationBoundaries(args);
    expect(result.get("one")?.status).toBe("ready");
    expect(result.get("two")).toEqual({ status: "unavailable", reason: "audit-budget-or-deadline" });
    expect(args.budget.count).toBe(5);
  });
  it("caps POST timeouts to the deadline and stops subsequent phases", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      pooledRpc();
      const normal = vi.mocked(fetchEvmRpcBatchDetailed).getMockImplementation()!;
      vi.mocked(fetchEvmRpcBatchDetailed).mockImplementation(async (...args) => {
        clock.mockReturnValue(1100);
        return normal(...args);
      });
      const result = await fetchConservationBoundaries({ ...boundaryInput(), deadlineMs: 1100 });
      expect(vi.mocked(fetchEvmRpcBatchDetailed).mock.calls[0][2]?.timeoutMs).toBe(100);
      expect(result.get("one")).toEqual({ status: "unavailable", reason: "audit-budget-or-deadline" });
      expect(fetchEvmRpcBatchDetailed).toHaveBeenCalledTimes(1);
    } finally { clock.mockRestore(); }
  });
  it.each(["resolved", "rejected"])("propagates an in-flight abort after a %s RPC", async (kind) => {
    const controller = new AbortController();
    vi.mocked(fetchEvmRpcBatchDetailed).mockImplementation(async () => {
      controller.abort(new Error("cancelled"));
      if (kind === "rejected") throw new Error("transport aborted");
      return null;
    });
    await expect(fetchConservationBoundaries({ ...boundaryInput(), signal: controller.signal })).rejects.toThrow("cancelled");
  });
  it.each([
    [null, "invalid-boundary-header"],
    [{ ...generatedHeader(100), number: "0x99" }, "invalid-boundary-header"],
    [{ ...generatedHeader(100), hash: word(0n) }, "invalid-boundary-header"],
    [{ ...generatedHeader(100), number: "wrong" }, "invalid-rpc-quantity"],
    [{ ...generatedHeader(100), number: "0x20000000000000" }, "unsafe-rpc-quantity"],
    [{ ...generatedHeader(100), timestamp: "0x0" }, "invalid-boundary-time"],
    [{ ...generatedHeader(100), timestamp: "0x999" }, "invalid-boundary-time"],
    [{ ...generatedHeader(100), hash: word(102n) }, "invalid-boundary-time"],
  ])("rejects invalid initial header %j", async (header, reason) => {
    pooledRpc();
    vi.mocked(fetchEvmRpcBatchDetailed).mockResolvedValueOnce({ results: [header, generatedHeader(102)], errors: [] });
    expect((await fetchConservationBoundaries(boundaryInput())).get("one")).toEqual({ status: "unavailable", reason });
  });
  it("rejects future boundary time and invalid supply words", async () => {
    pooledRpc();
    expect((await fetchConservationBoundaries({ ...boundaryInput(), checkedAt: 1001 })).get("one"))
      .toEqual({ status: "unavailable", reason: "invalid-boundary-time" });
    vi.mocked(fetchEvmRpcBatchDetailed).mockResolvedValueOnce({ results: headers, errors: [] })
      .mockResolvedValueOnce({ results: ["0x1", word(100n)], errors: [] });
    expect((await fetchConservationBoundaries(boundaryInput())).get("one"))
      .toEqual({ status: "unavailable", reason: "invalid-total-supply-word" });
  });
  it("skips unsupported identities and rejects invalid ranges or missing URLs without RPC", async () => {
    const requests = [
      { ...disjointRequests[0], key: "unsupported", config: { ...config, decimals: 99 } },
      { ...disjointRequests[0], key: "invalid", fromBlock: 0 },
      disjointRequests[0],
    ];
    const result = await fetchConservationBoundaries({ ...boundaryInput(requests), rpcUrlByChain: new Map() });
    expect(result.has("unsupported")).toBe(false);
    expect(result.get("invalid")).toEqual({ status: "unavailable", reason: "invalid-audit-range" });
    expect(result.get("one")).toEqual({ status: "unavailable", reason: "audit-rpc-unavailable" });
    expect(fetchEvmRpcBatchDetailed).not.toHaveBeenCalled();
    await expect(fetchConservationBoundaries({ ...boundaryInput(), maxBatchCalls: 0 })).rejects.toThrow("invalid-conservation-batch-size");
  });
  it("uses the default 100-call cap for larger batches", async () => {
    pooledRpc();
    const requests = Array.from({ length: 51 }, (_, index) => ({
      key: String(index), config, fromBlock: 101 + index * 2, toBlock: 102 + index * 2,
    }));
    const result = await fetchConservationBoundaries({ ...boundaryInput(requests), checkedAt: 2000 });
    expect([...result.values()].every((item) => item.status === "ready")).toBe(true);
    // 52 distinct headers (adjacent ranges share a boundary), 102 supply calls.
    expect(vi.mocked(fetchEvmRpcBatchDetailed).mock.calls.map((call) => call[1].length)).toEqual([52, 100, 2, 52]);
  });
  it("does not spend another POST on a request whose opening header already failed", async () => {
    vi.mocked(fetchEvmRpcBatchDetailed).mockResolvedValueOnce(null);
    const args = { ...boundaryInput(), maxBatchCalls: 1 };
    const result = await fetchConservationBoundaries(args);
    expect(result.get("one")).toEqual({ status: "unavailable", reason: "audit-rpc-unavailable" });
    expect(args.budget.count).toBe(1);
  });
  it("returns unavailable without any request after the pre-pass deadline", async () => {
    const result = await fetchConservationBoundaries({ ...boundaryInput(), deadlineMs: 0 });
    expect(result.get("one")).toEqual({ status: "unavailable", reason: "audit-budget-or-deadline" });
    expect(fetchEvmRpcBatchDetailed).not.toHaveBeenCalled();
  });
});
describe("raw token conservation", () => {
  it("holds only structurally valid reviewed sidecar entries", () => {
    expect(sidecarEntries.flatMap((entry) => validateReviewedConservationEntry(entry))).toEqual([]);
    const admitted = sidecarEntries.find((entry) => entry.stablecoinId === "gusd-gemini")!;
    expect(validateReviewedConservationEntry({ ...admitted, zeroRecipientTransferReverts: false })).toHaveLength(1);
    // OZ v5 `_update` burns on transfer-to-zero: reverts=false is admissible when the burn is paired.
    expect(validateReviewedConservationEntry({ ...admitted, zeroRecipientTransferReverts: false, zeroRecipientTransferBurns: true })).toEqual([]);
  });
  it("commits the runtime lookup as the byte-exact projection of the evidence sidecar", () => {
    expect(readFileSync(resolve(import.meta.dirname, "../mint-burn-conservation-runtime.generated.json"), "utf8"))
      .toBe(renderMintBurnConservationRuntime(reviewedConservationSidecar));
  });
  it("maps every sidecar entry to exactly one config, without duplicates or orphans", () => {
    const seen = new Map<string, number>();
    for (const entry of sidecarEntries) {
      const key = reviewedConservationIdentityKey(entry.chainId, entry.stablecoinId, entry.address, entry.decimals);
      seen.set(key, (seen.get(key) ?? 0) + 1);
      const matches = MINT_BURN_CONFIGS.filter((item) =>
        reviewedConservationIdentityKey(item.chain.chainId, item.stablecoinId, item.contractAddress, item.decimals) === key);
      expect(matches, key).toHaveLength(1);
      expect(matches[0]!.decimals, key).toBe(entry.decimals);
    }
    for (const [key, count] of seen) expect(count, key).toBe(1);
  });
  it("admits exactly the sidecar's admitted entries", () => {
    const admitted = new Set(sidecarEntries.filter((entry) => entry.disposition === "admitted")
      .map((entry) => reviewedConservationIdentityKey(entry.chainId, entry.stablecoinId, entry.address, entry.decimals)));
    const eligible = new Set(MINT_BURN_CONFIGS.filter((item) => getMintBurnConservationEligibility(item).supported)
      .map((item) => reviewedConservationIdentityKey(item.chain.chainId, item.stablecoinId, item.contractAddress, item.decimals)));
    expect([...eligible].sort()).toEqual([...admitted].sort());
  });
  it("returns an unsupported entry's specific reason and rejects off-vocabulary reasons", () => {
    const reason = "unpaired-supply-path:mintForBridge";
    const base: ReviewedConservationEntry = { chainId: config.chain.chainId, stablecoinId: config.stablecoinId,
      address: config.contractAddress.toLowerCase(), decimals: config.decimals, disposition: "unsupported" };
    expect(resolveMintBurnConservationEligibility({ ...base, unsupportedReason: reason }, config))
      .toEqual({ supported: false, reason });
    expect(resolveMintBurnConservationEligibility({ ...base, unsupportedReason: null }, config))
      .toEqual({ supported: false, reason: "unreviewed-contract-or-event-semantics" });
    expect(resolveMintBurnConservationEligibility(undefined, config))
      .toEqual({ supported: false, reason: "unreviewed-contract-or-event-semantics" });
    expect(validateReviewedConservationEntry({ ...base, disposition: "unsupported", unsupportedReason: "made-up-reason" }))
      .toHaveLength(1);
    expect(isMintBurnConservationUnsupportedReason("zero-address-transfer-without-supply-change:transferToSelf")).toBe(true);
    expect(isMintBurnConservationUnsupportedReason("unverified-implementation-source")).toBe(true);
  });
  it("rejects changed decimals, adapters and single-event configs", () => {
    expect(getMintBurnConservationEligibility({ ...config, decimals: 18 }).supported).toBe(false);
    expect(getMintBurnConservationEligibility({ ...config, adapterKind: "mixed" }).supported).toBe(false);
    expect(getMintBurnConservationEligibility({ ...config, events: [config.events[0]] }).supported).toBe(false);
  });
  it("includes dust and atomic/bridge legs in exact BigInt arithmetic using canonical hash calls", async () => {
    rpc();
    const args = boundaryInput();
    const boundaries = await fetchConservationBoundaries(args);
    const result = completeMintBurnConservationAudit({ ...input(), boundary: boundaries.get("one") });
    expect(result).toMatchObject({ status: "ok", mintRaw: "2", burnRaw: "1", supplyDeltaRaw: "1", residualRaw: "0", fromBlock: 100 });
    expect(args.budget.count).toBe(3);
    expect(vi.mocked(fetchEvmRpcBatchDetailed).mock.calls[1][1]).toEqual(headers.map((header) => ({ method: "eth_call",
      params: [{ to: config.contractAddress, data: "0x18160ddd" }, { blockHash: header.hash, requireCanonical: true }] })));
  });
  it("retains signed exact residuals rather than floating-point tolerance", async () => {
    expect(completeMintBurnConservationAudit({ ...input(), boundary: ready(3n) })).toMatchObject({ status: "mismatch", residualRaw: "-2" });
  });
  it("deduplicates identical provider logs", async () => {
    const one = log("mint", 2n);
    expect(completeMintBurnConservationAudit({ ...input([one, one]), boundary: ready(2n) })).toMatchObject({ status: "ok", mintRaw: "2", logCount: 1 });
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
    expect(completeMintBurnConservationAudit(input(rows)).status).toBe("unavailable");
    expect(fetchEvmRpcBatchDetailed).not.toHaveBeenCalled();
  });
  it("does no RPC on partial coverage or exhausted budget", async () => {
    expect(completeMintBurnConservationAudit({ ...input(), complete: false }).reason).toBe("incomplete-log-range");
    expect((await fetchConservationBoundaries({ ...boundaryInput(), budget: { count: 3, limit: 3 } })).get("one"))
      .toEqual({ status: "unavailable", reason: "audit-budget-or-deadline" });
    expect(fetchEvmRpcBatchDetailed).not.toHaveBeenCalled();
  });
  it("never falls back to latest when hash calls fail and rejects post-call reorg", async () => {
    vi.mocked(fetchEvmRpcBatchDetailed).mockResolvedValueOnce({ results: headers, errors: [] }).mockResolvedValueOnce(null);
    expect((await auditWithBoundaries()).reason).toBe("audit-rpc-unavailable");
    expect(fetchEvmRpcBatchDetailed).toHaveBeenCalledTimes(2);
    vi.resetAllMocks();
    rpc();
    vi.mocked(fetchEvmRpcBatchDetailed).mockReset().mockResolvedValueOnce({ results: headers, errors: [] })
      .mockResolvedValueOnce({ results: [word(100n), word(101n)], errors: [] })
      .mockResolvedValueOnce({ results: [headers[0], { ...headers[1], hash: word(99n) }], errors: [] });
    expect((await auditWithBoundaries()).reason).toBe("boundary-reorg");
  });
  it("propagates aborts", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(fetchConservationBoundaries({ ...boundaryInput(), signal: controller.signal })).rejects.toThrow();
  });
  it("requires boundary evidence, preserves unsupported status, and rejects incomplete or invalid ranges", () => {
    expect(completeMintBurnConservationAudit({ ...input(), boundary: undefined }).reason).toBe("boundary-evidence-missing");
    expect(completeMintBurnConservationAudit({ ...input(), fromBlock: 0 }).reason).toBe("invalid-audit-range");
    expect(completeMintBurnConservationAudit({ ...input(), config: { ...config, decimals: 99 } }))
      .toMatchObject({ status: "unsupported", reason: "unreviewed-contract-or-event-semantics" });
    expect(completeMintBurnConservationAudit({ ...input(), boundary: { status: "unavailable", reason: "audit-rpc-unavailable" } }).reason)
      .toBe("audit-rpc-unavailable");
  });
  it("rejects closing-log hash mismatch and ambiguous zero transfers", () => {
    expect(completeMintBurnConservationAudit(input([{ ...log("mint", 2n), blockHash: word(99n) }])).reason)
      .toBe("closing-log-hash-mismatch");
    const ambiguous = log("mint", 1n);
    ambiguous.topics[2] = word(0n);
    expect(completeMintBurnConservationAudit(input([ambiguous])).reason).toBe("ambiguous-zero-transfer");
  });
  it("rejects inconsistent log block hashes and ignores zero-value logs", () => {
    expect(completeMintBurnConservationAudit(input([log("mint", 2n), { ...log("burn", 1n, 1), blockHash: word(99n) }])).reason)
      .toBe("inconsistent-log-block-hash");
    expect(completeMintBurnConservationAudit({ ...input([log("mint", 0n)]), boundary: ready(0n) }))
      .toMatchObject({ status: "ok", logCount: 0, mintRaw: "0", burnRaw: "0" });
  });
  it("detects eligible parser omissions and amount errors even with balanced raw net", () => {
    const args = input([log("mint", 1_000_000n)]);
    expect(() => validateMintBurnParsedConservation(config, args.logs, 101, 102, [])).toThrow("count-mismatch");
    const row = { id: `ethereum-${word(20n)}-0`, direction: "mint", amount: 10_000 } as MintBurnRow;
    expect(() => validateMintBurnParsedConservation(config, args.logs, 101, 102, [row])).not.toThrow();
    expect(() => validateMintBurnParsedConservation(config, args.logs, 101, 102, [{ ...row, amount: 1 }])).toThrow("amount-or-identity");
  });
  it("atomically retains a mismatch through unavailable/older attempts until verified pass", async () => {
    const { db } = fixtures.open();
    const mismatch = completeMintBurnConservationAudit({ ...input(), boundary: ready(3n) });
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
    const { db, sqlite } = fixtures.open();
    const pass = completeMintBurnConservationAudit(input());
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
