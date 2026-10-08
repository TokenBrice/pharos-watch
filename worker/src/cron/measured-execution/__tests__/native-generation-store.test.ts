import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { SolanaDexBankCaptureSchema, type SolanaDexNativeGeneration } from "@shared/types/solana-dex-bank";
import fixture from "../../dex-liquidity/__tests__/fixtures/whirlpool-slot-449058549.json";
import { decodeWhirlpool } from "../../dex-liquidity/solana/whirlpool-quote";
import { buildNativeDexExecutionTarget } from "../inventory";
import { captureNativeDexPublisherFence, loadCurrentNativeDexGeneration, publishNativeDexGeneration, pruneNativeDexGenerations } from "../native-generation-store";
import { loadNativeDexExecutionDiagnostic } from "../join";
import { seedMeasuredProducerAttempt } from "./persistence.test-support";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());
const PROFILE = "orca-whirlpool-exact-v1";
const fixtureAccounts: Record<string, { owner: string; data: string[] }> = fixture.accounts;

function generation(generationId = "native-current", startedAt = 1_000): SolanaDexNativeGeneration {
  const pool = decodeWhirlpool(Uint8Array.from(Buffer.from(fixtureAccounts[fixture.poolAddress].data[0], "base64")), fixture.slot);
  const target = buildNativeDexExecutionTarget({ chain: "solana", profileId: PROFILE, poolAddress: fixture.poolAddress,
    stablecoinId: "usx-solstice", tokenMintIn: fixture.tokenMintIn,
    tokenMintOut: fixture.tokenMintIn === pool.tokenMintA ? pool.tokenMintB : pool.tokenMintA });
  const mintBytes = new Uint8Array(82); mintBytes[44] = 6; mintBytes[45] = 1;
  const accounts = Object.entries(fixture.accounts).map(([address, account]) => ({ address,
    account: { owner: account.owner, dataBase64: account.data[0] } }));
  for (const address of [pool.tokenMintA, pool.tokenMintB]) accounts.push({ address,
    account: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", dataBase64: Buffer.from(mintBytes).toString("base64") } });
  const bank = SolanaDexBankCaptureSchema.parse({ schemaVersion: "solana-dex-bank-v1", chain: "solana",
    profileId: PROFILE, poolAddress: fixture.poolAddress, slot: fixture.slot, scoreEligible: false,
    programClosureComplete: false, independentExecution: false, accounts });
  const bankRef = `${generationId}:${target.targetId}:bank:${fixture.slot}`;
  return { schemaVersion: "solana-dex-generation-v1", generationId, profileId: PROFILE,
    sourceGenerationId: "original-retained-generation", startedAt, publishedAt: startedAt + 60, scoreEligible: false,
    quotes: [{ target, scoreEligible: false, bank, bankRef, proofRef: `${bankRef}:local-model`,
      programId: fixtureAccounts[fixture.poolAddress].owner,
      arrayAddresses: accounts.filter((account) => account.address !== fixture.poolAddress && account.account.owner === fixtureAccounts[fixture.poolAddress].owner).map((account) => account.address),
      dependencyAddresses: [],
      inputPriceUsd: 1, inputDecimals: 6, points: [{ status: "full-fill", notionalUsd: 1_000, quotedAt: startedAt + 30,
        slot: fixture.slot, amountInRaw: fixture.amountIn, amountOutRaw: fixture.amountOut, outputRef: `${bankRef}:quote:1000` }] }] };
}

describe("authoritative native diagnostic generations", () => {
  it("atomically publishes original native bank, proof and local-output references without EVM writes", async () => {
    const { db, sqlite } = fixtures.open();
    const value = generation();
    expect(await publishNativeDexGeneration(db, value)).toBe(true);
    expect(await loadCurrentNativeDexGeneration(db, PROFILE)).toEqual(value);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM dex_measured_execution_quotes").get()).toEqual({ n: 0 });
    expect(await loadNativeDexExecutionDiagnostic({ db, profileId: PROFILE, nowSec: value.publishedAt }))
      .toMatchObject({ status: "current", scoreEligible: false, generationId: value.generationId,
        quotes: [{ status: "current", slot: fixture.slot }] });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM surface_publication_generations").get()).toEqual({ n: 0 });
    expect(() => sqlite.prepare("UPDATE dex_native_generations SET score_eligible = 1").run()).toThrow();
  });

  it.each(["missing-bank", "missing-mint", "missing-array", "mixed-slot", "wrong-program", "foreign-proof", "foreign-output", "source-missing", "cetus"])("rejects %s before publication", async (kind) => {
    const { db, sqlite } = fixtures.open();
    const value = generation();
    const quote = value.quotes[0]!;
    if (kind === "missing-bank") quote.bank = null;
    if (kind === "missing-mint") quote.bank!.accounts = quote.bank!.accounts.filter((entry) => entry.address !== quote.target.tokenMintIn);
    if (kind === "missing-array") quote.bank!.accounts.find((entry) => entry.address === quote.arrayAddresses[0])!.account = null;
    if (kind === "mixed-slot") quote.bank!.slot++;
    if (kind === "wrong-program") quote.programId = quote.target.tokenMintIn;
    if (kind === "foreign-proof") quote.proofRef = "evm-proof";
    if (kind === "foreign-output" && quote.points[0]!.status === "full-fill") quote.points[0]!.outputRef = "old-native-success";
    if (kind === "source-missing") value.sourceGenerationId = null;
    if (kind === "cetus") Object.assign(value, { profileId: "cetus-clmm-exact-v1" });
    await expect(publishNativeDexGeneration(db, value)).rejects.toThrow();
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM dex_native_generations").get()).toEqual({ n: 0 });
  });

  it("rolls back a torn quote batch and preserves the previous pointer", async () => {
    const { db, sqlite } = fixtures.open();
    await publishNativeDexGeneration(db, generation("prior"));
    sqlite.exec(`CREATE TRIGGER tear_native_quote AFTER INSERT ON dex_native_generation_quotes
      WHEN NEW.generation_id = 'torn' BEGIN DELETE FROM dex_native_generation_quotes WHERE generation_id = NEW.generation_id; END;`);
    await expect(publishNativeDexGeneration(db, generation("torn", 2_000))).rejects.toThrow("native-generation-incomplete");
    expect((await loadCurrentNativeDexGeneration(db, PROFILE))?.generationId).toBe("prior");
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM dex_native_generations WHERE generation_id = 'torn'").get()).toEqual({ n: 0 });
  });

  it("ignores unpointed newer rows and fences an older or equal-clock late writer", async () => {
    const { db } = fixtures.open();
    expect(await publishNativeDexGeneration(db, generation("new", 2_000))).toBe(true);
    expect(await publishNativeDexGeneration(db, generation("old", 1_000))).toBe(false);
    expect(await publishNativeDexGeneration(db, generation("same-clock", 2_000))).toBe(false);
    expect((await loadCurrentNativeDexGeneration(db, PROFILE))?.generationId).toBe("new");
  });

  it("fences a scheduled publisher whose captured lease no longer owns the execution", async () => {
    const { db, sqlite } = fixtures.open();
    const clockSec = Math.floor(Date.now() / 1_000);
    seedMeasuredProducerAttempt(sqlite, { job: "sync-cl-exit-depth", scheduleKey: "halfHourlyMeasuredExecution",
      invocationId: "native-owner", clockSec, terminal: false });
    const fence = await captureNativeDexPublisherFence(db, "native-owner", 1, clockSec);
    sqlite.prepare("UPDATE cron_leases SET lease_owner = 'replacement' WHERE job = 'sync-cl-exit-depth'").run();
    expect(await publishNativeDexGeneration(db, generation(), undefined, fence)).toBe(false);
    expect(await loadCurrentNativeDexGeneration(db, PROFILE)).toBeNull();
  });

  it("keeps current failed/unavailable outcomes, never falls back to a successful generation", async () => {
    const { db } = fixtures.open();
    await publishNativeDexGeneration(db, generation("good"));
    const value = generation("failed", 2_000);
    value.quotes[0]!.points = [{ status: "failed", reason: "native-array-exhausted", notionalUsd: 1_000, quotedAt: 2_010 },
      { status: "unavailable", reason: "native-bank-unavailable", notionalUsd: 100_000, quotedAt: 2_010 }];
    await publishNativeDexGeneration(db, value);
    expect(await loadCurrentNativeDexGeneration(db, PROFILE)).toEqual(value);
  });

  it("isolates both family pointers and rejects a retained row count mismatch on read", async () => {
    const { db, sqlite } = fixtures.open();
    await publishNativeDexGeneration(db, generation());
    expect(await loadCurrentNativeDexGeneration(db, "raydium-clmm-exact-v1")).toBeNull();
    sqlite.prepare("DELETE FROM dex_native_generation_quotes").run();
    await expect(loadCurrentNativeDexGeneration(db, PROFILE)).rejects.toThrow("native-generation-incomplete");
  });

  it("uses bounded indexed seven-day retention, cascades quote rows, and protects stale current pointers", async () => {
    const { db, sqlite } = fixtures.open();
    for (let i = 0; i < 20; i++) await publishNativeDexGeneration(db, generation(`old-${i}`, 1_000 + i * 100));
    await pruneNativeDexGenerations(db, 2_000_000);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM dex_native_generations").get()).toEqual({ n: 4 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM dex_native_generation_quotes").get()).toEqual({ n: 4 });
    await pruneNativeDexGenerations(db, 2_000_000);
    expect((await loadCurrentNativeDexGeneration(db, PROFILE))?.generationId).toBe("old-19");
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM dex_native_generations").get()).toEqual({ n: 1 });
    expect(JSON.stringify(sqlite.prepare(`EXPLAIN QUERY PLAN SELECT generation_id FROM dex_native_generations
      WHERE published_at < ? ORDER BY published_at, generation_id LIMIT 16`).all(2_000_000))).toContain("idx_dex_native_generations_retention");
  });

  it("rolls back the entire publication when a quote insert fails", async () => {
    const { sqlite } = fixtures.open();
    const db = createSqliteD1(sqlite, { onRun: (sql) => { if (sql.startsWith("INSERT INTO dex_native_generation_quotes")) throw new Error("quote-write-failed"); } });
    await expect(publishNativeDexGeneration(db, generation())).rejects.toThrow("quote-write-failed");
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM dex_native_generations").get()).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM dex_native_publication_pointers").get()).toEqual({ n: 0 });
  });
});
