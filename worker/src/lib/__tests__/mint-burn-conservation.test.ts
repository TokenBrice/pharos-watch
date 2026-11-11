import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintBurnAlchemyEndpoint } from "../mint-burn-pipeline/rpc";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { MINT_BURN_CONFIGS } from "../mint-burn-contracts";
import { fetchEvmRpcBatchDetailed } from "../evm-rpc";
import { applyMintBurnRangeSupplyProof, completeMintBurnRangeSupplyProof, getMintBurnConservationRuntimeEntry, getMintBurnRangeProofEligibility, resolveMintBurnRangeProofEligibility, completeMintBurnConservationAudit, fetchConservationBoundaries, getMintBurnConservationEligibility,
  isMintBurnConservationUnsupportedReason, mintBurnConservationCacheKey, mintBurnConservationFingerprint,
  resolveMintBurnConservationEligibility,
  reviewedConservationIdentityKey, validateReviewedConservationEntry,
  persistMintBurnConservation, readMintBurnConservationRecords, validateMintBurnParsedConservation, verifyPersistedMintBurnConservation,
  type ConservationBoundaryEvidence, type ConservationBoundaryRequest, type ConservationEventDef,
  type MintBurnConservationRuntimeEntry,
  type ReviewedConservationEntry } from "../mint-burn-conservation";
import reviewedConservationSidecar from "../mint-burn-conservation-reviewed.json";
import type { AlchemyLogEntry } from "../alchemy-logs";
import type { MintBurnRow } from "../mint-burn-pipeline/types";
import type * as AlchemyLogsModule from "../alchemy-logs";
import { getAlchemyTransactionContextBatchMany } from "../alchemy-logs";
import { classifyBridgeBurnRows, reconcileReviewedSupplyBurns } from "../mint-burn-pipeline/classification";
import { parseMintBurnLogs } from "../mint-burn-pipeline/parse";
import { collectAffectedHours, insertMintBurnRows, persistMintBurnRows, recalcAffectedHours, updateEventClassifications } from "../mint-burn-pipeline/persistence";
import { drainMintBurnMaterializationDebt } from "../mint-burn-pipeline/materialization-debt";
import { mintBurnConfigKey } from "../mint-burn-contract-identity";
import { upsertMintBurnSyncState } from "../mint-burn-pipeline/sync-state";
import { mintBurnScanFingerprint, mintBurnScanCoverageAdmits, readMintBurnScanCoverage,
  type MintBurnScanCoverage } from "../mint-burn-pipeline/scan-coverage";
import { abiWord, reviewedBurnFixture, reviewedFalseBurnEntries } from "./mint-burn-supply-proof.test-support";
import { acceptMintBurnSupplyProof, invalidateMintBurnSupplyProofs, invalidateMintBurnSupplyProofRange,
  invalidateChangedMintBurnSupplyProofConfigs, invalidateConflictingMintBurnSupplyProofs,
  persistMintBurnSupplyProof, type MintBurnSupplyProofEvidence } from "../mint-burn-supply-proofs";
vi.mock("../alchemy-logs", async (importOriginal) => ({
  ...(await importOriginal<typeof AlchemyLogsModule>()),
  getAlchemyTransactionContextBatchMany: vi.fn(),
}));
vi.mock("../evm-rpc", () => ({ fetchEvmRpcBatchDetailed: vi.fn() }));
const rpcMock = vi.mocked(fetchEvmRpcBatchDetailed);
const config = MINT_BURN_CONFIGS.find((item) => item.stablecoinId === "gusd-gemini")!;
const sidecarEntries = reviewedConservationSidecar.entries as unknown as ReviewedConservationEntry[];
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
const headers = [{ number: "0x64", timestamp: "0x3e8", hash: word(10n) },
  { number: "0x66", timestamp: "0x400", hash: word(12n) }];
const fixtures = createLatestSchemaFixtureTracker();
function openDatabase() {
  const fixture = fixtures.open();
  return { ...fixture, read: (columns: string, table = "events") =>
    fixture.sqlite.prepare(`SELECT ${columns} FROM mint_burn_${table}`).get() };
}
afterEach(() => { fixtures.closeAll(); vi.useRealTimers(); });
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
type ReadyBoundary = Extract<ConservationBoundaryEvidence, { status: "ready" }>;
function ready(delta = 1n): ReadyBoundary {
  return { status: "ready", fromBlockHash: headers[0].hash, toBlockHash: headers[1].hash,
    fromTimestamp: 1000, toTimestamp: 1024, fromSupplyRaw: "100", toSupplyRaw: (100n + delta).toString() };
}
function boundaryInput(requests: ConservationBoundaryRequest[] = [{ key: "one", config, fromBlock: 101, toBlock: 102 }]) {
  return { requests, rpcEndpointsByChain: new Map([["ethereum", [mintBurnAlchemyEndpoint("https://rpc.example")]]]),
    budget: { count: 0, limit: 100 }, checkedAt: 1100 };
}
function rpc(delta = 1n) {
  rpcMock.mockResolvedValueOnce({ results: headers, errors: [] })
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
  rpcMock.mockImplementation(async (_chain, calls) => ({
    results: calls.map((call) => call.method === "eth_call" ? word(100n) : generatedHeader(Number(call.params[0]))),
    errors: [],
  }));
}

function changePooledPhase(phase: number, change: (result: NonNullable<Awaited<ReturnType<typeof fetchEvmRpcBatchDetailed>>>) => void) {
  pooledRpc();
  const normal = rpcMock.getMockImplementation()!;
  let pass = 0;
  rpcMock.mockImplementation(async (...args) => {
    const result = (await normal(...args))!;
    if (pass++ === phase) change(result);
    return result;
  });
}

describe("pooled conservation boundaries", () => {
  it("chunks N+1 calls into two POSTs in each of the three phases", async () => {
    pooledRpc();
    const args = { ...boundaryInput(disjointRequests), maxBatchCalls: 3 };
    const result = await fetchConservationBoundaries(args);
    expect([...result.values()].map((item) => item.status)).toEqual(["ready", "ready"]);
    expect(rpcMock.mock.calls.map((call) => call[1].length)).toEqual([3, 1, 3, 1, 3, 1]);
    expect(args.budget.count).toBe(6);
    expect(rpcMock.mock.calls[0][2]).toMatchObject({
      maxRetries: 0, timeoutMs: 15_000,
    });
    expect(rpcMock.mock.calls[0][0]).toBe("ethereum");
    expect(rpcMock.mock.calls[0][2]?.chainRpcs?.get("ethereum")?.endpoints)
      .toEqual(args.rpcEndpointsByChain.get("ethereum"));
  });
  it("deduplicates shared headers but keeps per-request supply reads", async () => {
    pooledRpc();
    const result = await fetchConservationBoundaries(boundaryInput([
      disjointRequests[0], { ...disjointRequests[0], key: "two" },
    ]));
    expect(result.get("one")?.status).toBe("ready");
    expect(result.get("two")?.status).toBe("ready");
    expect(rpcMock.mock.calls.map((call) => call[1].length)).toEqual([2, 4, 2]);
  });
  it.each(["header", "supply", "recheck"])("isolates a per-call %s error to its dependents", async (phase) => {
    changePooledPhase(["header", "supply", "recheck"].indexOf(phase), (result) => {
      result.results[0] = undefined;
      result.errors.push({ index: 0, code: -32000 });
    });
    const result = await fetchConservationBoundaries(boundaryInput(disjointRequests));
    expect(result.get("one")).toEqual({ status: "unavailable", reason: "audit-rpc-unavailable" });
    expect(result.get("two")?.status).toBe("ready");
  });
  it.each(["null", "throw"])("isolates a failed chunk (%s) without losing later chunks", async (kind) => {
    pooledRpc();
    if (kind === "null") rpcMock.mockResolvedValueOnce(null);
    else rpcMock.mockRejectedValueOnce(new Error("timeout"));
    const result = await fetchConservationBoundaries({ ...boundaryInput(disjointRequests), maxBatchCalls: 2 });
    expect(result.get("one")).toEqual({ status: "unavailable", reason: "audit-rpc-unavailable" });
    expect(result.get("two")?.status).toBe("ready");
  });
  it.each(["hash", "number", "timestamp", "malformed", "null"])("isolates recheck %s changes", async (field) => {
    changePooledPhase(2, (result) => {
      result.results[0] = field === "null" ? null : { ...generatedHeader(100),
        ...(field === "hash" ? { hash: word(999n) } : field === "number" ? { number: "0x99" }
          : field === "timestamp" ? { timestamp: "0x999" } : { timestamp: "not-hex" }) };
    });
    const result = await fetchConservationBoundaries(boundaryInput(disjointRequests));
    expect(result.get("one")).toEqual({ status: "unavailable",
      reason: field === "hash" || field === "timestamp" ? "boundary-reorg" : "invalid-boundary-header" });
    expect(result.get("two")?.status).toBe("ready");
  });
  it.each(["header", "recheck"])("retries a null %s on the next admitted endpoint", async (phase) => {
    changePooledPhase(phase === "header" ? 0 : 2, (result) => { result.results[0] = null; });
    const args = boundaryInput();
    const endpoints = [mintBurnAlchemyEndpoint("https://rpc.example"), mintBurnAlchemyEndpoint("https://fallback.example")];
    args.rpcEndpointsByChain.set("ethereum", endpoints);
    const result = await fetchConservationBoundaries(args);
    expect(result.get("one")?.status).toBe("ready");
    const calls = rpcMock.mock.calls;
    expect(calls.map((call) => call[1].length)).toEqual(phase === "header" ? [2, 1, 2, 2] : [2, 2, 2, 1]);
    expect(calls[phase === "header" ? 1 : 3][2]?.chainRpcs?.get("ethereum")?.endpoints).toEqual([endpoints[1]]);
    expect(args.budget.count).toBe(4);
  });
  it("does not retry away a validated boundary identity change", async () => {
    changePooledPhase(2, (result) => { result.results[0] = { ...generatedHeader(100), hash: word(999n) }; });
    const args = boundaryInput();
    args.rpcEndpointsByChain.set("ethereum", [mintBurnAlchemyEndpoint("https://rpc.example"), mintBurnAlchemyEndpoint("https://fallback.example")]);
    const result = await fetchConservationBoundaries(args);
    expect(result.get("one")).toEqual({ status: "unavailable", reason: "boundary-reorg" });
    expect(fetchEvmRpcBatchDetailed).toHaveBeenCalledTimes(3);
  });
  it("marks every dependent of a shared failed block, not unrelated ranges", async () => {
    pooledRpc();
    rpcMock.mockResolvedValueOnce({
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
      const normal = rpcMock.getMockImplementation()!;
      rpcMock.mockImplementation(async (...args) => {
        clock.mockReturnValue(1100);
        return normal(...args);
      });
      const result = await fetchConservationBoundaries({ ...boundaryInput(), deadlineMs: 1100 });
      expect(rpcMock.mock.calls[0][2]?.timeoutMs).toBe(100);
      expect(result.get("one")).toEqual({ status: "unavailable", reason: "audit-budget-or-deadline" });
      expect(fetchEvmRpcBatchDetailed).toHaveBeenCalledTimes(1);
    } finally { clock.mockRestore(); }
  });
  it.each(["resolved", "rejected"])("propagates an in-flight abort after a %s RPC", async (kind) => {
    const controller = new AbortController();
    rpcMock.mockImplementation(async () => {
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
    [{ ...generatedHeader(100), number: "wrong" }, "invalid-boundary-header"],
    [{ ...generatedHeader(100), number: "0x20000000000000" }, "invalid-boundary-header"],
    [{ ...generatedHeader(100), timestamp: "0x0" }, "invalid-boundary-time"],
    [{ ...generatedHeader(100), timestamp: "0x999" }, "invalid-boundary-time"],
    [{ ...generatedHeader(100), hash: word(102n) }, "invalid-boundary-time"],
  ])("rejects invalid initial header %j", async (header, reason) => {
    pooledRpc();
    rpcMock.mockResolvedValueOnce({ results: [header, generatedHeader(102)], errors: [] });
    expect((await fetchConservationBoundaries(boundaryInput())).get("one")).toEqual({ status: "unavailable", reason });
  });
  it("rejects future boundary time and invalid supply words", async () => {
    pooledRpc();
    expect((await fetchConservationBoundaries({ ...boundaryInput(), checkedAt: 1001 })).get("one"))
      .toEqual({ status: "unavailable", reason: "invalid-boundary-time" });
    rpcMock.mockResolvedValueOnce({ results: headers, errors: [] })
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
    const result = await fetchConservationBoundaries({ ...boundaryInput(requests), rpcEndpointsByChain: new Map() });
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
    expect(rpcMock.mock.calls.map((call) => call[1].length)).toEqual([52, 100, 2, 52]);
  });
  it("does not spend another POST on a request whose opening header already failed", async () => {
    rpcMock.mockResolvedValueOnce(null);
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
function auditInput(patch: Partial<Parameters<typeof completeMintBurnConservationAudit>[0]> = {}) {
  return completeMintBurnConservationAudit({ ...input(), ...patch });
}

describe("raw token conservation", () => {
  it("holds only structurally valid reviewed sidecar entries", () => {
    expect(sidecarEntries.flatMap((entry) => validateReviewedConservationEntry(entry))).toEqual([]);
    const admitted = sidecarEntries.find((entry) => entry.stablecoinId === "gusd-gemini")!;
    expect(validateReviewedConservationEntry({ ...admitted, zeroRecipientTransferReverts: false })).toHaveLength(1);
    // OZ v5 `_update` burns on transfer-to-zero: reverts=false is admissible when the burn is paired.
    expect(validateReviewedConservationEntry({ ...admitted, zeroRecipientTransferReverts: false, zeroRecipientTransferBurns: true })).toEqual([]);
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
  it("pins both reviewed OUSD proxy implementations at every audit boundary", () => {
    // An Upgraded(address) event only fails the range that contains it; without a
    // pinned implementation the next governor upgrade would let later ranges verify
    // unreviewed token/vault code as ok. The EIP-1967 slots must pin exactly the
    // implementations the review evidence names.
    const ousd = sidecarEntries.find((entry) => entry.stablecoinId === "ousd-origin-protocol")!;
    const identity = ousd.identity as unknown as {
      proxy?: { implementation?: string };
      vault?: { proxyAddress?: string; implementation?: string };
    };
    const views = new Map((ousd.invariantParams?.boundaryViews ?? []).map((view) => [view.name, view]));
    const token = views.get("tokenImplementation");
    const vault = views.get("vaultImplementation");
    expect(token?.address).toBe(ousd.address);
    expect(token?.call).toEqual({ kind: "eth_getStorageAt", slot: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" });
    expect(token?.expect).toBe(identity.proxy?.implementation);
    expect(vault?.address).toBe(identity.vault?.proxyAddress);
    expect(vault?.call).toEqual({ kind: "eth_getStorageAt", slot: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" });
    expect(vault?.expect).toBe(identity.vault?.implementation);
  });
  it("leaves no configured contract on the generic unreviewed fallback", () => {
    const reviewed = new Set(sidecarEntries.map((entry) =>
      reviewedConservationIdentityKey(entry.chainId, entry.stablecoinId, entry.address, entry.decimals)));
    const unreviewed = MINT_BURN_CONFIGS.filter((item) => !reviewed.has(
      reviewedConservationIdentityKey(item.chain.chainId, item.stablecoinId, item.contractAddress, item.decimals)));
    expect(unreviewed.map((item) => `${item.chain.chainId}:${item.stablecoinId}`)).toEqual([]);
    expect(MINT_BURN_CONFIGS.map((item) => getMintBurnConservationEligibility(item).reason)
      .filter((reason) => reason === "unreviewed-contract-or-event-semantics")).toEqual([]);
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
  it("keeps Tron conservation explicitly unsupported without spending historical-state calls", async () => {
    const tron = MINT_BURN_CONFIGS.find((entry) => entry.chain.chainId === "tron" && entry.stablecoinId === "usdt-tether")!;
    const reason = "tron-historical-state-unavailable";
    expect(isMintBurnConservationUnsupportedReason(reason)).toBe(true);
    expect(getMintBurnConservationEligibility(tron)).toEqual({ supported: false, reason });
    const args = boundaryInput([{ key: "tron", config: tron, fromBlock: tron.startBlock, toBlock: tron.startBlock + 9_999 }]);
    args.rpcEndpointsByChain = new Map([["tron", [mintBurnAlchemyEndpoint("https://rpc.example")]]]);
    expect(await fetchConservationBoundaries(args)).toEqual(new Map());
    expect(args.budget.count).toBe(0);
    expect(fetchEvmRpcBatchDetailed).not.toHaveBeenCalled();
    const record = auditInput({ config: tron, logs: [], boundary: ready(0n) });
    expect(record).toMatchObject({ status: "unsupported", reason, address: tron.contractAddress });
    expect(record).not.toHaveProperty("supplyDeltaRaw");
    expect(record).not.toHaveProperty("residualRaw");
  });
  it("requires checksummed Tron Base58 identities and preserves their case", () => {
    const tron = MINT_BURN_CONFIGS.find((entry) => entry.chain.chainId === "tron" && entry.stablecoinId === "usdt-tether")!;
    const entry = sidecarEntries.find((item) => item.chainId === "tron" && item.stablecoinId === "usdt-tether")!;
    expect(validateReviewedConservationEntry(entry)).toEqual([]);
    for (const address of [entry.address.toLowerCase(), `${entry.address.slice(0, -1)}u`, "0xa614f803b6fd780986a42c78ec9c7f77e6ded13c"]) {
      expect(validateReviewedConservationEntry({ ...entry, address })).toEqual([
        expect.stringContaining("address must be a checksummed Tron Base58 value"),
      ]);
    }
    const key = reviewedConservationIdentityKey("tron", entry.stablecoinId, entry.address, entry.decimals);
    expect(key).toContain(entry.address);
    expect(key).not.toBe(reviewedConservationIdentityKey("tron", entry.stablecoinId, entry.address.toLowerCase(), entry.decimals));
    expect(JSON.parse(mintBurnConservationFingerprint(tron))[3]).toBe(entry.address);
    expect(getMintBurnConservationEligibility({ ...tron, contractAddress: entry.address.toLowerCase() }))
      .toEqual({ supported: false, reason: "unreviewed-contract-or-event-semantics" });
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
    const result = auditInput({ boundary: boundaries.get("one") });
    expect(result).toMatchObject({ status: "ok", mintRaw: "2", burnRaw: "1", supplyDeltaRaw: "1", residualRaw: "0", fromBlock: 100 });
    expect(args.budget.count).toBe(3);
    expect(rpcMock.mock.calls[1][1]).toEqual(headers.map((header) => ({ method: "eth_call",
      params: [{ to: config.contractAddress, data: "0x18160ddd" }, { blockHash: header.hash, requireCanonical: true }] })));
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
    expect(auditInput({ complete: false }).reason).toBe("incomplete-log-range");
    expect((await fetchConservationBoundaries({ ...boundaryInput(), budget: { count: 3, limit: 3 } })).get("one"))
      .toEqual({ status: "unavailable", reason: "audit-budget-or-deadline" });
    expect(fetchEvmRpcBatchDetailed).not.toHaveBeenCalled();
  });
  it("propagates aborts", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(fetchConservationBoundaries({ ...boundaryInput(), signal: controller.signal })).rejects.toThrow();
  });
  it("requires boundary evidence, preserves unsupported status, and rejects incomplete or invalid ranges", () => {
    expect(auditInput({ boundary: undefined }).reason).toBe("boundary-evidence-missing");
    expect(auditInput({ fromBlock: 0 }).reason).toBe("invalid-audit-range");
    expect(auditInput({ config: { ...config, decimals: 99 } }))
      .toMatchObject({ status: "unsupported", reason: "unreviewed-contract-or-event-semantics" });
    expect(auditInput({ boundary: { status: "unavailable", reason: "audit-rpc-unavailable" } }).reason)
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
    const row = { id: `ethereum-${word(20n)}-0`, direction: "mint", amount: 10_000, amount_raw: "1000000" } as MintBurnRow;
    expect(() => validateMintBurnParsedConservation(config, args.logs, 101, 102, [row])).not.toThrow();
    expect(() => validateMintBurnParsedConservation(config, args.logs, 101, 102, [{ ...row, amount: 1 }])).toThrow("amount-or-identity");
    expect(() => validateMintBurnParsedConservation(config, args.logs, 101, 102, [{ ...row, amount_raw: "999999" }])).toThrow("amount-or-identity");
  });
  it("atomically retains a mismatch through unavailable/older attempts until verified pass", async () => {
    const { db } = openDatabase();
    const mismatch = auditInput({ boundary: ready(3n) });
    expect(await persistMintBurnConservation(db, mismatch)).toEqual({ written: true });
    // A rejected write is not a published verdict; callers must see it.
    expect(await persistMintBurnConservation(db, { ...mismatch, status: "unavailable", checkedAt: 1200 }))
      .toEqual({ written: false });
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
    expect(await persistMintBurnConservation(db, pass)).toEqual({ written: true });
    expect(await read()).toEqual(pass);
  });
  it.each(["broken", "{}", '{"status":"mismatch"}'])("repairs invalid cached JSON %s", async (value) => {
    const { db, sqlite } = openDatabase();
    const pass = completeMintBurnConservationAudit(input());
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(pass.key, value, 1000);
    await persistMintBurnConservation(db, pass);
    expect((await readMintBurnConservationRecords(db, [config])).get(pass.key)).toEqual(pass);
  });

  it("readback rejects a corrupt INSERT OR IGNORE survivor and missing row", async () => {
    const { db, sqlite } = openDatabase();
    const expected = { id: "test", stablecoin_id: config.stablecoinId, chain_id: "ethereum", direction: "mint",
      amount: 10_000, block_number: 102, timestamp: 1100 } as MintBurnRow;
    expect(await verifyPersistedMintBurnConservation(db, [expected])).toBe("mismatch");
    sqlite.prepare(`INSERT INTO mint_burn_events (id, stablecoin_id, symbol, chain_id, direction, amount,
      tx_hash, block_number, timestamp, explorer_tx_url) VALUES (?, ?, 'GUSD', 'ethereum', 'mint', ?, 'tx', 102, 1100, '')`)
      .run("test", config.stablecoinId, 9999);
    expect(await verifyPersistedMintBurnConservation(db, [expected])).toBe("mismatch");
    sqlite.prepare("UPDATE mint_burn_events SET amount = 10000 WHERE id = 'test'").run();
    expect(await verifyPersistedMintBurnConservation(db, [expected])).toBe("ok");
    expected.amount_raw = "1000000";
    expect(await verifyPersistedMintBurnConservation(db, [expected])).toBe("mismatch");
    sqlite.prepare("UPDATE mint_burn_events SET amount_raw = ? WHERE id = 'test'").run(expected.amount_raw);
    expect(await verifyPersistedMintBurnConservation(db, [expected])).toBe("ok");
    expect(await verifyPersistedMintBurnConservation(db, [expected], undefined, 0)).toBe("deadline");
    const clock = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(2);
    expect(await verifyPersistedMintBurnConservation(db, [expected], undefined, 1)).toBe("deadline");
    clock.mockRestore();
  });

});

describe("reviewed alternative conservation laws", () => {
  const usdtConfig = MINT_BURN_CONFIGS.find((item) => item.stablecoinId === "usdt-tether")!;
  const ousdConfig = MINT_BURN_CONFIGS.find((item) => item.stablecoinId === "ousd-origin-protocol")!;
  const usdoConfig = MINT_BURN_CONFIGS.find((item) => item.stablecoinId === "usdo-openeden")!;
  const VAULT = "0xe75d77b1865ae93c7eaa3040b038d7aa7bc02f70";
  const USDO_IMPL = BigInt("0x87e3ba929c71c0e28fc1c817d107a888a59c523e");
  const DBF_TOPIC = "0x61e6e66b0d6339b2980aecc6ccc0039736791f0ccde9ed512e789a7fbdd698c6";
  const YIELD_TOPIC = "0x09516ecf4a8a86e59780a9befc6dee948bc9e60a36e3be68d31ea817ee8d2c80";
  const HIGHRES_TOPIC = "0x41645eb819d3011b13f97696a8109d14bfcddfaca7d063ec0564d62a3e257235";
  const LEGACY_TOPIC = "0x99e56f783b536ffacf422d59183ea321dd80dcd6d23daa13023e8afea38c3df1";
  const UPGRADED_TOPIC = "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b";
  const BONUS_TOPIC = "0x4b7ac0698dfdcfd64b5836a7035abedc13637e97b8be52f30736b0644c669ab0";
  const UINT128_MAX = (1n << 128n) - 1n;

  function customLog(topic0: string, topics: string[], dataWords: bigint[], options: {
    address?: string; index?: number; block?: number; transaction?: bigint } = {}): AlchemyLogEntry {
    return { address: options.address ?? usdtConfig.contractAddress, topics: [topic0, ...topics],
      data: `0x${dataWords.map((value) => value.toString(16).padStart(64, "0")).join("")}`,
      blockNumber: `0x${(options.block ?? 102).toString(16)}`, blockHash: word(12n),
      transactionHash: word(options.transaction ?? 20n), transactionIndex: "0x0",
      logIndex: `0x${(options.index ?? 0).toString(16)}`, removed: false };
  }
  function audit(cfg: typeof config, law: MintBurnConservationRuntimeEntry | undefined,
    logs: Array<{ eventDef: ConservationEventDef; logs: AlchemyLogEntry[] }>,
    boundary: ConservationBoundaryEvidence, complete = true) {
    return completeMintBurnConservationAudit({ config: cfg, logs: logs.filter((batch) =>
      cfg.events.includes(batch.eventDef as never)) as never, conservationLogs: logs.filter((batch) =>
      !cfg.events.includes(batch.eventDef as never)),
      fromBlock: 101, toBlock: 102, checkedAt: 1100, complete, boundary, lawFor: () => law });
  }
  function law(token: typeof config, fields: Partial<MintBurnConservationRuntimeEntry>): MintBurnConservationRuntimeEntry {
    return { chainId: "ethereum", stablecoinId: token.stablecoinId, address: token.contractAddress.toLowerCase(),
      decimals: token.decimals, disposition: "admitted", ...fields };
  }
  const usdtLaw = law(usdtConfig, {
    eventSet: "config-events", requiresNotDeprecated: true,
    conservationOnlyEvents: [{ signature: "DestroyedBlackFunds(address,uint256)", topicHash: DBF_TOPIC,
      direction: "burn", role: "sum", amountEncoding: "nth-data-uint256", dataSlot: 1, topicArity: 1 }] });
  const ousdLaw = law(ousdConfig, {
    eventSet: "transfer", invariant: "transfer-plus-vault-yield",
    conservationOnlyEvents: [
      { signature: "YieldDistribution(address,uint256,uint256)", topicHash: YIELD_TOPIC, direction: "mint",
        role: "sum", amountEncoding: "data-minus-data-uint256", dataSlot: 1, secondDataSlot: 2,
        topicArity: 1, emitter: VAULT },
      { signature: "TotalSupplyUpdatedHighres(uint256,uint256,uint256)", topicHash: HIGHRES_TOPIC, role: "guard", topicArity: 1 },
      { signature: "TotalSupplyUpdated(uint256,uint256,uint256)", topicHash: LEGACY_TOPIC, role: "guard", topicArity: 1 },
      { signature: "Upgraded(address)", topicHash: UPGRADED_TOPIC, role: "guard", topicArity: 2 },
      { signature: "Upgraded(address)", topicHash: UPGRADED_TOPIC, role: "guard", topicArity:2, emitter: VAULT },
    ],
    invariantParams: { boundaryViews: [
      { name: "vaultAddress", address: ousdConfig.contractAddress, call: { kind: "eth_call", selector: "0x430bf08a" }, expect: VAULT },
      { name: "oToken", address: VAULT, call: { kind: "eth_call", selector: "0x1a32aad6" }, expect: ousdConfig.contractAddress },
    ] } });
  const usdoLaw = law(usdoConfig, {
    eventSet: "transfer", invariant: "usdo-bonus-multiplier-shares",
    conservationOnlyEvents: [
      { signature: "BonusMultiplier(uint256)", topicHash: BONUS_TOPIC, role: "guard", topicArity: 2 },
      { signature: "Upgraded(address)", topicHash: UPGRADED_TOPIC, role: "guard", topicArity: 2 },
    ],
    invariantParams: { supplySelector: "0x3a98ef39", boundaryViews: [
      { name: "bonusMultiplier", address: usdoConfig.contractAddress, call: { kind: "eth_call", selector: "0xa8b973a1" } },
      { name: "totalSupply", address: usdoConfig.contractAddress, call: { kind: "eth_call", selector: "0x18160ddd" } },
      { name: "implementation", address: usdoConfig.contractAddress,
        call: { kind: "eth_getStorageAt", slot: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" },
        expect: `0x${USDO_IMPL.toString(16)}` },
    ] } });

  it("admits config-events laws only for custom-events adapters with summed mint and burn defs", () => {
    expect(getMintBurnConservationEligibility(usdtConfig)).toEqual({ supported: true });
    expect(resolveMintBurnConservationEligibility(usdtLaw, usdtConfig)).toEqual({ supported: true });
    expect(resolveMintBurnConservationEligibility(usdtLaw, { ...usdtConfig, adapterKind: "mixed" }).supported).toBe(false);
    expect(resolveMintBurnConservationEligibility({ ...usdtLaw, eventSet: "transfer" }, usdtConfig).supported).toBe(false);
    // A summed burn may come from the sidecar def; dropping it leaves the law without burn coverage.
    expect(resolveMintBurnConservationEligibility(usdtLaw, { ...usdtConfig, events: [usdtConfig.events[0]!] }).supported).toBe(true);
    expect(resolveMintBurnConservationEligibility({ ...usdtLaw, conservationOnlyEvents: [] },
      { ...usdtConfig, events: [usdtConfig.events[0]!] }).supported).toBe(false);
    expect(resolveMintBurnConservationEligibility(ousdLaw, ousdConfig)).toEqual({ supported: true });
    expect(resolveMintBurnConservationEligibility(usdoLaw, usdoConfig)).toEqual({ supported: true });
    expect(resolveMintBurnConservationEligibility(ousdLaw, { ...ousdConfig, adapterKind: "custom-events" }).supported).toBe(false);
  });

  it("sums USDT config events plus DestroyedBlackFunds exactly and skips zero amounts", () => {
    const issue = customLog(usdtConfig.events[0]!.topicHash, [], [5n], { index: 0 });
    const redeem = customLog(usdtConfig.events[1]!.topicHash, [], [2n], { index: 1 });
    const destroyed = customLog(DBF_TOPIC, [], [0xdac17f958n, 3n], { index: 2 });
    const zeroDestroyed = customLog(DBF_TOPIC, [], [0xdac17f958n, 0n], { index: 3 });
    const boundary: ConservationBoundaryEvidence = { ...ready(0n), deprecated: { from: false, to: false } };
    const result = audit(usdtConfig, usdtLaw, [
      { eventDef: usdtConfig.events[0]!, logs: [issue] }, { eventDef: usdtConfig.events[1]!, logs: [redeem] },
      { eventDef: usdtLaw.conservationOnlyEvents![0]!, logs: [destroyed, zeroDestroyed] },
    ], boundary);
    expect(result).toMatchObject({ status: "ok", mintRaw: "5", burnRaw: "5", supplyDeltaRaw: "0", residualRaw: "0", logCount: 3 });
  });

  it("detects a removed DestroyedBlackFunds event as a mismatch and fails closed on the deprecated guard", () => {
    const issue = customLog(usdtConfig.events[0]!.topicHash, [], [5n]);
    const destroyed = customLog(DBF_TOPIC, [], [0xdac17f958n, 3n], { index: 1 });
    const def = usdtLaw.conservationOnlyEvents![0]!;
    const boundary: ConservationBoundaryEvidence = { ...ready(2n), deprecated: { from: false, to: false } };
    const batches = [{ eventDef: usdtConfig.events[0]!, logs: [issue] }, { eventDef: def, logs: [destroyed] }];
    expect(audit(usdtConfig, usdtLaw, batches, boundary))
      .toMatchObject({ status: "ok", mintRaw: "5", burnRaw: "3", residualRaw: "0" });
    // Dropping the DestroyedBlackFunds log leaves its supply decrease unexplained.
    expect(audit(usdtConfig, usdtLaw, batches.filter((batch) => batch.eventDef !== def), boundary))
      .toMatchObject({ status: "mismatch", burnRaw: "0", residualRaw: "3" });
    expect(audit(usdtConfig, usdtLaw, batches, { ...boundary, deprecated: { from: true, to: false } }))
      .toMatchObject({ status: "unsupported", reason: "deprecated-upgrade-forwarding" });
    expect(audit(usdtConfig, usdtLaw, batches, ready(2n))).toMatchObject({ reason: "invariant-view-missing" });
  });

  it("validates custom raw-log shape: arity, exact data words, topic0", () => {
    const issue = customLog(usdtConfig.events[0]!.topicHash, [], [5n]);
    const boundary: ConservationBoundaryEvidence = { ...ready(0n), deprecated: { from: false, to: false } };
    const def = usdtLaw.conservationOnlyEvents![0]!;
    const cases = [
      customLog(DBF_TOPIC, [word(1n)], [0n, 3n]),
      customLog(DBF_TOPIC, [], [3n]),
      { ...customLog(DBF_TOPIC, [], [0n, 3n]), data: "0x123" },
      customLog(UPGRADED_TOPIC, [], [0n, 3n]),
    ];
    for (const [index, log] of cases.entries()) {
      expect(audit(usdtConfig, usdtLaw, [{ eventDef: usdtConfig.events[0]!, logs: [issue] },
        { eventDef: def, logs: [{ ...log, transactionHash: word(BigInt(40 + index)) }] }], boundary).reason)
        .toBe("invalid-raw-log");
    }
  });

  function ousdViews() {
    const value = { vaultAddress: word(BigInt(VAULT)), oToken: word(BigInt(ousdConfig.contractAddress)) };
    return { from: { ...value }, to: { ...value } };
  }
  it("adds the vault yield net of fee to the OUSD transfer law and detects omissions", () => {
    const mint = { ...log("mint", 10n), address: ousdConfig.contractAddress };
    const burn = { ...log("burn", 1n, 1), address: ousdConfig.contractAddress };
    const yieldLog = customLog(YIELD_TOPIC, [], [7n, 6n, 2n], { address: VAULT, index: 5, transaction: 30n });
    const highres = customLog(HIGHRES_TOPIC, [], [15n, 1n, 1n], { address: ousdConfig.contractAddress, index: 6, transaction: 30n });
    const views = ousdViews();
    const boundary: ConservationBoundaryEvidence = { ...ready(13n), views };
    const batches = [
      { eventDef: ousdConfig.events[0]!, logs: [mint] }, { eventDef: ousdConfig.events[1]!, logs: [burn] },
      { eventDef: ousdLaw.conservationOnlyEvents![0]!, logs: [yieldLog] },
      { eventDef: ousdLaw.conservationOnlyEvents![1]!, logs: [highres] },
    ];
    expect(audit(ousdConfig, ousdLaw, batches, boundary))
      .toMatchObject({ status: "ok", mintRaw: "14", burnRaw: "1", supplyDeltaRaw: "13", residualRaw: "0", logCount: 3 });
    expect(audit(ousdConfig, ousdLaw, batches.filter((batch) => batch.eventDef !== ousdLaw.conservationOnlyEvents![0]), boundary))
      .toMatchObject({ status: "mismatch", residualRaw: "-4" });
  });

  it("fails the OUSD law closed on saturation, pairing, legacy, upgrade and identity guards", () => {
    const mint = { ...log("mint", 10n), address: ousdConfig.contractAddress };
    const yieldLog = customLog(YIELD_TOPIC, [], [7n, 6n, 2n], { address: VAULT, index: 5, transaction: 30n });
    const highres = (newSupply: bigint) => customLog(HIGHRES_TOPIC, [], [newSupply, 1n, 1n], { address: ousdConfig.contractAddress, index: 6, transaction: 30n });
    const views = ousdViews();
    const boundary: ReadyBoundary = { ...ready(14n), views };
    const batches = (highresLog: bigint, extra: Array<{ eventDef: unknown; logs: AlchemyLogEntry[] }> = []) => ([
      { eventDef: ousdConfig.events[0]!, logs: [mint] },
      { eventDef: ousdLaw.conservationOnlyEvents![0]!, logs: [yieldLog] },
      { eventDef: ousdLaw.conservationOnlyEvents![1]!, logs: [highres(highresLog)] },
      ...extra,
    ] as never);
    expect(audit(ousdConfig, ousdLaw, batches(15n), boundary)).toMatchObject({ status: "ok" });
    expect(audit(ousdConfig, ousdLaw, batches(UINT128_MAX), boundary)).toMatchObject({ reason: "rebase-supply-saturation" });
    expect(audit(ousdConfig, ousdLaw, ([
      { eventDef: ousdConfig.events[0]!, logs: [mint] },
      { eventDef: ousdLaw.conservationOnlyEvents![0]!, logs: [yieldLog] },
    ] as never), boundary)).toMatchObject({ reason: "vault-yield-rebase-pairing-failed" });
    expect(audit(ousdConfig, ousdLaw, batches(15n, [{ eventDef: ousdLaw.conservationOnlyEvents![3]!,
      logs: [customLog(UPGRADED_TOPIC, [word(1n)], [], { address: ousdConfig.contractAddress, index: 7 })] }]), boundary))
      .toMatchObject({ reason: "proxy-upgraded-in-range" });
    expect(audit(ousdConfig, ousdLaw, batches(15n, [{ eventDef: ousdLaw.conservationOnlyEvents![2]!,
      logs: [customLog(LEGACY_TOPIC, [], [1n, 1n, 1n], { address: ousdConfig.contractAddress, index: 7 })] }]), boundary))
      .toMatchObject({ reason: "legacy-total-supply-updated-encountered" });
    expect(audit(ousdConfig, ousdLaw, batches(15n), { ...boundary,
      views: { from: { ...views.from, vaultAddress: word(1n) }, to: views.to } }))
      .toMatchObject({ reason: "invariant-view-mismatch" });
    expect(audit(ousdConfig, ousdLaw, batches(15n), { ...ready(14n) })).toMatchObject({ reason: "invariant-view-missing" });
    // yield <= fee is malformed for the reviewed vault flow
    expect(audit(ousdConfig, ousdLaw, ([
      { eventDef: ousdConfig.events[0]!, logs: [mint] },
      { eventDef: ousdLaw.conservationOnlyEvents![0]!, logs: [customLog(YIELD_TOPIC, [], [7n, 2n, 2n], { address: VAULT, index: 5, transaction: 30n })] },
      { eventDef: ousdLaw.conservationOnlyEvents![1]!, logs: [highres(15n)] },
    ] as never), boundary).reason).toBe("invalid-raw-log");
  });

  it("replays USDO share conversion through ordered BonusMultiplier events", () => {
    const scale = 10n ** 18n;
    const mint = { ...log("mint", 2n * scale), address: usdoConfig.contractAddress };
    const bonus = customLog(BONUS_TOPIC, [word(2n * scale)], [], { address: usdoConfig.contractAddress, index: 1 });
    const burn = { ...log("burn", scale, 2), address: usdoConfig.contractAddress };
    const views = (closingMultiplier: bigint, fromSupply: bigint, toSupply: bigint) => ({
      from: { bonusMultiplier: word(scale), totalSupply: word(fromSupply), implementation: word(USDO_IMPL) },
      to: { bonusMultiplier: word(closingMultiplier), totalSupply: word(toSupply), implementation: word(USDO_IMPL) },
    });
    // Opening 1000e18 shares at M=1e18, closing 1001.5e18 at M=2e18: +2e18 minted, -0.5e18 burned.
    const boundary: ReadyBoundary = { ...ready(1n), fromSupplyRaw: (1000n * scale).toString(),
      toSupplyRaw: (1001n * scale + scale / 2n).toString(), views: views(2n * scale, 1000n * scale, 2003n * scale) };
    const batches = [
      { eventDef: usdoConfig.events[0]!, logs: [mint] }, { eventDef: usdoConfig.events[1]!, logs: [burn] },
      { eventDef: usdoLaw.conservationOnlyEvents![0]!, logs: [bonus] },
    ];
    expect(audit(usdoConfig, usdoLaw, batches, boundary)).toMatchObject({ status: "ok",
      mintRaw: (2n * scale).toString(), burnRaw: (scale / 2n).toString(),
      supplyDeltaRaw: (scale + scale / 2n).toString(), residualRaw: "0", logCount: 2, units: "raw-shares" });
    expect(audit(usdoConfig, usdoLaw, batches, { ...boundary,
      views: views(3n * scale, 1000n * scale, 3003n * scale) }))
      .toMatchObject({ reason: "multiplier-replay-mismatch" });
    expect(audit(usdoConfig, usdoLaw, batches.filter((batch) => batch.eventDef !== usdoLaw.conservationOnlyEvents![0]), boundary))
      .toMatchObject({ reason: "multiplier-replay-mismatch" });
    expect(audit(usdoConfig, usdoLaw, batches, { ...boundary,
      views: { from: { ...views(2n * scale, 1000n * scale, 2003n * scale).from, implementation: word(1n) },
        to: views(2n * scale, 1000n * scale, 2003n * scale).to } }))
      .toMatchObject({ reason: "invariant-view-mismatch" });
    expect(audit(usdoConfig, usdoLaw, batches, { ...boundary, views: views(2n * scale, 1000n * scale, 2002n * scale) }))
      .toMatchObject({ reason: "totalSupply-view-mismatch" });
    expect(audit(usdoConfig, usdoLaw, batches.filter((batch) => batch.eventDef !== usdoConfig.events[1]!), boundary))
      .toMatchObject({ status: "mismatch", residualRaw: (scale / 2n).toString() });
  });

  it("reads law-specific boundary views, supply selectors and the deprecated flag in the pre-pass", async () => {
    rpcMock.mockImplementation(async (_chain, calls) => ({
      results: calls.map((call) => {
        if (call.method === "eth_getBlockByNumber") return generatedHeader(Number(call.params[0]));
        if (call.method === "eth_getStorageAt") return word(USDO_IMPL);
        const data = (call.params as Array<{ data?: string }>)[0]?.data ?? "";
        if (data === "0x0e136b19") return word(0n);
        if (data === "0x3a98ef39") return word(1000n);
        if (data === "0xa8b973a1") return word(10n ** 18n);
        if (data === "0x1a32aad6") return word(BigInt(ousdConfig.contractAddress));
        return word(100n);
      }),
      errors: [],
    }));
    const boundaries = await fetchConservationBoundaries({ requests: [
      { key: "usdt", config: usdtConfig, fromBlock: 101, toBlock: 102 },
      { key: "ousd", config: ousdConfig, fromBlock: 101, toBlock: 102 },
      { key: "usdo", config: usdoConfig, fromBlock: 101, toBlock: 102 },
    ], rpcEndpointsByChain: new Map([["ethereum", [mintBurnAlchemyEndpoint("https://rpc.example")]]]), budget: { count: 0, limit: 100 }, checkedAt: 2000 });
    const pinnedCalls = rpcMock.mock.calls
      .flatMap(([, calls]) => calls.filter((call) => call.method !== "eth_getBlockByNumber"));
    expect(pinnedCalls.some((call) => call.method === "eth_call" &&
      (call.params as Array<{ data?: string }>)[0]?.data === "0x0e136b19")).toBe(true);
    expect(pinnedCalls.some((call) => call.method === "eth_getStorageAt")).toBe(true);
    expect(pinnedCalls.filter((call) => (call.params as Array<{ data?: string }>)[0]?.data === "0x3a98ef39")).toHaveLength(2);
    expect(boundaries.get("usdt")).toMatchObject({ status: "ready", deprecated: { from: false, to: false } });
    expect(boundaries.get("ousd")).toMatchObject({ status: "ready" });
    expect(boundaries.get("usdo")).toMatchObject({ status: "ready", fromSupplyRaw: "1000", toSupplyRaw: "1000" });
  });

  it("keeps the plain Transfer fingerprint byte-identical and extends it only for law entries", () => {
    expect(JSON.parse(mintBurnConservationFingerprint(config))).toHaveLength(9);
    const usdt = JSON.parse(mintBurnConservationFingerprint(usdtConfig));
    expect(usdt).toHaveLength(10);
    expect(usdt[9]).toEqual([["eventSet", "config-events"], ["requiresNotDeprecated", true],
      ["conservationOnlyEvents", [["DestroyedBlackFunds(address,uint256)", DBF_TOPIC, "sum", "burn",
        "nth-data-uint256", 1, null, 1, null, null, null]]]]);
    expect(JSON.parse(mintBurnConservationFingerprint(ousdConfig))[9].some((part: unknown[]) => part[0] === "invariant")).toBe(true);
    expect(JSON.parse(mintBurnConservationFingerprint(usdoConfig))[9].some((part: unknown[]) => part[0] === "invariantParams")).toBe(true);
  });

  it("enforces sidecar structural rules for the law fields", () => {
    const base: ReviewedConservationEntry = { chainId: "ethereum", stablecoinId: "test-law",
      address: usdtConfig.contractAddress.toLowerCase(), decimals: 6, disposition: "admitted",
      unpairedPaths: [], totalSupplyView: { isStoredSum: true },
      identity: { sourceVerified: true, onChain: { decimals: 6 },
        externalMatches: [{ source: "coingecko", value: usdtConfig.contractAddress }] },
      windows: [{ fromBlock: 1, fromBlockHash: word(1n), fromTimestamp: 10, toBlock: 2, toBlockHash: word(2n),
        toTimestamp: 20, mintRaw: "0", burnRaw: "0", supplyDeltaRaw: "0", residualRaw: "0", logCount: 0, journalSha256: "x" }] };
    const guard = (topicHash = DBF_TOPIC) => ({ signature: "A()", topicHash, role: "guard" as const, topicArity: 1 });
    const bonusGuard = { signature: "BonusMultiplier(uint256)", topicHash: BONUS_TOPIC, role: "guard" as const, topicArity: 2 };
    const invalid: [Partial<ReviewedConservationEntry>, string][] = [
      [{ invariant: "made-up-invariant" }, "invariant must be"],
      [{ invariant: "usdo-bonus-multiplier-shares" }, "BonusMultiplier"],
      [{ invariant: "transfer-plus-vault-yield" }, "emitter"],
      [{ conservationOnlyEvents: [guard(), { ...guard(), signature: "A2()" }] }, "duplicates"],
      [{ invariantParams: { supplySelector: "0x123" } }, "supplySelector"],
      [{ invariantParams: { boundaryViews: [
        { name: "x", address: "0xbad", call: { kind: "eth_call", selector: "0x430bf08a" } },
      ] } }, "address"],
    ];
    for (const [patch, message] of invalid) {
      expect(validateReviewedConservationEntry({ ...base, ...patch })[0]).toContain(message);
    }
    for (const patch of [{}, { eventSet: "config-events" as const, zeroRecipientTransferReverts: false },
      { invariant: "usdo-bonus-multiplier-shares", conservationOnlyEvents: [bonusGuard], totalSupplyView: { isStoredSum: false } }]) {
      expect(validateReviewedConservationEntry({ ...base, ...patch })).toEqual([]);
    }
    expect(validateReviewedConservationEntry({ ...base, zeroRecipientTransferReverts: false })).toHaveLength(1);
    const problems = validateReviewedConservationEntry({ ...base, conservationOnlyEvents: [
      { signature: "A(address,uint256)", topicHash: "0x123", direction: "burn", role: "sum", amountEncoding: "nth-data-uint256", topicArity: 1 },
      { signature: "B()", topicHash: DBF_TOPIC, direction: "mint", role: "sum", amountEncoding: "first-data-uint256", topicArity: 1 },
      { signature: "C()", topicHash: LEGACY_TOPIC, role: "guard", topicArity: 5 },
    ] });
    for (const field of ["topicHash", "dataSlot", "topicArity"]) expect(problems.some((problem) => problem.includes(field))).toBe(true);
  });
});

type BurnFixture = ReturnType<typeof reviewedBurnFixture>;
function burnContext(fixture: BurnFixture, actualBurn: boolean, txHash: string) {
  const context = fixture.context(actualBurn);
  context.tx!.hash = context.receipt!.transactionHash = txHash;
  context.receipt!.logs = context.receipt!.logs.map((item) => ({ ...item, transactionHash: txHash }));
  return context;
}
function burnRow(fixture: BurnFixture, logs = [fixture.log]) {
  return parseMintBurnLogs(fixture.config, fixture.eventDef, logs, fixture.timestamps, fixture.priceContext).rows[0];
}

describe("reviewed burn economic materialization", () => {
  function rangeFixture() {
    vi.useFakeTimers();
    const fixture = reviewedBurnFixture("dai-makerdao");
    const row = burnRow(fixture);
    vi.setSystemTime(row.timestamp * 1000);
    const proof: MintBurnSupplyProofEvidence = {
      proofId: "proof-one", configKey: mintBurnConfigKey(fixture.config), configFingerprint: "current", lawRevision: "paired-supply-zero-transfers-v1",
      chainId: row.chain_id, stablecoinId: row.stablecoin_id, tokenAddress: fixture.config.contractAddress,
      decimals: fixture.config.decimals, fromBlock: row.block_number, toBlock: row.block_number,
      openingBlock: row.block_number - 1, closingBlock: row.block_number,
      openingHash: word(10n), closingHash: fixture.log.blockHash, openingSupplyRaw: "100000000000000000000000",
      closingSupplyRaw: "80000000000000000000000", mintRaw: "0", zeroRaw: "20000000000000000000000",
      deltaRaw: "-20000000000000000000000", residualRaw: "0", eventSetDigest: "digest", mintEvidence: "source-only",
      status: "proven", checkedAt: 1_700_000_000,
      members: [{ id: row.id, direction: row.direction, amountRaw: "20000000000000000000000",
        blockNumber: row.block_number, blockHash: fixture.log.blockHash }],
    };
    const proven: MintBurnRow = { ...row, supply_proof_id: proof.proofId, amount_raw: proof.members[0].amountRaw,
      burn_type: "effective_burn", burn_review_reason: "range-supply-destruction", amount_usd: 20_000 };
    return { row, proven, proof };
  }
  async function stagedRange() {
    const data = { ...openDatabase(), ...rangeFixture() };
    await persistMintBurnSupplyProof(data.db, data.proof);
    await persistMintBurnRows(data.db, [data.proven]);
    return data;
  }

  it("keeps pending proof chunks unresolved, then accepts them with debt and preserves proof on receipt-only replay", async () => {
    const { db, sqlite, read, row, proven, proof } = await stagedRange();
    await recalcAffectedHours(db, collectAffectedHours([proven]));
    expect(read("burn_count, burn_unresolved_event_count", "hourly"))
      .toEqual({ burn_count: 0, burn_unresolved_event_count: 1 });
    expect(await acceptMintBurnSupplyProof(db, proof, [proven])).toBe(true);
    expect(read("COUNT(*) AS n", "dirty_hours")).toEqual({ n: 1 });
    sqlite.exec(`CREATE TRIGGER refuse_proof_rebuild BEFORE INSERT ON mint_burn_hourly
      BEGIN SELECT RAISE(ABORT, 'refused proof rebuild'); END`);
    await expect(drainMintBurnMaterializationDebt(db)).rejects.toThrow("refused proof rebuild");
    expect(read("COUNT(*) AS n", "dirty_hours")).toEqual({ n: 1 });
    sqlite.exec("DROP TRIGGER refuse_proof_rebuild");
    await drainMintBurnMaterializationDebt(db);
    await persistMintBurnRows(db, [{ ...row, burn_review_reason: "supply-proof-context-unavailable" }]);
    expect(read("supply_proof_id, amount_raw, burn_type, burn_review_reason"))
      .toEqual({ supply_proof_id: proof.proofId, amount_raw: proven.amount_raw,
        burn_type: "effective_burn", burn_review_reason: "range-supply-destruction" });
    expect(read("burn_count, burn_unresolved_event_count", "hourly"))
      .toEqual({ burn_count: 1, burn_unresolved_event_count: 0 });
  });

  it("invalidates changed config proofs, dirties their hours, and cannot reactivate the old evidence", async () => {
    const { db, read, proven, proof } = await stagedRange();
    await acceptMintBurnSupplyProof(db, proof, [proven]);
    await drainMintBurnMaterializationDebt(db);
    expect(await invalidateMintBurnSupplyProofs(db, proof.configKey, proof.configFingerprint)).toBe(0);
    expect(await invalidateMintBurnSupplyProofs(db, proof.configKey, "changed-law")).toBe(1);
    expect(read("burn_type, burn_review_reason"))
      .toEqual({ burn_type: "review_required", burn_review_reason: "range-supply-proof-config-changed" });
    expect(read("COUNT(*) AS n", "dirty_hours")).toEqual({ n: 1 });
    expect(await acceptMintBurnSupplyProof(db, proof, [proven])).toBe(false);
    await drainMintBurnMaterializationDebt(db);
    expect(read("burn_count, burn_unresolved_event_count", "hourly"))
      .toEqual({ burn_count: 0, burn_unresolved_event_count: 1 });
  });

  it("invalidates removed or changed configs against the full registry while preserving another lane", async () => {
    const { db, sqlite, read, proof } = await stagedRange();
    const removed = { ...proof, proofId: "removed-proof", configKey: "removed-config" };
    const otherLane = { ...proof, proofId: "other-lane-proof", configKey: "other-lane-config" };
    await persistMintBurnSupplyProof(db, removed);
    await persistMintBurnSupplyProof(db, otherLane);
    expect(await invalidateChangedMintBurnSupplyProofConfigs(db,
      new Map([[proof.configKey, "changed"], [otherLane.configKey, otherLane.configFingerprint]]))).toBe(2);
    expect(sqlite.prepare("SELECT lifecycle FROM mint_burn_supply_proofs WHERE proof_id = ?").get(otherLane.proofId))
      .toEqual({ lifecycle: "pending" });
    expect(sqlite.prepare("SELECT invalidation_reason FROM mint_burn_supply_proofs WHERE proof_id = ?").get(removed.proofId))
      .toEqual({ invalidation_reason: "range-supply-proof-config-removed" });
    expect(read("COUNT(*) AS n", "dirty_hours")).toEqual({ n: 1 });
  });

  it.each([false, true])("retires expired scan spans without rebuilding partial raw (%s)", async (partial) => {
    const { db, sqlite, read, proven, proof } = await stagedRange();
    await acceptMintBurnSupplyProof(db, proof, [proven]);
    await drainMintBurnMaterializationDebt(db);
    const token = MINT_BURN_CONFIGS.find((item) => item.stablecoinId === proof.stablecoinId)!;
    const fromTimestamp = Math.floor(proven.timestamp / 3600) * 3600;
    const scan: MintBurnScanCoverage = { configKey: proof.configKey, configFingerprint: mintBurnScanFingerprint(token),
      chainId: token.chain.chainId, fromBlock: proof.fromBlock, toBlock: proof.toBlock,
      fromTimestamp, toTimestamp: fromTimestamp + 3600, finalizedBlock: proof.toBlock, acceptedAt: fromTimestamp + 3700 };
    const admitted = async () => mintBurnScanCoverageAdmits([token],
      await readMintBurnScanCoverage(db, [token], fromTimestamp, scan.toTimestamp), fromTimestamp, scan.toTimestamp);
    await upsertMintBurnSyncState(db, scan.configKey, scan.toBlock, "monotonic-max", scan);
    expect(await admitted()).toBe(true);
    vi.setSystemTime((proof.checkedAt + 10 * 86400) * 1000);
    if (partial) sqlite.exec("UPDATE mint_burn_hourly SET burn_count = 2, net_flow_usd = -40000");
    else sqlite.exec("DELETE FROM mint_burn_events; DELETE FROM mint_burn_supply_proofs");
    expect(await (partial ? invalidateMintBurnSupplyProofRange(db, proof.configKey, proof.fromBlock, proof.toBlock,
      "boundary-reorg", proof.checkedAt) : invalidateChangedMintBurnSupplyProofConfigs(db,
      new Map([[proof.configKey, "new-law"]])))).toBe(1);
    expect(await admitted()).toBe(false);
    expect(read("COUNT(*) AS n", "dirty_hours")).toEqual({ n: 0 });
    expect(read("burn_count, net_flow_usd", "hourly"))
      .toEqual({ burn_count: partial ? 2 : 1, net_flow_usd: partial ? -40_000 : -20_000 });
    await upsertMintBurnSyncState(db, scan.configKey, scan.toBlock, "monotonic-max", scan);
    expect(await admitted()).toBe(true);
    expect(await invalidateMintBurnSupplyProofRange(db, proof.configKey, proof.fromBlock, proof.toBlock,
      "boundary-reorg", Math.floor(Date.now() / 1000))).toBe(1);
    expect(await admitted()).toBe(false);
    expect(await invalidateChangedMintBurnSupplyProofConfigs(db, new Map())).toBe(1);
    expect(read("config_fingerprint", "supply_proof_configs"))
      .toEqual({ config_fingerprint: "removed" });
  });

  it("fences proof acceptance atomically when debt enqueue fails and refuses immutable evidence changes", async () => {
    const { db, sqlite, read, proven, proof } = await stagedRange();
    sqlite.prepare("UPDATE mint_burn_supply_proof_configs SET config_fingerprint = 'racing-law'").run();
    expect(await acceptMintBurnSupplyProof(db, proof, [proven])).toBe(false);
    sqlite.prepare("UPDATE mint_burn_supply_proof_configs SET config_fingerprint = ?").run(proof.configFingerprint);
    sqlite.exec("DELETE FROM mint_burn_dirty_hours");
    sqlite.exec(`CREATE TRIGGER refuse_proof_debt BEFORE INSERT ON mint_burn_dirty_hours
      BEGIN SELECT RAISE(ABORT, 'refused proof debt'); END`);
    await expect(acceptMintBurnSupplyProof(db, proof, [proven])).rejects.toThrow("refused proof debt");
    expect(read("lifecycle", "supply_proofs")).toEqual({ lifecycle: "pending" });
    await expect(persistMintBurnSupplyProof(db, { ...proof, residualRaw: "1" }))
      .rejects.toThrow("supply-proof-immutable-evidence-mismatch");
  });

  it("invalidates only proofs overlapping reorg evidence and preserves economic exclusions", async () => {
    const { db, read } = openDatabase();
    const { proven, proof } = rangeFixture();
    proven.flow_type = "bridge_transfer";
    proven.burn_type = "bridge_burn";
    await persistMintBurnSupplyProof(db, proof);
    await persistMintBurnRows(db, [proven]);
    await acceptMintBurnSupplyProof(db, proof, [proven]);
    expect(await invalidateMintBurnSupplyProofRange(db, proof.configKey, proof.toBlock + 1, proof.toBlock + 2,
      "boundary-reorg", proof.checkedAt)).toBe(0);
    expect(await invalidateMintBurnSupplyProofRange(db, proof.configKey, proof.fromBlock, proof.toBlock,
      "boundary-reorg", proof.checkedAt)).toBe(1);
    expect(read("flow_type")).toEqual({ flow_type: "bridge_transfer" });
  });

  it.each(["changed-member", "missing-member", "changed-boundary"])("invalidates %s and descendant proof evidence", async (change) => {
    const { db, sqlite, read, proven, proof } = await stagedRange();
    await acceptMintBurnSupplyProof(db, proof, [proven]);
    const descendant: MintBurnSupplyProofEvidence = { ...proof, proofId: "proof-descendant",
      members: [{ ...proof.members[0], id: "descendant", blockNumber: proof.toBlock + 1, blockHash: word(13n) }],
      fromBlock: proof.toBlock + 1, toBlock: proof.toBlock + 2, openingBlock: proof.toBlock,
      closingBlock: proof.toBlock + 2, openingHash: proof.closingHash, closingHash: word(13n) };
    await persistMintBurnSupplyProof(db, descendant);
    const replay: MintBurnSupplyProofEvidence = { ...proof, proofId: "proof-replay", checkedAt: proof.checkedAt + 1,
      ...(change === "missing-member" ? { members: [], eventSetDigest: "empty" }
        : change === "changed-boundary" ? { closingHash: word(99n) }
          : { members: [{ ...proof.members[0], blockHash: word(99n) }] }) };
    expect(await invalidateConflictingMintBurnSupplyProofs(db, replay))
      .toEqual({ invalidated: 2, conflict: true, reason: "range-supply-proof-canonical-conflict" });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM mint_burn_supply_proofs WHERE lifecycle = 'invalidated'").get())
      .toEqual({ n: 2 });
    expect(read("COUNT(*) AS n", "dirty_hours")).toEqual({ n: 1 });
  });

  it("stores no failed or quiet witnesses and accepts an empty proof without rows", async () => {
    const { db, sqlite } = openDatabase();
    const { proof } = rangeFixture();
    for (const status of ["unavailable", "residual"] as const) {
      await persistMintBurnSupplyProof(db, { ...proof, status });
      expect(await acceptMintBurnSupplyProof(db, { ...proof, status }, [])).toBe(false);
    }
    const quiet = { ...proof, members: [], zeroRaw: "0", deltaRaw: "0", closingSupplyRaw: proof.openingSupplyRaw };
    await persistMintBurnSupplyProof(db, quiet);
    expect(await acceptMintBurnSupplyProof(db, quiet, [])).toBe(true);
    expect(sqlite.prepare(`SELECT (SELECT COUNT(*) FROM mint_burn_supply_proofs) AS proofs,
      (SELECT COUNT(*) FROM mint_burn_supply_proof_configs) AS configs`).get()).toEqual({ proofs: 0, configs: 0 });
  });

  it("does not infer disappeared members from an unavailable raw scan and bounds conflict readback", async () => {
    const { db, sqlite } = openDatabase();
    const { proof } = rangeFixture();
    await persistMintBurnSupplyProof(db, proof);
    const unavailable: MintBurnSupplyProofEvidence = { ...proof, proofId: "unavailable", status: "unavailable",
      members: [], eventSetDigest: undefined, openingHash: undefined, closingHash: undefined };
    expect(await invalidateConflictingMintBurnSupplyProofs(db, unavailable)).toEqual({ invalidated: 0, conflict: false });
    const insert = sqlite.prepare(`INSERT INTO mint_burn_supply_proofs
      (proof_id, config_key, config_fingerprint, from_block, to_block, status, evidence_json, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let index = 0; index < 101; index++) {
      insert.run(`identical-proof-${index}`, proof.configKey, proof.configFingerprint,
        proof.fromBlock, proof.toBlock, "proven", JSON.stringify({ ...proof,
          proofId: `identical-proof-${index}`, checkedAt: proof.checkedAt + index }), proof.checkedAt + index);
      insert.run(`unavailable-proof-${index}`, proof.configKey, proof.configFingerprint,
        proof.fromBlock, proof.toBlock, "unavailable", JSON.stringify({ ...unavailable,
          proofId: `unavailable-proof-${index}`, checkedAt: proof.checkedAt + index }), proof.checkedAt + index);
    }
    expect(await invalidateConflictingMintBurnSupplyProofs(db, proof)).toEqual({ invalidated: 0, conflict: false });
    for (let index = 0; index < 100; index++) {
      insert.run(`different-proof-${index}`, proof.configKey, proof.configFingerprint,
        proof.fromBlock, proof.toBlock, "proven", JSON.stringify({ ...proof, eventSetDigest: `digest-${index}` }), proof.checkedAt);
    }
    expect(await invalidateConflictingMintBurnSupplyProofs(db, proof))
      .toEqual({ invalidated: 0, conflict: false, reason: "supply-proof-conflict-check-limit" });
  });

  for (const entry of reviewedFalseBurnEntries) {
    it(`${entry.stablecoinId} counts proven burns only without turning an unsupported raw law into a mismatch`, async () => {
      const fixture = reviewedBurnFixture(entry.stablecoinId);
      const { db, read } = openDatabase();
      const rows: MintBurnRow[] = [];
      for (const actualBurn of [false, true]) {
        const txHash = abiWord(actualBurn ? 21n : 20n);
        const context = burnContext(fixture, actualBurn, txHash);
        const logs = context.receipt!.logs;
        vi.mocked(getAlchemyTransactionContextBatchMany).mockResolvedValueOnce(new Map([[txHash, context]]));
        const parsed = [burnRow(fixture, [logs[0]])];
        await classifyBridgeBurnRows(parsed, fixture.config, [mintBurnAlchemyEndpoint("https://rpc.example")],
          { count: 0, limit: 20 }, new Map());
        parsed[0].amount_usd = 20_000;
        rows.push(...parsed);
      }
      await persistMintBurnRows(db, rows);
      await recalcAffectedHours(db, collectAffectedHours(rows));
      expect(read("burn_count, burn_volume_usd, net_flow_usd", "hourly"))
        .toEqual({ burn_count: 1, burn_volume_usd: 20_000, net_flow_usd: -20_000 });
      expect(read("COUNT(*) AS n")).toEqual({ n: 2 });
      expect(auditInput({ config: fixture.config }))
        .toMatchObject({ status: "unsupported", reason: entry.unsupportedReason });
    });
  }

  it("reconciles retained legacy classifications with durable hourly debt and preserves actual burns", async () => {
    const fixture = reviewedBurnFixture("dai-makerdao");
    const { db, read } = openDatabase();
    const contexts = new Map<string, AlchemyLogsModule.AlchemyTransactionContextBatch>();
    const rows: MintBurnRow[] = [];
    for (const actualBurn of [false, true]) {
      const txHash = abiWord(actualBurn ? 21n : 20n);
      const context = burnContext(fixture, actualBurn, txHash);
      contexts.set(txHash, context);
      const parsed = burnRow(fixture, [context.receipt!.logs[0]]);
      rows.push({ ...parsed, burn_type: "effective_burn", burn_review_reason: null, amount_usd: 20_000 });
    }
    await insertMintBurnRows(db, rows);
    await recalcAffectedHours(db, collectAffectedHours(rows));
    vi.mocked(getAlchemyTransactionContextBatchMany).mockResolvedValueOnce(contexts);
    expect(await reconcileReviewedSupplyBurns(db, fixture.config, [mintBurnAlchemyEndpoint("https://rpc.example")],
      { count: 0, limit: 20 }, new Map(), 1_699_999_200)).toBe(2);
    // A crash here leaves old hourly bytes and recoverable durable debt, not a lost repair.
    expect(read("burn_count", "hourly")).toEqual({ burn_count: 2 });
    expect(read("COUNT(*) AS n", "dirty_hours")).toEqual({ n: 1 });
    await drainMintBurnMaterializationDebt(db);
    expect(read("burn_count, burn_volume_usd", "hourly"))
      .toEqual({ burn_count: 1, burn_volume_usd: 20_000 });
    expect(read("COUNT(*) AS n", "dirty_hours")).toEqual({ n: 0 });
    expect(await reconcileReviewedSupplyBurns(db, fixture.config, [mintBurnAlchemyEndpoint("https://rpc.example")],
      { count: 0, limit: 20 }, new Map(), 1_699_999_200)).toBe(0);
  });

  it("bounds retained reconciliation and makes progress beyond the first batch", async () => {
    const fixture = reviewedBurnFixture("eurs-stasis");
    const { db, sqlite } = openDatabase();
    const contexts = new Map<string, AlchemyLogsModule.AlchemyTransactionContextBatch>();
    const rows: MintBurnRow[] = [];
    for (let index = 0; index < 25; index++) {
      const txHash = abiWord(BigInt(30 + index));
      const context = burnContext(fixture, false, txHash);
      contexts.set(txHash, context);
      const row = burnRow(fixture, context.receipt!.logs);
      rows.push({ ...row, burn_type: "effective_burn", burn_review_reason: null });
    }
    await insertMintBurnRows(db, rows);
    vi.mocked(getAlchemyTransactionContextBatchMany).mockResolvedValue(contexts);
    const run = () => reconcileReviewedSupplyBurns(db, fixture.config, [mintBurnAlchemyEndpoint("https://rpc.example")],
      { count: 0, limit: 20 }, new Map(), 1_699_999_200);
    expect(await run()).toBe(20);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM mint_burn_events WHERE burn_review_reason IS NULL").get()).toEqual({ n: 5 });
    expect(await run()).toBe(5);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM mint_burn_events WHERE burn_type = 'review_required'").get()).toEqual({ n: 25 });
    expect(await run()).toBe(0);
  });

  it("advances past twenty unavailable receipts and wraps without losing retry eligibility", async () => {
    const fixture = reviewedBurnFixture("dai-makerdao");
    const { db, sqlite, read } = openDatabase();
    const rows: MintBurnRow[] = [];
    const contexts = new Map<string, AlchemyLogsModule.AlchemyTransactionContextBatch>();
    for (let index = 0; index < 21; index++) {
      const txHash = abiWord(BigInt(30 + index));
      const context = burnContext(fixture, true, txHash);
      if (index === 20) contexts.set(txHash, context);
      const row = burnRow(fixture, [context.receipt!.logs[0]]);
      rows.push({ ...row, timestamp: row.timestamp + index, burn_type: "review_required",
        burn_review_reason: "supply-proof-context-unavailable" });
    }
    await insertMintBurnRows(db, rows);
    vi.mocked(getAlchemyTransactionContextBatchMany).mockResolvedValue(contexts);
    const run = () => reconcileReviewedSupplyBurns(db, fixture.config, [mintBurnAlchemyEndpoint("https://rpc.example")],
      { count: 0, limit: 20 }, new Map(), 1_699_999_200);
    await run();
    await run();
    expect(sqlite.prepare("SELECT burn_type FROM mint_burn_events WHERE id = ?").get(rows[20].id))
      .toEqual({ burn_type: "effective_burn" });
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM mint_burn_events
      WHERE burn_review_reason = 'supply-proof-context-unavailable'`).get()).toEqual({ n: 20 });
    vi.mocked(getAlchemyTransactionContextBatchMany).mockClear();
    await run();
    expect(getAlchemyTransactionContextBatchMany).toHaveBeenCalled();
    expect(read("COUNT(*) AS n")).toEqual({ n: 21 });
  });

  it("does not reconstruct a partially pruned hour from its surviving raw burn", async () => {
    const fixture = reviewedBurnFixture("dai-makerdao");
    const { db, sqlite, read } = openDatabase();
    const parsed = burnRow(fixture);
    const row: MintBurnRow = { ...parsed, timestamp: 1_699_999_199,
      amount_usd: 20_000, burn_type: "effective_burn", burn_review_reason: null };
    await insertMintBurnRows(db, [row]);
    await recalcAffectedHours(db, collectAffectedHours([row]));
    // The retained aggregate includes an already-pruned sibling.
    sqlite.exec("UPDATE mint_burn_hourly SET burn_count = 2, burn_volume_usd = 45000, net_flow_usd = -45000");
    expect(await reconcileReviewedSupplyBurns(db, fixture.config, [mintBurnAlchemyEndpoint("https://rpc.example")],
      { count: 0, limit: 20 }, new Map(), 1_699_999_200)).toBe(0);
    expect(read("burn_count, burn_volume_usd", "hourly"))
      .toEqual({ burn_count: 2, burn_volume_usd: 45_000 });
    expect(read("COUNT(*) AS n", "dirty_hours")).toEqual({ n: 0 });
    expect(getAlchemyTransactionContextBatchMany).not.toHaveBeenCalled();
  });

  it("rolls back dirty-hour enqueue when its paired classification mutation fails", async () => {
    const fixture = reviewedBurnFixture("dai-makerdao");
    const { db, sqlite, read } = openDatabase();
    const row = burnRow(fixture);
    await insertMintBurnRows(db, [{ ...row, burn_type: "effective_burn", burn_review_reason: null }]);
    await recalcAffectedHours(db, collectAffectedHours([row]));
    sqlite.exec(`CREATE TRIGGER refuse_burn_repair BEFORE UPDATE OF burn_type ON mint_burn_events
      BEGIN SELECT RAISE(ABORT, 'refused repair'); END`);
    await expect(updateEventClassifications(db, [row])).rejects.toThrow("refused repair");
    expect(read("burn_type, burn_review_reason"))
      .toEqual({ burn_type: "effective_burn", burn_review_reason: null });
    expect(read("COUNT(*) AS n", "dirty_hours")).toEqual({ n: 0 });
  });
});

describe("conditional range destruction proofs", () => {
  function sample(id: string, mint: bigint, zero: bigint, delta = mint - zero) {
    const token = MINT_BURN_CONFIGS.find((item) => item.stablecoinId === id)!;
    const logs = [log("mint", mint), log("burn", zero, 1)]
      .filter((item) => BigInt(item.data) > 0n).map((item) => ({ ...item, address: token.contractAddress }));
    const boundary = { ...ready(), fromSupplyRaw: (10n ** 30n).toString(), toSupplyRaw: (10n ** 30n + delta).toString() };
    const guard = getMintBurnConservationRuntimeEntry(token)?.supplyBurnProof?.range?.guard;
    if (guard?.status === "pinned") boundary.views = { from: { rangeImplementation: word(BigInt(guard.expected)) },
      to: { rangeImplementation: word(BigInt(guard.expected)) } };
    return { config: token, logs: token.events.map((eventDef) => ({ eventDef,
      logs: logs.filter((item) => item.topics[eventDef.direction === "mint" ? 1 : 2] === word(0n)) })),
      fromBlock: 101, toBlock: 102, checkedAt: 1100, complete: true, boundary };
  }
  it.each([
    ["dai-makerdao", "23102350376131474782440044", "23035402583576159626989568", "66947792555315155450476"],
    ["usdd-tron-dao-reserve", "175062047919566023590918", "175168687129000000000000", "-106639209433976409082"],
    ["dai-makerdao", "217997446533011548411769173", "230256077730574711853048692", "-12258631197563163441279519"],
    ["usdd-tron-dao-reserve", "884452026740638281846429", "751759459274000000000000", "132692567466638281846429"],
  ])("proves sampled %s raw integers beyond Number precision (%s)", (id, mint, zero, delta) => {
    const proof = completeMintBurnRangeSupplyProof(sample(id, BigInt(mint), BigInt(zero), BigInt(delta)));
    expect(proof).toMatchObject({ status: "proven", mintRaw: mint, zeroRaw: zero, deltaRaw: delta, residualRaw: "0" });
    expect(proof.members).toHaveLength(2);
    expect(proof.eventSetDigest).toMatch(/^[0-9a-f]{64}$/);
  });
  it.each([
    ["dai-makerdao", "1000000000000000000", "17331907050708556709906128"],
    ["usdd-tron-dao-reserve", "750426822258", "4407563319673499500278769"],
  ])("rejects the historical %s false-zero control without tolerance", (id, zero, supply) => {
    const args = sample(id, 0n, BigInt(zero), 0n);
    args.boundary.fromSupplyRaw = supply;
    args.boundary.toSupplyRaw = supply;
    expect(completeMintBurnRangeSupplyProof(args)).toMatchObject({ status: "residual", reason: "false-zero-transfer-residual",
      residualRaw: `-${zero}` });
  });
  it("requires the reviewed family and keeps AUSD ineligible without its dispatch guard", () => {
    for (const token of MINT_BURN_CONFIGS) {
      const eligibility = getMintBurnRangeProofEligibility(token);
      if (eligibility.supported) expect(getMintBurnConservationRuntimeEntry(token)?.unsupportedReason)
        .toMatch(/^zero-address-transfer-without-supply-change:/);
    }
    expect(getMintBurnRangeProofEligibility(MINT_BURN_CONFIGS.find((item) => item.stablecoinId === "ausd-agora")!).supported).toBe(false);
    expect(getMintBurnRangeProofEligibility(MINT_BURN_CONFIGS.find((item) => item.stablecoinId === "m-m0")!).supported).toBe(false);
    const args = sample("dai-makerdao", 2n, 1n);
    const entry = getMintBurnConservationRuntimeEntry(args.config)!;
    const reviewed = sidecarEntries.find((item) => item.stablecoinId === "dai-makerdao")!;
    expect(validateReviewedConservationEntry({ ...reviewed, totalSupplyView: { isStoredSum: false } }))
      .toContainEqual(expect.stringContaining("invalid conditional range law"));
    expect(resolveMintBurnRangeProofEligibility({ ...entry, invariant: "usdo-bonus-multiplier-shares" }, args.config).supported).toBe(false);
  });
  it("includes dust before economic filtering and never promotes members of a failed range", () => {
    const args = sample("dai-makerdao", 1n, 10n);
    const proof = completeMintBurnRangeSupplyProof(args);
    expect(proof).toMatchObject({ status: "proven", mintRaw: "1", zeroRaw: "10", deltaRaw: "-9" });
    const failed = completeMintBurnRangeSupplyProof({ ...args, boundary: { ...args.boundary, toSupplyRaw: args.boundary.fromSupplyRaw } });
    const row = { id: proof.members[1].id, direction: "burn", block_number: 102, flow_type: "standard", burn_type: "review_required" } as MintBurnRow;
    applyMintBurnRangeSupplyProof([row], failed);
    expect(row.supply_proof_id).toBeUndefined();
    expect(row.burn_type).toBe("review_required");
    row.amount_raw = "9";
    expect(() => applyMintBurnRangeSupplyProof([row], proof)).toThrow("range-proof-member-raw-mismatch");
    expect(row.amount_raw).toBe("9");
  });
  it("refuses USYC counterfeit offsetting cycles, but proves the sampled mint-free burn", () => {
    expect(completeMintBurnRangeSupplyProof(sample("usyc-hashnote", 100000000n, 100000000n, 0n)))
      .toMatchObject({ status: "unavailable", reason: "range-mint-evidence-required" });
    expect(completeMintBurnRangeSupplyProof(sample("usyc-hashnote", 0n, 100000000n)))
      .toMatchObject({ status: "proven", mintRaw: "0", zeroRaw: "100000000", deltaRaw: "-100000000" });
  });
  it("withholds both USYC mint semantics and exact net when the mint-free guard fails", () => {
    const proof = completeMintBurnRangeSupplyProof(sample("usyc-hashnote", 1n, 1n, 0n));
    const rows = [{ id: "mint", direction: "mint", flow_type: "standard", burn_type: null }] as MintBurnRow[];
    applyMintBurnRangeSupplyProof(rows, proof);
    expect(rows[0]).toMatchObject({ burn_type: "review_required", burn_review_reason: "range-mint-evidence-required" });
  });
  it.each(["usyc-hashnote", "eurs-stasis"])("requires both %s pins and an exhaustive change-free range", (id) => {
    const args = sample(id, 0n, 1n);
    expect(completeMintBurnRangeSupplyProof({ ...args, boundary: { ...args.boundary, views: undefined } }).reason)
      .toBe("range-guard-evidence-missing");
    expect(completeMintBurnRangeSupplyProof({ ...args, boundary: { ...args.boundary,
      views: { from: { rangeImplementation: word(1n) }, to: args.boundary.views!.to } } }).reason).toBe("range-guard-mismatch");
    const guard = getMintBurnConservationRuntimeEntry(args.config)!.supplyBurnProof!.range!.guard!;
    if (guard.status !== "pinned") throw new Error("missing fixture pin");
    expect(completeMintBurnRangeSupplyProof({ ...args, conservationLogs: [{
      eventDef: { signature: "Changed(address)", topicHash: guard.changeTopic, role: "guard" }, logs: [log("mint", 0n)],
    }] }).reason).toBe("range-implementation-changed");
  });
  it("requires complete logs, canonical boundaries, and refuses positive residual or positive zero-to-zero", () => {
    const args = sample("dai-makerdao", 2n, 1n);
    expect(completeMintBurnRangeSupplyProof({ ...args, complete: false }).reason).toBe("incomplete-log-range");
    expect(completeMintBurnRangeSupplyProof({ ...args, boundary: undefined }).reason).toBe("boundary-evidence-missing");
    expect(completeMintBurnRangeSupplyProof({ ...args, boundary: { status: "unavailable", reason: "audit-rpc-unavailable" } }).reason)
      .toBe("audit-rpc-unavailable");
    expect(completeMintBurnRangeSupplyProof({ ...args, boundary: { ...args.boundary, toBlockHash: word(99n) } }).reason)
      .toBe("closing-log-hash-mismatch");
    expect(completeMintBurnRangeSupplyProof(sample("dai-makerdao", 2n, 1n, 0n)).reason).toBe("range-supply-assumptions-inconsistent");
    args.logs[0].logs[0].removed = true;
    expect(completeMintBurnRangeSupplyProof({ ...args, complete: false }).reason).toBe("removed-log-reorg");
    args.logs[0].logs[0].removed = false;
    args.logs[0].logs[0].topics[2] = word(0n);
    expect(completeMintBurnRangeSupplyProof(args).reason).toBe("ambiguous-zero-transfer");
  });
  it("proves a complete empty range and keeps exact subset boundaries in its identity", () => {
    const args = sample("dai-makerdao", 0n, 0n);
    const proof = completeMintBurnRangeSupplyProof(args);
    expect(proof).toMatchObject({ status: "proven", mintRaw: "0", zeroRaw: "0", members: [] });
    expect(completeMintBurnRangeSupplyProof({ ...args, fromBlock: 102 }).proofId).not.toBe(proof.proofId);
  });
  it("skips all supply receipt requests for a proven non-bridge range and preserves bridge exclusions", async () => {
    const args = sample("dai-makerdao", 0n, 20000n * 10n ** 18n);
    const proof = completeMintBurnRangeSupplyProof(args);
    const fixture = reviewedBurnFixture("dai-makerdao");
    const row = parseMintBurnLogs(args.config, fixture.eventDef, args.logs[1].logs,
      new Map([[102, 1024]]), fixture.priceContext).rows[0];
    await classifyBridgeBurnRows([row], args.config, [], { count: 0, limit: 25 }, new Map(), undefined, { rangeSupplyProof: proof });
    applyMintBurnRangeSupplyProof([row], proof);
    expect(getAlchemyTransactionContextBatchMany).not.toHaveBeenCalled();
    expect(row).toMatchObject({ burn_type: "effective_burn", supply_proof_id: proof.proofId });
    row.flow_type = "bridge_transfer";
    row.burn_type = "bridge_burn";
    applyMintBurnRangeSupplyProof([row], proof);
    expect(row).toMatchObject({ flow_type: "bridge_transfer", burn_type: "bridge_burn" });
  });
  it("binds source law and decimal/config drift to proof identity", () => {
    const args = sample("dai-makerdao", 2n, 1n);
    const entry = getMintBurnConservationRuntimeEntry(args.config)!;
    const proof = completeMintBurnRangeSupplyProof(args);
    const missingLaw = completeMintBurnRangeSupplyProof({ ...args, lawFor: () => ({ ...entry, supplyBurnProof: undefined }) });
    expect(missingLaw).toMatchObject({ status: "unavailable", mintEvidence: "require-empty", reason: "range-law-unreviewed" });
    expect(mintBurnConservationFingerprint(args.config, () => ({ ...entry,
      supplyBurnProof: { ...entry.supplyBurnProof, range: { law: "paired-supply-zero-transfers-v1", mintEvidence: "require-empty" } } })))
      .not.toBe(proof.configFingerprint);
    expect(completeMintBurnRangeSupplyProof({ ...args, config: { ...args.config, decimals: 6 } }).status).toBe("unavailable");
  });
});
