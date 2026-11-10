import { beforeEach, describe, expect, it, vi } from "vitest";
import { mintBurnAlchemyEndpoint } from "../../lib/mint-burn-pipeline/rpc";
import { createMintBurnConfigSummary, syncMintBurnConfig, type MintBurnConfigSummary } from "../mint-burn/sync-config";
import { isMintBurnCapacityOnlyRepairDebt } from "../mint-burn/repair-coverage";
import { MINT_BURN_CONFIGS } from "../../lib/mint-burn-contracts";
import { fetchAlchemyLogs, resolveBlockTimestamps } from "../../lib/alchemy-logs";
import { parseMintBurnLogs } from "../../lib/mint-burn-pipeline/parse";
import { classifyBridgeBurnRows, reconcileReviewedSupplyBurns } from "../../lib/mint-burn-pipeline/classification";
import { persistMintBurnRows } from "../../lib/mint-burn-pipeline/persistence";
import { reconcileAtomicRoundtripGroups } from "../../lib/mint-burn-pipeline/roundtrip-detection";
import { completeMintBurnRangeSupplyProof, requiresReviewedSupplyBurnProof, completeMintBurnConservationAudit, conservationOnlyEventDefsFor, persistMintBurnConservation,
  readMintBurnConservationRecords, validateMintBurnParsedConservation, verifyPersistedMintBurnConservation,
  type ConservationEventDef } from "../../lib/mint-burn-conservation";
import { acceptMintBurnSupplyProof, invalidateConflictingMintBurnSupplyProofs, invalidateMintBurnSupplyProofs, invalidateMintBurnSupplyProofRange, persistMintBurnSupplyProof, type MintBurnSupplyProofEvidence } from "../../lib/mint-burn-supply-proofs";
import type { MintBurnRow } from "../../lib/mint-burn-pipeline/types";
import type { MintBurnConservationRecord } from "@shared/types/status";
import { mockD1 } from "@shared/test-utils/mock-d1";
import type * as AlchemyLogsModule from "../../lib/alchemy-logs";
vi.mock("../../lib/alchemy-logs", async (importOriginal) => ({
  ...(await importOriginal<typeof AlchemyLogsModule>()),
  fetchAlchemyLogs: vi.fn(),
  resolveBlockTimestamps: vi.fn(),
}));
vi.mock("../../lib/mint-burn-pipeline/parse", () => ({ parseMintBurnLogs: vi.fn() }));
vi.mock("../../lib/mint-burn-pipeline/classification", () => ({
  classifyBridgeBurnRows: vi.fn(), reconcileReviewedSupplyBurns: vi.fn(async () => 0),
}));
vi.mock("../../lib/mint-burn-pipeline/persistence", () => ({ persistMintBurnRows: vi.fn() }));
vi.mock("../../lib/mint-burn-pipeline/roundtrip-detection", () => ({ reconcileAtomicRoundtripGroups: vi.fn() }));
vi.mock("../../lib/mint-burn-conservation", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/mint-burn-conservation")>(),
  getMintBurnConservationEligibility: () => ({ supported: true }),
  needsMintBurnConservationBoundaries: () => true,
  requiresReviewedSupplyBurnProof: vi.fn(() => false),
  completeMintBurnRangeSupplyProof: vi.fn(),
  conservationOnlyEventDefsFor: vi.fn(() => []),
  completeMintBurnConservationAudit: vi.fn(), persistMintBurnConservation: vi.fn(), validateMintBurnParsedConservation: vi.fn(),
  readMintBurnConservationRecords: vi.fn(), verifyPersistedMintBurnConservation: vi.fn() }));
vi.mock("../../lib/mint-burn-supply-proofs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/mint-burn-supply-proofs")>()),
  persistMintBurnSupplyProof: vi.fn(async () => {}), acceptMintBurnSupplyProof: vi.fn(async () => true),
  invalidateMintBurnSupplyProofs: vi.fn(async () => 0),
  invalidateMintBurnSupplyProofRange: vi.fn(async () => 0),
  invalidateConflictingMintBurnSupplyProofs: vi.fn(async () => ({ invalidated: 0, conflict: false })),
}));
const config = MINT_BURN_CONFIGS.find((item) => item.stablecoinId === "gusd-gemini")!;
const row = { id: "event", tx_hash: "tx", direction: "mint", amount: 10_000, amount_raw: "10000",
  below_display_threshold: 0, block_number: 102, timestamp: 1100 } as MintBurnRow;
const audit = { key: "conservation-key", status: "ok", checkedAt: 1200 } as MintBurnConservationRecord;
const conservationEventDef: ConservationEventDef = {
  signature: "DestroyedBlackFunds(address,uint256)",
  topicHash: `0x${"a".repeat(64)}`,
  direction: "burn",
  amountEncoding: "nth-data-uint256",
  dataSlot: 1,
  topicArity: 1,
  emitter: `0x${"b".repeat(40)}`,
};
function expectBefore(first: { mock: { invocationCallOrder: number[] } }, second: { mock: { invocationCallOrder: number[] } }) {
  expect(first.mock.invocationCallOrder[0]).toBeLessThan(second.mock.invocationCallOrder[0]);
}

function mintLog() {
  return { address: config.contractAddress,
    topics: [config.events[0]!.topicHash, `0x${"0".repeat(64)}`, `0x${"0".repeat(63)}1`],
    data: `0x${(1_000_000n).toString(16).padStart(64, "0")}`, blockNumber: "0x66",
    transactionHash: `0x${"c".repeat(64)}`, transactionIndex: "0x0",
    blockHash: `0x${"d".repeat(64)}`, logIndex: "0x0", removed: false };
}
function run(db: D1Database = {} as D1Database, summary?: MintBurnConfigSummary) {
  return syncMintBurnConfig({ db, summary, config, key: "key", tier: "extended", fromBlock: 101,
    scanTo: 102, chainHead: 200, rpcEndpoints: [mintBurnAlchemyEndpoint("https://rpc.example")], configBudgetLimit: 25, runTimestamp: 1200,
    priceContext: { priceObservations: new Map(), priceHistory: new Map() }, chainTimestampCache: new Map(),
    txContextCache: new Map(), affectedHours: new Map() });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchAlchemyLogs).mockResolvedValueOnce({ logs: [mintLog()], complete: true, scannedToBlock: 102 } as never)
    .mockResolvedValueOnce({ logs: [], complete: true, scannedToBlock: 102 } as never);
  vi.mocked(resolveBlockTimestamps).mockResolvedValue(new Map([[101, 1099], [102, 1100]]));
  vi.mocked(parseMintBurnLogs).mockReturnValue({
    rows: [{ ...row }],
    dropped: 0,
    droppedMalformed: 0,
    droppedDecode: 0,
    earliestDecodeFailureBlock: null,
  });
  vi.mocked(classifyBridgeBurnRows).mockResolvedValue({ effectiveBurns: 0, bridgeBurns: 0, reviewBurns: 0,
    txContextShortfalls: 0, deferredTxHashes: [] });
  vi.mocked(persistMintBurnRows).mockResolvedValue({ inserted: 1, ignored: 0, roundtripsDetected: 0, flowTypeChanges: 0, rowsUpdated: 0 } as never);
  vi.mocked(reconcileAtomicRoundtripGroups).mockResolvedValue({ changed: 0, toRoundtrip: 0, toStandard: 0, affectedHours: new Map() });
  vi.mocked(completeMintBurnConservationAudit).mockReturnValue({ ...audit });
  vi.mocked(persistMintBurnConservation).mockResolvedValue({ written: true });
  vi.mocked(verifyPersistedMintBurnConservation).mockResolvedValue("ok");
});
describe("conservation producer publication and cursor fences", () => {
  it.each(["written", "stored-pass", "stored-mismatch"])("publishes the durable %s verdict behind readback", async (kind) => {
    vi.mocked(persistMintBurnConservation).mockResolvedValue({ written: kind === "written" });
    vi.mocked(readMintBurnConservationRecords).mockResolvedValue(
      new Map([["conservation-key", { status: kind === "stored-mismatch" ? "mismatch" : "ok" }]]));
    const result = await run();
    expect(result.newLastBlock).toBe(kind === "stored-mismatch" ? null : 102);
    expect(result.summary.conservationStatus).toBe(kind === "stored-mismatch" ? "mismatch" : "ok");
    expect(result.summary.conservationFailure).toBe(kind === "stored-mismatch");
    if (kind === "stored-mismatch") expect(result.summary.conservationReason).toBe("unresolved-stored-mismatch");
    expectBefore(vi.mocked(persistMintBurnRows), vi.mocked(persistMintBurnConservation));
    expectBefore(vi.mocked(verifyPersistedMintBurnConservation), vi.mocked(persistMintBurnConservation));
  });
  it.each([true, false])("audits a conservation-only emitter without adding public rows (available=%s)", async (available) => {
    const conservationLog = {
      address: conservationEventDef.emitter!,
      topics: [conservationEventDef.topicHash],
      data: `0x${"0".repeat(64)}${(2_000_000n).toString(16).padStart(64, "0")}`,
      blockNumber: "0x65",
      transactionHash: `0x${"c".repeat(64)}`,
      transactionIndex: "0x0",
      blockHash: `0x${"d".repeat(64)}`,
      logIndex: "0x1",
      removed: false,
    };
    vi.mocked(conservationOnlyEventDefsFor).mockReturnValue([conservationEventDef]);
    vi.mocked(fetchAlchemyLogs).mockResolvedValueOnce(available ? {
      logs: [conservationLog], complete: true, scannedToBlock: 102, calls: 1, maxDepth: 0,
    } : null);
    if (!available) vi.mocked(completeMintBurnConservationAudit).mockReturnValue({
      ...audit, status: "unavailable", reason: "incomplete-log-range" });

    const result = await run();

    expect(fetchAlchemyLogs).toHaveBeenCalledWith("https://rpc.example", conservationEventDef.emitter,
      [{ index: 0, value: conservationEventDef.topicHash }], 101, 102, expect.anything(), undefined, undefined);
    expect(completeMintBurnConservationAudit).toHaveBeenCalledWith(expect.objectContaining({
      complete: available, conservationLogs: available ? [{ eventDef: conservationEventDef, logs: [conservationLog] }] : [],
    }));
    expect(parseMintBurnLogs).toHaveBeenCalledTimes(1);
    expect(persistMintBurnRows).toHaveBeenCalledWith(expect.anything(), [row], expect.anything(), expect.anything());
    expect(resolveBlockTimestamps).toHaveBeenCalledWith("https://rpc.example", [102], expect.anything(), expect.anything());
    expect(result.summary.conservationFailure).toBe(false);
    expect(result.summary.conservationStatus).toBe(available ? "ok" : "unavailable");
    expect(result.apiErrors + result.summary.errors).toBe(0);
    expect(result.summary.failedEventDefs).toEqual(available ? [] : [`conservation:${conservationEventDef.signature}:fetch-failed`]);
    expect(result.summary.rowsRead).toBe(1);
    expect(result.summary.rowsParsed).toBe(1);
    expect(result.summary.eventCoverage).toEqual(config.events.map((eventDef, index) => ({
      eventDef: `${eventDef.signature}:${eventDef.direction}`, status: "ok", complete: true,
      scannedToBlock: 102, rowsRead: index === 0 ? 1 : 0,
    })));
    expect(result.newLastBlock).toBe(102);
  });
  it("withholds the conservation verdict when a decode quarantine removes a raw log", async () => {
    const quarantined = {
      ...mintLog(), data: "0x1234", transactionHash: `0x${"e".repeat(64)}`, logIndex: "0x1",
    };
    const db = mockD1([
      { match: "SELECT value FROM cache", rows: [{
        value: JSON.stringify({ attempts: 2, quarantined: false, reason: "amount-decode-retry" }),
      }] },
      { match: "INSERT INTO cache", rows: [] },
    ]);
    vi.mocked(fetchAlchemyLogs).mockReset()
      .mockResolvedValueOnce({
        logs: [mintLog(), quarantined],
        complete: true, scannedToBlock: 102, calls: 1, maxDepth: 0,
      } as never)
      .mockResolvedValueOnce({ logs: [], complete: true, scannedToBlock: 102, calls: 1, maxDepth: 0 } as never);
    // The third observation quarantines the truncated log and splices it out of
    // the audited set. Its supply movement still sits in the boundary delta, so
    // the audit must not turn the reduced evidence into an arithmetic mismatch.
    vi.mocked(completeMintBurnConservationAudit).mockImplementation((input) => ({
      ...audit,
      status: input.complete ? "mismatch" : "unavailable",
      reason: input.complete ? "raw-transfer-supply-mismatch" : "incomplete-log-range",
    }));

    const result = await run(db);

    expect(result.summary.rowsQuarantinedDecode).toBe(1);
    expect(completeMintBurnConservationAudit).toHaveBeenCalledWith(expect.objectContaining({ complete: false }));
    expect(persistMintBurnConservation).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ status: "unavailable", reason: "incomplete-log-range" }), undefined);
    expect(result.summary.conservationStatus).toBe("unavailable");
  });
  it.each(["write", "read"])("invalidates a prior pass after event %s failure", async (stage) => {
    const error = new Error("storage failed");
    if (stage === "write") vi.mocked(persistMintBurnRows).mockRejectedValue(error);
    else vi.mocked(verifyPersistedMintBurnConservation).mockRejectedValue(error);
    await expect(run()).rejects.toThrow(error);
    expect(persistMintBurnConservation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: "unavailable", reason: stage === "write" ? "event-row-write-failed" : "persisted-event-readback-failed" }), undefined);
  });
  it.each(["timestamps", "deferred"])("does not publish pass with missing %s", async (kind) => {
    if (kind === "timestamps") vi.mocked(resolveBlockTimestamps).mockResolvedValue(new Map());
    else vi.mocked(classifyBridgeBurnRows).mockResolvedValue({ effectiveBurns: 0, bridgeBurns: 0, reviewBurns: 0,
      txContextShortfalls: 1, deferredTxHashes: ["tx"] });
    await run();
    expect(persistMintBurnConservation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: "unavailable" }), undefined);
  });
  it.each(["mismatch", "parser", "persisted"])("fences a verified %s failure even if rows were ignored", async (kind) => {
    vi.mocked(persistMintBurnRows).mockResolvedValue({ inserted: 0, ignored: 1, roundtripsDetected: 0 } as never);
    if (kind === "mismatch") vi.mocked(completeMintBurnConservationAudit).mockReturnValue({ ...audit, status: "mismatch" });
    if (kind === "parser") vi.mocked(validateMintBurnParsedConservation).mockImplementation(() => { throw new Error("bad row"); });
    if (kind === "persisted") vi.mocked(verifyPersistedMintBurnConservation).mockResolvedValue("mismatch");
    const result = await run();
    expect(result.newLastBlock).toBeNull();
    expect(result.summary.errors).toBeGreaterThan(0);
    // The pre-write fence is also a write barrier: only the post-write persisted
    // readback failure ("persisted") had legitimately written rows to suppress.
    expect(persistMintBurnRows).toHaveBeenCalledWith(expect.anything(),
      kind === "persisted" ? [row] : [], expect.anything(), expect.anything());
  });
  it.each(["audit-rpc-unavailable", "invalid-boundary-header"])("preserves ingestion through diagnostic %s", async (reason) => {
    vi.mocked(completeMintBurnConservationAudit).mockReturnValue({ ...audit, status: "unavailable", reason });
    const result = await run();
    expect(result.newLastBlock).toBe(102);
    expect(result.summary.errors).toBe(0);
    expect(result.apiErrors).toBe(0);
    expect(result.summary.conservationStatus).toBe("unavailable");
    expect(result.summary.conservationFailure).toBe(false);
    expect(result.summary.conservationReason).toBe(reason);
    expect(persistMintBurnRows).toHaveBeenCalledWith(expect.anything(), [row], expect.anything(), expect.anything());
    expect(persistMintBurnConservation).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ status: "unavailable", reason }), undefined);
  });
  it("persists a discrepancy before a row-write failure and fences invalid raw evidence", async () => {
    vi.mocked(completeMintBurnConservationAudit).mockReturnValue({ ...audit, status: "mismatch" });
    vi.mocked(persistMintBurnRows).mockRejectedValue(new Error("write failed"));
    await expect(run()).rejects.toThrow("write failed");
    expect(persistMintBurnConservation).toHaveBeenCalledTimes(1);
    expectBefore(vi.mocked(persistMintBurnConservation), vi.mocked(persistMintBurnRows));
  });
  it.each(["invalid-raw-log", "boundary-reorg", "closing-log-hash-mismatch"])("fences %s and suppresses its row write", async (reason) => {
    vi.mocked(completeMintBurnConservationAudit).mockReturnValue({ ...audit, status: "unavailable", reason });
    const result = await run();
    expect(result.newLastBlock).toBeNull();
    expect(persistMintBurnRows).toHaveBeenCalledWith(expect.anything(), [], expect.anything(), expect.anything());
    expect(result.summary.conservationFailure).toBe(true);
  });
  it.each(["mismatch", "rpc"])("retains %s evidence through a later D1 overload", async (kind) => {
    const summary = createMintBurnConfigSummary(config, "key", "extended");
    if (kind === "mismatch") vi.mocked(completeMintBurnConservationAudit).mockReturnValue({ ...audit, status: "mismatch" });
    else vi.mocked(classifyBridgeBurnRows).mockResolvedValue({ effectiveBurns: 0, bridgeBurns: 0, reviewBurns: 0,
      txContextShortfalls: 1, deferredTxHashes: ["tx"] });
    vi.mocked(persistMintBurnConservation).mockRejectedValue(new Error("D1 DB is overloaded. Too many resources consumed within a 10 second window"));
    await expect(run(undefined, summary)).rejects.toThrow("D1 DB is overloaded");
    expect(kind === "mismatch" ? summary.conservationFailure : summary.rpcEvidenceIncomplete).toBe(true);
    expect(isMintBurnCapacityOnlyRepairDebt({ ...summary, repairReason: "repair-runtime-exhausted" })).toBe(false);
  });
});

describe("conditional supply proof ordering and acceptance fences", () => {
  function enable(status: MintBurnSupplyProofEvidence["status"] = "proven", reason?: string) {
    vi.mocked(requiresReviewedSupplyBurnProof).mockReturnValue(true);
    const proof = { proofId: "supply-proof", status, reason, mintEvidence: "source-only",
      members: [{ id: row.id, direction: row.direction, amountRaw: "10000", blockNumber: row.block_number }] } as MintBurnSupplyProofEvidence;
    vi.mocked(completeMintBurnRangeSupplyProof).mockReturnValue(proof);
    vi.mocked(persistMintBurnSupplyProof).mockResolvedValue();
    vi.mocked(acceptMintBurnSupplyProof).mockResolvedValue(true);
    vi.mocked(invalidateConflictingMintBurnSupplyProofs).mockResolvedValue({ invalidated: 0, conflict: false });
    return proof;
  }
  it("proves before receipt classification, accepts after exact readback, and skips the supply sweep", async () => {
    const proof = enable();
    const result = await run();
    expect(result.newLastBlock).toBe(102);
    expect(classifyBridgeBurnRows).toHaveBeenCalledWith(expect.anything(), config, expect.anything(), expect.anything(),
      expect.anything(), undefined, expect.objectContaining({ rangeSupplyProof: proof }));
    expectBefore(vi.mocked(completeMintBurnRangeSupplyProof), vi.mocked(classifyBridgeBurnRows));
    expectBefore(vi.mocked(persistMintBurnSupplyProof), vi.mocked(persistMintBurnRows));
    expectBefore(vi.mocked(verifyPersistedMintBurnConservation), vi.mocked(acceptMintBurnSupplyProof));
    expectBefore(vi.mocked(acceptMintBurnSupplyProof), vi.mocked(reconcileAtomicRoundtripGroups));
    expect(reconcileReviewedSupplyBurns).not.toHaveBeenCalled();
    expect(vi.mocked(persistMintBurnRows).mock.calls[0][1][0]).toMatchObject({ supply_proof_id: proof.proofId, amount_raw: "10000" });
  });
  it("advances a complete residual range without promoting its candidates", async () => {
    enable("residual", "false-zero-transfer-residual");
    const result = await run();
    expect(result.newLastBlock).toBe(102);
    expect(result.summary.supplyProofStatus).toBe("residual");
    expect(acceptMintBurnSupplyProof).not.toHaveBeenCalled();
    expect(reconcileAtomicRoundtripGroups).not.toHaveBeenCalled();
    expect(vi.mocked(persistMintBurnRows).mock.calls[0][1][0].supply_proof_id).toBeUndefined();
  });
  it.each(["range-supply-assumptions-inconsistent", "ambiguous-zero-transfer", "removed-log-reorg"])("hard fences %s before canonical writes", async (reason) => {
    enable("unavailable", reason);
    const result = await run();
    expect(result.newLastBlock).toBeNull();
    if (reason === "removed-log-reorg") expect(invalidateMintBurnSupplyProofRange).toHaveBeenCalledWith(
      expect.anything(), "key", 100, Number.MAX_SAFE_INTEGER, reason, 1200, expect.anything());
    expect(vi.mocked(persistMintBurnRows).mock.calls[0][1]).toEqual([]);
    expect(acceptMintBurnSupplyProof).not.toHaveBeenCalled();
  });
  it("keeps an unavailable archive read unresolved while allowing ordinary scan progress", async () => {
    enable("unavailable", "audit-rpc-unavailable");
    const result = await run();
    expect(result.newLastBlock).toBe(102);
    expect(result.summary.supplyProofReason).toBe("audit-rpc-unavailable");
    expect(acceptMintBurnSupplyProof).not.toHaveBeenCalled();
  });
  it("invalidates config state before fetching and fences a conflicting prior canonical proof", async () => {
    enable();
    vi.mocked(invalidateConflictingMintBurnSupplyProofs).mockResolvedValue({ invalidated: 1, conflict: true,
      reason: "range-supply-proof-canonical-conflict" });
    const result = await run();
    expect(result.newLastBlock).toBeNull();
    expect(result.summary.supplyProofReason).toBe("range-supply-proof-canonical-conflict");
    expectBefore(vi.mocked(invalidateMintBurnSupplyProofs), vi.mocked(fetchAlchemyLogs));
    expect(acceptMintBurnSupplyProof).not.toHaveBeenCalled();
  });
  it.each(["proof-write", "event-write", "readback", "deadline", "acceptance"])("cannot accept or advance after %s failure", async (stage) => {
    enable();
    if (stage === "proof-write") vi.mocked(persistMintBurnSupplyProof).mockRejectedValue(new Error("proof-write"));
    if (stage === "event-write") vi.mocked(persistMintBurnRows).mockRejectedValue(new Error("event-write"));
    if (stage === "readback") vi.mocked(verifyPersistedMintBurnConservation).mockResolvedValue("mismatch");
    if (stage === "deadline") vi.mocked(verifyPersistedMintBurnConservation).mockResolvedValue("deadline");
    if (stage === "acceptance") vi.mocked(acceptMintBurnSupplyProof).mockResolvedValue(false);
    if (stage.endsWith("write")) {
      await expect(run()).rejects.toThrow(stage);
      expect(acceptMintBurnSupplyProof).not.toHaveBeenCalled();
    } else {
      const result = await run();
      expect(result.newLastBlock).toBeNull();
      expect(result.scanCoverage).toBeUndefined();
      expect(result.summary.conservationFailure).toBe(stage !== "deadline");
      expect(result.summary.supplyProofStatus).toBe("unavailable");
      if (stage !== "acceptance") expect(acceptMintBurnSupplyProof).not.toHaveBeenCalled();
    }
  });
});
