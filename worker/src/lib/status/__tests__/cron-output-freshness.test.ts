import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { getCronJobMeta } from "@shared/lib/cron-jobs";
import { logCronRun, type CronResult } from "../../cron-logger";
import { confirmedCronOutputAt } from "../../cron-output";
import { compactCronMetadataForPersistence } from "../../cron-metadata-persistence";
import { loadProducerFreshnessFacts } from "../freshness-oracle";
import { loadCronHealth } from "../cron-health";
import { getDatasetFreshness } from "../derived-data";

const NOW = 1_800_000_000;
const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("confirmed output versus attempted work", () => {
  it.each([
    ["held", { status: "degraded", itemCount: 60, metadata: JSON.stringify({ reason: "rankings-payload-shrunk" }) }],
    ["failed write", { status: "degraded", itemCount: 60, metadata: JSON.stringify({ reason: "db_write_failed", cacheWriteSucceeded: false }) }],
    ["no rows", { status: "degraded", itemCount: 0, metadata: JSON.stringify({ reason: "all_coins_zero_supply" }) }],
    ["empty ok attempt", { status: "ok", itemCount: 0 }],
    ["blocked invalid payload", { status: "degraded", itemCount: 60, metadata: JSON.stringify({ cacheWriteMode: "blocked-invalid-payload", reason: "invalid-payload" }) }],
    ["CAS skip", { status: "skipped_neutral", itemCount: 0, metadata: JSON.stringify({ reason: "cache-write-skipped-newer", cacheWriteMode: "skipped-newer", lastWriteAdvanced: true }) }],
  ] satisfies Array<[string, CronResult]>)("does not renew a producer clock after %s", async (_name, result) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    const { db, sqlite } = fixtures.open();
    const oldOutput = NOW - 4 * 86400;
    sqlite.prepare("INSERT INTO cron_runs(job,started_at,duration_ms,status,item_count,metadata) VALUES ('snapshot-supply',?,1,'ok',10,?)")
      .run(oldOutput, JSON.stringify({ outputPublishedAt: oldOutput }));
    await logCronRun(db, "snapshot-supply", async () => result);
    const [fact] = await loadProducerFreshnessFacts(db, NOW, [getCronJobMeta("snapshot-supply")!]);
    expect(fact).toMatchObject({ lastSuccessAt: oldOutput, lastRunAt: NOW, lastStatus: result.status });
    expect((await loadCronHealth(db, NOW)).crons["snapshot-supply"].healthy).toBe(false);
  });

  it("keeps a quality-degraded publication's producing clock through logger, status, and dataset readers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = fixtures.open();
    const publishedAt = NOW - 60;
    await logCronRun(db, "sync-blacklist", async () => ({
      status: "degraded", itemCount: 3,
      metadata: JSON.stringify({ reason: "partial-provider-coverage", outputPublishedAt: publishedAt }),
      productivity: { productive: true },
    }));
    const [fact] = await loadProducerFreshnessFacts(db, NOW, [getCronJobMeta("sync-blacklist")!]);
    expect(fact).toMatchObject({ lastSuccessAt: publishedAt, lastRunAt: NOW });
    expect((await loadCronHealth(db, NOW)).crons["sync-blacklist"].healthy).toBe(true);
    expect((await getDatasetFreshness(db)).blacklist).toBe(publishedAt);
  });

  it("retains successful-run operator quality warnings separately from availability", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    const { db } = fixtures.open();
    await logCronRun(db, "cron-sentinel", async () => ({
      status: "ok", itemCount: 2_400_000,
      metadata: JSON.stringify({ quality: { sources: { growth: { reason: "row-count-threshold" } } } }),
    }));
    const health = await loadCronHealth(db, NOW);
    expect(health.crons["cron-sentinel"].healthy).toBe(true);
    expect(health.degradedCronRuns).toBe(0);
    vi.setSystemTime((NOW + 1) * 1000);
    await logCronRun(db, "cron-sentinel", async () => ({
      status: "skipped_neutral", metadata: JSON.stringify({ reason: "not-due" }),
    }));
    const inherited = await loadCronHealth(db, NOW + 1);
    expect(inherited.crons["cron-sentinel"].healthy).toBe(true);
    expect(inherited.degradedCronRuns).toBe(0);
  });

  it("does not let compaction lose a no-publication marker or reset an actual generation clock", () => {
    for (const outputPublishedAt of [null, NOW - 120]) {
      const metadata = compactCronMetadataForPersistence(JSON.stringify({
        // Array padding forces compaction without a single huge string (string redaction cost grows superlinearly).
        outputPublishedAt, padding: Array.from({ length: 20_000 }, () => "xxxx"), quality: { reason: "row-count-threshold" },
      }));
      const parsed = JSON.parse(metadata.metadata!);
      expect(parsed.outputPublishedAt).toBe(outputPublishedAt);
      expect(parsed.quality.reasons).toEqual(["row-count-threshold"]);
      expect(confirmedCronOutputAt({ status: "ok", itemCount: 100 }, parsed, NOW)).toBe(outputPublishedAt);
    }
    expect(confirmedCronOutputAt({ status: "degraded", itemCount: 10, productivity: {
      productive: true, publications: [{ surface: "stablecoins", generationId: "old", publishedAt: NOW - 120 }],
    } }, {}, NOW)).toBe(NOW - 120);
  });
});
