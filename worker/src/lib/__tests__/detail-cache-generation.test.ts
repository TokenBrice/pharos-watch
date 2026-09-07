import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { claimDetailCacheGeneration, publishDetailCacheGeneration } from "../detail-cache-generation";

describe("detail cache generation fencing", () => {
  it("prevents an older same-second refresh from overwriting the newer owner", async () => {
    const sqlite = new DatabaseSync(":memory:");
    const migrationsDir = join(process.cwd(), "worker/migrations");
    for (const file of readdirSync(migrationsDir).filter((entry) => entry.endsWith(".sql")).sort()) {
      sqlite.exec(readFileSync(join(migrationsDir, file), "utf8"));
    }
    const db = createSqliteD1(sqlite);
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
    sqlite.close();
  });
});
