import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "../../../test-helpers/latest-schema-sqlite";
import { runDexArchiveFoundation } from "../job";

describe("DEX archive foundation job", () => {
  it("records both modes while changing no source rows and writing no R2 objects", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const before = await db.prepare(
        "SELECT COUNT(*) AS count FROM dex_measured_execution_quotes",
      ).first<{ count: number }>();
      const result = await runDexArchiveFoundation(db, {
        DEX_MEASURED_ARCHIVE_MODE: "off",
        DEX_LIQUIDITY_ARCHIVE_MODE: "off",
      }, undefined, 1_800_000_000);
      const after = await db.prepare(
        "SELECT COUNT(*) AS count FROM dex_measured_execution_quotes",
      ).first<{ count: number }>();
      const states = await db.prepare(
        "SELECT family, effective_mode, last_run_at FROM dex_archive_family_state ORDER BY family",
      ).all();

      expect(result.status).toBe("ok");
      expect(result.itemCount).toBe(0);
      expect(after?.count).toBe(before?.count);
      expect(states.results).toEqual([
        { family: "liquidity", effective_mode: "off", last_run_at: 1_800_000_000 },
        { family: "measured-execution", effective_mode: "off", last_run_at: 1_800_000_000 },
      ]);
    } finally {
      sqlite.close();
    }
  });
});
