import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker, createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { claimDetailCacheGeneration, publishDetailCacheGeneration } from "../detail-cache-generation";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());
describe("detail cache generation fencing", () => {
  it("prevents an older same-second refresh from overwriting the newer owner", async () => {
    const { sqlite, db } = fixtures.open();
    const older = await claimDetailCacheGeneration(db, "coin-a", { owner: "older", claimedAtMs: 1_000_100 });
    const newer = await claimDetailCacheGeneration(db, "coin-a", { owner: "newer", claimedAtMs: 1_000_900 });

    await expect(publishDetailCacheGeneration(db, "detail:coin-a", "older", older)).resolves.toMatchObject({
      written: false,
      skippedBecauseStale: true,
    });
    await expect(publishDetailCacheGeneration(db, "detail:coin-a", "newer", newer)).resolves.toMatchObject({
      written: true,
      skippedBecauseStale: false,
    });
    const cached = sqlite.prepare("SELECT value FROM cache WHERE key = 'detail:coin-a'").get() as { value: string };
    expect(cached.value).toBe("newer");
  });

  it("reports a committed cache write even when the generation bookkeeping update fails", async () => {
    const { sqlite, db } = createLatestSchemaSqlite({
      onRun: (sql) => {
        if (sql.startsWith("UPDATE detail_cache_write_generations")) {
          throw new Error("post-write bookkeeping failed");
        }
      },
    });
    try {
      const claim = await claimDetailCacheGeneration(db, "coin-a", { owner: "owner", claimedAtMs: 1_000_100 });
      await expect(publishDetailCacheGeneration(db, "detail:coin-a", "body", claim)).resolves.toMatchObject({
        written: true,
        skippedBecauseStale: false,
      });
      const cached = sqlite.prepare("SELECT value FROM cache WHERE key = 'detail:coin-a'").get() as { value: string };
      expect(cached.value).toBe("body");
    } finally {
      sqlite.close();
    }
  });
});
