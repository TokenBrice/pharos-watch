import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
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
});
