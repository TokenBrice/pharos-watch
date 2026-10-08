import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { CACHED_VAULT_RATE_MAX_AGE_SEC } from "../authoritative-price-sources/helpers";
import { readVaultRateCache, writeVaultRateCache } from "../authoritative-price-sources/rate-cache";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());
const now = 1_800_000_000;

describe("durable authoritative vault rates", () => {
  it("preserves unavailable rates and excludes the exact freshness boundary", async () => {
    const { sqlite, db } = fixtures.open();
    const insert = sqlite.prepare("INSERT INTO authoritative_vault_rates (stablecoin_id, rate, observed_at, updated_at) VALUES (?, ?, ?, ?)");
    insert.run("fresh", 1.05, now - CACHED_VAULT_RATE_MAX_AGE_SEC + 1.8, now);
    insert.run("stale", 1.1, now - CACHED_VAULT_RATE_MAX_AGE_SEC, now);
    insert.run("zero", 0, now - 1, now);
    insert.run("negative", -1, now - 1, now);
    insert.run("", 1, now - 1, now);
    const cache = await readVaultRateCache(db, now);
    expect([...cache]).toEqual([["fresh", { rate: 1.05, observedAt: now - CACHED_VAULT_RATE_MAX_AGE_SEC + 1 }]]);
    expect(cache.has("absent")).toBe(false);
  });

  it("upserts the last-good rate and prunes only observations at the seven-day boundary", async () => {
    const { sqlite, db } = fixtures.open();
    const insert = sqlite.prepare("INSERT INTO authoritative_vault_rates (stablecoin_id, rate, observed_at, updated_at) VALUES (?, ?, ?, ?)");
    insert.run("replace", 1, now - 100, now - 100);
    insert.run("prune", 1, now - 7 * 86400, now);
    insert.run("retain", 1, now - 7 * 86400 + 1, now);
    await writeVaultRateCache(db, new Map([["replace", { rate: 1.08, observedAt: now - 1.2 }]]), now);
    expect(sqlite.prepare("SELECT rate, observed_at, updated_at FROM authoritative_vault_rates WHERE stablecoin_id = 'replace'").get())
      .toEqual({ rate: 1.08, observed_at: now - 2, updated_at: now });
    expect(sqlite.prepare("SELECT stablecoin_id FROM authoritative_vault_rates ORDER BY stablecoin_id").all())
      .toEqual([{ stablecoin_id: "replace" }, { stablecoin_id: "retain" }]);
    expect((await readVaultRateCache(db, now)).get("replace")).toEqual({ rate: 1.08, observedAt: now - 2 });
  });

  it("leaves persisted evidence unchanged for an empty write batch", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.prepare("INSERT INTO authoritative_vault_rates (stablecoin_id, rate, observed_at, updated_at) VALUES (?, ?, ?, ?)").run("old-evidence", 1, now - 8 * 86400, now);
    await writeVaultRateCache(db, new Map(), now);
    expect(sqlite.prepare("SELECT rate FROM authoritative_vault_rates WHERE stablecoin_id = 'old-evidence'").get()).toEqual({ rate: 1 });
  });

  it("does not invent a usable rate when the optional cache table is unavailable", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec("DROP TABLE authoritative_vault_rates");
    expect(await readVaultRateCache(db, now)).toEqual(new Map());
    await writeVaultRateCache(db, new Map([["unavailable", { rate: 1, observedAt: now }]]), now);
    expect(await readVaultRateCache(db, now)).toEqual(new Map());
  });
});
