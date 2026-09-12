import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { runCronSentinelSources } from "../cron-sentinel-result";

// Exercise the actual JSON history query and monotonic cache writes together.
describe("cron sentinel persisted source state", () => {
  it("bootstraps the last evaluated source, survives other modes, and clears on fresh recovery", async () => {
    const { db, sqlite } = createLatestSchemaSqlite();
    try {
      const insert = sqlite.prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status, metadata) VALUES ('cron-sentinel', ?, 1, ?, ?)");
      insert.run(100, "degraded", JSON.stringify({ mode: "daily", sources: { growth: { status: "degraded", itemCount: 2_400_000, metadata: { rowCount: 2_400_000 } } } }));
      insert.run(150, "ok", JSON.stringify({ mode: "daily", sources: { growth: { status: "skipped_neutral", itemCount: 0 } } }));
      insert.run(160, "error", "malformed-json");
      insert.run(170, "ok", JSON.stringify({ sources: { growth: "invalid-source-shape" } }));
      const status = await runCronSentinelSources(db, "status", [{ source: "freshness", run: async () => ({ status: "ok" }) }], 200);
      expect(status.status).toBe("degraded");
      expect(JSON.parse(status.metadata!).sources.growth).toMatchObject({ status: "degraded", observedAt: 100 });
      expect((await runCronSentinelSources(db, "daily", [{ source: "growth", run: async () => ({ status: "ok" }) }], 50)).status).toBe("degraded");
      expect((await runCronSentinelSources(db, "daily", [{ source: "growth", run: async () => ({ status: "ok" }) }], 300)).status).toBe("ok");
    } finally {
      sqlite.close();
    }
  });
});
