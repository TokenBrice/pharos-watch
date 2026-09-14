import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncMintBurnConfig } from "../mint-burn/sync-config";
import { MINT_BURN_CONFIGS } from "../../lib/mint-burn-contracts";
import { fetchAlchemyLogs, resolveBlockTimestamps } from "../../lib/alchemy-logs";
import { parseMintBurnLogs } from "../../lib/mint-burn-pipeline/parse";
import { classifyBridgeBurnRows } from "../../lib/mint-burn-pipeline/classification";
import { persistMintBurnRows } from "../../lib/mint-burn-pipeline/persistence";
import { auditMintBurnConservation, persistMintBurnConservation, validateMintBurnParsedConservation,
  verifyPersistedMintBurnConservation } from "../../lib/mint-burn-conservation";
import type { MintBurnRow } from "../../lib/mint-burn-pipeline/types";
import type { MintBurnConservationRecord } from "@shared/types/status";
vi.mock("../../lib/alchemy-logs", () => ({ fetchAlchemyLogs: vi.fn(), resolveBlockTimestamps: vi.fn() }));
vi.mock("../../lib/mint-burn-pipeline/parse", () => ({ parseMintBurnLogs: vi.fn() }));
vi.mock("../../lib/mint-burn-pipeline/classification", () => ({ classifyBridgeBurnRows: vi.fn() }));
vi.mock("../../lib/mint-burn-pipeline/persistence", () => ({ persistMintBurnRows: vi.fn() }));
vi.mock("../../lib/mint-burn-conservation", () => ({ getMintBurnConservationEligibility: () => ({ supported: true }),
  auditMintBurnConservation: vi.fn(), persistMintBurnConservation: vi.fn(), validateMintBurnParsedConservation: vi.fn(),
  verifyPersistedMintBurnConservation: vi.fn() }));
const config = MINT_BURN_CONFIGS.find((item) => item.stablecoinId === "gusd-gemini")!;
const row = { id: "event", tx_hash: "tx", direction: "mint", amount: 10_000, block_number: 102, timestamp: 1100 } as MintBurnRow;
const audit = { status: "ok", checkedAt: 1200 } as MintBurnConservationRecord;
function run() {
  return syncMintBurnConfig({ db: {} as D1Database, config, key: "key", tier: "extended", fromBlock: 101,
    scanTo: 102, chainHead: 200, alchemyUrl: "https://rpc.example", configBudgetLimit: 25, runTimestamp: 1200,
    priceContext: { prices: new Map(), priceHistory: new Map() }, chainTimestampCache: new Map(),
    txContextCache: new Map(), affectedHours: new Map(), safetyMarginBlocks: 10 });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchAlchemyLogs).mockResolvedValueOnce({ logs: [{ data: `0x${(1_000_000n).toString(16).padStart(64, "0")}`,
    blockNumber: "0x66", logIndex: "0x0" }], complete: true, scannedToBlock: 102 } as never)
    .mockResolvedValueOnce({ logs: [], complete: true, scannedToBlock: 102 } as never);
  vi.mocked(resolveBlockTimestamps).mockResolvedValue(new Map([[102, 1100]]));
  vi.mocked(parseMintBurnLogs).mockReturnValue({ rows: [{ ...row }], dropped: 0 });
  vi.mocked(classifyBridgeBurnRows).mockResolvedValue({ effectiveBurns: 0, bridgeBurns: 0, reviewBurns: 0,
    txContextShortfalls: 0, deferredTxHashes: [] });
  vi.mocked(persistMintBurnRows).mockResolvedValue({ inserted: 1, ignored: 0, roundtripsDetected: 0 } as never);
  vi.mocked(auditMintBurnConservation).mockResolvedValue({ ...audit });
  vi.mocked(verifyPersistedMintBurnConservation).mockResolvedValue("ok");
});
describe("conservation producer publication and cursor fences", () => {
  it("publishes pass only after row write and persisted readback", async () => {
    expect((await run()).newLastBlock).toBe(102);
    expect(vi.mocked(persistMintBurnRows).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(persistMintBurnConservation).mock.invocationCallOrder[0]);
    expect(vi.mocked(verifyPersistedMintBurnConservation).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(persistMintBurnConservation).mock.invocationCallOrder[0]);
  });
  it("never publishes a pass if row persistence fails", async () => {
    vi.mocked(persistMintBurnRows).mockRejectedValue(new Error("write failed"));
    await expect(run()).rejects.toThrow("write failed");
    expect(persistMintBurnConservation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: "unavailable", reason: "event-row-write-failed" }), undefined);
  });
  it("invalidates a prior pass when persisted readback throws", async () => {
    vi.mocked(verifyPersistedMintBurnConservation).mockRejectedValue(new Error("read failed"));
    await expect(run()).rejects.toThrow("read failed");
    expect(persistMintBurnConservation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: "unavailable", reason: "persisted-event-readback-failed" }), undefined);
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
    if (kind === "mismatch") vi.mocked(auditMintBurnConservation).mockResolvedValue({ ...audit, status: "mismatch" });
    if (kind === "parser") vi.mocked(validateMintBurnParsedConservation).mockImplementation(() => { throw new Error("bad row"); });
    if (kind === "persisted") vi.mocked(verifyPersistedMintBurnConservation).mockResolvedValue("mismatch");
    const result = await run();
    expect(result.newLastBlock).toBeNull();
    expect(result.summary.errors).toBeGreaterThan(0);
    if (kind === "parser") expect(persistMintBurnRows).toHaveBeenCalledWith(expect.anything(), [], expect.anything(), expect.anything());
  });
  it("preserves normal cursor advancement through diagnostic RPC unavailability", async () => {
    vi.mocked(auditMintBurnConservation).mockResolvedValue({ ...audit, status: "unavailable", reason: "audit-rpc-unavailable" });
    const result = await run();
    expect(result.newLastBlock).toBe(102);
    expect(result.summary.errors).toBe(0);
    expect(result.apiErrors).toBe(0);
    expect(result.summary.conservationStatus).toBe("unavailable");
  });
  it("propagates cache write failure without returning an advanced cursor", async () => {
    vi.mocked(persistMintBurnConservation).mockRejectedValue(new Error("cache write failed"));
    await expect(run()).rejects.toThrow("cache write failed");
  });
});
