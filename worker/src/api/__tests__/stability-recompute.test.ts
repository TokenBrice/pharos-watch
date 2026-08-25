import { describe, expect, it } from "vitest";

import { DAY_SECONDS } from "@shared/lib/time-constants";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import { buildRecomputeStabilityStatements } from "../audit-depeg-history/stability-recompute";

const DAY = Math.floor(new Date("2026-03-05T00:00:00Z").getTime() / 1000);

function seedSupply(sqlite: ReturnType<typeof createLatestSchemaSqlite>["sqlite"], day: number, mcap: number): void {
  for (const [snapshotDate, circulating] of [[day, mcap], [day - 7 * DAY_SECONDS, mcap * 1.1]] as const) {
    sqlite
      .prepare("INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, ?)")
      .run("dai-makerdao", snapshotDate, circulating, 1);
  }
}

describe("buildRecomputeStabilityStatements", () => {
  it("produces statements SQLite accepts against the live stability_index schema", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    seedSupply(sqlite, DAY, 100_000_000_000);

    const { statements, daysRecomputed } = await buildRecomputeStabilityStatements(db, new Set([DAY]), []);

    expect(daysRecomputed).toBe(1);
    await expect(db.batch(statements)).resolves.toBeDefined();
  });

  it("leaves exactly one stability_index row per day when the recompute batch replays", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    seedSupply(sqlite, DAY, 100_000_000_000);

    const first = await buildRecomputeStabilityStatements(db, new Set([DAY]), []);
    await db.batch(first.statements);
    const second = await buildRecomputeStabilityStatements(db, new Set([DAY]), []);
    await db.batch(second.statements);

    const rows = sqlite
      .prepare("SELECT computed_at FROM stability_index WHERE computed_at = ?")
      .all(DAY) as { computed_at: number }[];

    expect(rows).toHaveLength(1);
  });
});
