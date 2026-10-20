import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { makeMintBurnConfig } from "../../test-helpers/__shared/mint-burn-config";
import { hasMintBurnScanCoverage, mintBurnScanFingerprint, type MintBurnScanCoverage } from "../mint-burn-pipeline/scan-coverage";
import { mintBurnConfigKey, upsertMintBurnSyncState } from "../mint-burn-pipeline/sync-state";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());
// Keep an actual decoder definition so source-revision tests cannot map an empty event set.
const config = makeMintBurnConfig({ events: [{
  signature: "Transfer(address,address,uint256)",
  topicHash: `0x${"1".repeat(64)}`,
  direction: "mint",
  amountEncoding: "nth-data-uint256",
  dataSlot: 0,
}] });
const end = Date.parse("2026-10-20T00:00:00Z") / 1000;
const day = 86_400;

function proof(fromBlock = 100, toBlock = 200, fromTimestamp = end - day, toTimestamp = end,
  source = config): MintBurnScanCoverage {
  return {
    configKey: mintBurnConfigKey(source), configFingerprint: mintBurnScanFingerprint(source), chainId: source.chain.chainId,
    fromBlock, toBlock, fromTimestamp, toTimestamp, finalizedBlock: toBlock, acceptedAt: end + day,
  };
}

async function commit(db: D1Database, segment = proof()) {
  await upsertMintBurnSyncState(db, segment.configKey, segment.toBlock, "monotonic-max", segment);
}

function segments(sqlite: DatabaseSync) {
  return sqlite.prepare(`SELECT from_block, to_block, from_timestamp, to_timestamp
    FROM mint_burn_scan_coverage ORDER BY from_block`).all();
}

describe("durable finalized mint/burn scan coverage", () => {
  it("losslessly merges adjacent and overlapping ranges, including an inserted bridge", async () => {
    const { sqlite, db } = fixtures.open();
    await commit(db, proof(100, 110, end - 3 * day, end - 2 * day));
    await commit(db, proof(121, 130, end - day, end));
    expect(segments(sqlite)).toHaveLength(2);
    await commit(db, proof(111, 120, end - 2 * day, end - day));
    await commit(db, proof(105, 125, end - 3 * day + 100, end - 100));
    expect(segments(sqlite)).toEqual([{ from_block: 100, to_block: 130,
      from_timestamp: end - 3 * day, to_timestamp: end }]);
    expect(sqlite.prepare("SELECT last_block FROM mint_burn_sync_state").get()).toEqual({ last_block: 130 });
    expect(await hasMintBurnScanCoverage(db, [config], end - day, end)).toBe(true);
  });

  it("fences only the coin-chain hours with pending materialization debt", async () => {
    const { sqlite, db } = fixtures.open();
    await commit(db, proof(100, 200, end - 2 * day, end));
    const insert = sqlite.prepare("INSERT INTO mint_burn_dirty_hours (stablecoin_id, chain_id, hour_ts) VALUES (?, ?, ?)");
    insert.run(config.stablecoinId, config.chain.chainId, end - 3600);
    insert.run("other-coin", config.chain.chainId, end - day);
    expect(await hasMintBurnScanCoverage(db, [config], end - day, end)).toBe(false);
    expect(await hasMintBurnScanCoverage(db, [config], end - 2 * day, end - day)).toBe(true);
    sqlite.prepare("DELETE FROM mint_burn_dirty_hours WHERE stablecoin_id = ?").run(config.stablecoinId);
    expect(await hasMintBurnScanCoverage(db, [config], end - day, end)).toBe(true);
  });

  it("does not bridge an unscanned block despite touching or overlapping time boundaries", async () => {
    const { sqlite, db } = fixtures.open();
    await commit(db, proof(100, 110, end - 2 * day, end - day));
    await commit(db, proof(112, 120, end - day, end));
    expect(segments(sqlite)).toHaveLength(2);
    expect(await hasMintBurnScanCoverage(db, [config], end - 2 * day, end)).toBe(false);
  });

  it("retains old fingerprints without inheriting their proof after a source revision", async () => {
    const { sqlite, db } = fixtures.open();
    await commit(db, proof(100, 110));
    const revised = { ...config, events: config.events.map((event) => ({ ...event, dataSlot: 1 })) };
    await commit(db, proof(111, 120, end, end + 100, revised));
    expect(sqlite.prepare("SELECT COUNT(DISTINCT config_fingerprint) AS count FROM mint_burn_scan_coverage").get())
      .toEqual({ count: 2 });
    expect(await hasMintBurnScanCoverage(db, [revised], end - day, end)).toBe(false);
    expect(await hasMintBurnScanCoverage(db, [config], end - day, end)).toBe(true);
    expect(mintBurnScanFingerprint({ ...config, startBlockSource: "new-source-revision" }))
      .not.toBe(mintBurnScanFingerprint(config));
  });

  it("resumes from persisted proof with a fresh database adapter, not invocation state", async () => {
    const { sqlite, db } = fixtures.open();
    await commit(db, proof(100, 110, end - 2 * day, end - day));
    const restarted = createSqliteD1(sqlite);
    await commit(restarted, proof(111, 120, end - day, end));
    expect(segments(sqlite)).toEqual([{ from_block: 100, to_block: 120,
      from_timestamp: end - 2 * day, to_timestamp: end }]);
    expect(await hasMintBurnScanCoverage(restarted, [config], end - 2 * day, end)).toBe(true);
  });

  it.each(["proof", "cursor"])("rolls back cursor and proof together when the %s write fails", async (failure) => {
    const { sqlite, db } = fixtures.open();
    await commit(db, proof(100, 110, end - 2 * day, end - day));
    sqlite.exec(failure === "proof"
      ? `CREATE TRIGGER reject_scan_proof BEFORE INSERT ON mint_burn_scan_coverage
         BEGIN SELECT RAISE(ABORT, 'proof rejected'); END`
      : `CREATE TRIGGER reject_scan_cursor BEFORE UPDATE ON mint_burn_sync_state
         BEGIN SELECT RAISE(ABORT, 'cursor rejected'); END`);
    await expect(commit(db, proof(111, 120, end - day, end))).rejects.toThrow("rejected");
    expect(sqlite.prepare("SELECT last_block FROM mint_burn_sync_state").get()).toEqual({ last_block: 110 });
    expect(segments(sqlite)).toEqual([{ from_block: 100, to_block: 110,
      from_timestamp: end - 2 * day, to_timestamp: end - day }]);
    expect(await hasMintBurnScanCoverage(db, [config], end - day, end)).toBe(false);
  });

  it("does not synthesize legacy coverage from an existing cursor", async () => {
    const { sqlite, db } = fixtures.open();
    await upsertMintBurnSyncState(db, mintBurnConfigKey(config), 1_000_000, "monotonic-max");
    expect(await hasMintBurnScanCoverage(db, [config], end - day, end)).toBe(false);
    expect(segments(sqlite)).toEqual([]);
  });

  it.each([1, 7, 30, 90])("requires exact closed %i-day UTC boundaries on every config and chain", async (days) => {
    const { sqlite, db } = fixtures.open();
    const other = makeMintBurnConfig({ chain: { chainId: "arbitrum" } });
    const start = end - days * day;
    await commit(db, proof(100, 200, start, end));
    expect(await hasMintBurnScanCoverage(db, [config], start, end)).toBe(true);
    expect(await hasMintBurnScanCoverage(db, [config, other], start, end)).toBe(false);
    await commit(db, proof(100, 200, start, end, other));
    expect(await hasMintBurnScanCoverage(db, [config, other], start, end)).toBe(true);
    sqlite.prepare("UPDATE mint_burn_scan_coverage SET from_timestamp = ? WHERE chain_id = 'arbitrum'").run(start + 1);
    expect(await hasMintBurnScanCoverage(db, [config, other], start, end)).toBe(false);
    sqlite.prepare("UPDATE mint_burn_scan_coverage SET from_timestamp = ?, to_timestamp = ? WHERE chain_id = 'arbitrum'")
      .run(start, end - 1);
    expect(await hasMintBurnScanCoverage(db, [config, other], start, end)).toBe(false);
    expect(await hasMintBurnScanCoverage(db, [config], start + 1, end)).toBe(false);
    expect(await hasMintBurnScanCoverage(db, [], start, end)).toBe(false);
  });

  it("admits closed-hour windows away from UTC midnight without rounding missing seconds into proof", async () => {
    const { db, sqlite } = fixtures.open();
    const hourlyEnd = end + 12 * 3600;
    await commit(db, proof(100, 200, hourlyEnd - day, hourlyEnd));
    expect(await hasMintBurnScanCoverage(db, [config], hourlyEnd - day, hourlyEnd)).toBe(true);
    sqlite.prepare("UPDATE mint_burn_scan_coverage SET to_timestamp = ?").run(hourlyEnd - 1);
    expect(await hasMintBurnScanCoverage(db, [config], hourlyEnd - day, hourlyEnd)).toBe(false);
  });

  it.each([
    { finalizedBlock: 199 }, { fromTimestamp: 0 }, { toTimestamp: end + 2 * day },
    { fromTimestamp: end + 1 }, { toBlock: 99 }, { acceptedAt: Number.NaN },
  ])("rejects inadmissible boundaries without writing a cursor: %j", async (invalid) => {
    const { sqlite, db } = fixtures.open();
    await expect(commit(db, { ...proof(), ...invalid })).rejects.toThrow("Invalid mint/burn scan coverage");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_sync_state").get()).toEqual({ count: 0 });
    expect(segments(sqlite)).toEqual([]);
  });
});
