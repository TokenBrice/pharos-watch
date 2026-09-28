import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { runCronSentinelSources } from "../cron-sentinel-result";
import type { CronSentinelRuleSource } from "../cron-sentinel-rules";

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
      const expired = await runCronSentinelSources(
        db,
        "status",
        [{ source: "freshness", run: async () => ({ status: "ok" }) }],
        200_000,
      );
      expect(expired.status).toBe("ok");
      expect(JSON.parse(expired.metadata!).sources.growth).toMatchObject({
        status: "expired", lastStatus: "degraded", observedAt: 100, maxAgeSec: 172_800,
      });
      expect((await runCronSentinelSources(db, "daily", [{ source: "growth", run: async () => ({ status: "ok" }) }], 300)).status).toBe("ok");
    } finally {
      sqlite.close();
    }
  });

  it.each([
    ["freshness", 1_800],
    ["digest-publication", 1_800],
    ["growth", 172_800],
    ["duration", 172_800],
    ["repair-debt", 172_800],
    ["turnover", 7_200],
    ["reserve-post-sync", 28_800],
  ] as const)("retains %s expiry diagnostics without aggregate impact", async (source, budget) => {
    const { db, sqlite } = createLatestSchemaSqlite();
    const observedAt = 1_800_000_000;
    const other: CronSentinelRuleSource = source === "freshness" ? "digest-publication" : "freshness";
    try {
      await runCronSentinelSources(db, "daily", [{ source, run: async () => ({ status: "error" }) }], observedAt);
      const assess = (at: number) => runCronSentinelSources(db, "status", [
        { source: other, run: async () => ({ status: "ok" }) },
        { source, run: async () => ({ status: "skipped_locked" }) },
      ], at);
      expect((await assess(observedAt + budget)).status).toBe("error");
      const expired = await assess(observedAt + budget + 1);
      expect(expired.status).toBe("ok");
      expect(JSON.parse(expired.metadata!).sources[source]).toMatchObject({
        status: "expired", lastStatus: "error", observedAt, maxAgeSec: budget,
        reason: "source-state-expired",
      });
      const recovered = await runCronSentinelSources(db, "daily", [
        { source, run: async () => ({ status: "ok" }) },
      ], observedAt + budget + 2);
      expect(JSON.parse(recovered.metadata!).sources[source]).toMatchObject({
        status: "ok", observedAt: observedAt + budget + 2,
      });
    } finally {
      sqlite.close();
    }
  });

  it("distinguishes explicitly disabled repair execution from missing and expired observations", async () => {
    const { db, sqlite } = createLatestSchemaSqlite();
    try {
      const result = await runCronSentinelSources(db, "daily", [
        { source: "repair-debt", run: async () => ({
          status: "ok", metadata: JSON.stringify({ mode: "disabled", enabled: false }),
        }) },
        { source: "growth", run: async () => ({
          status: "ok", metadata: JSON.stringify({ quality: { reason: "row-count-threshold" } }),
        }) },
      ], 100);
      const metadata = JSON.parse(result.metadata!);
      expect(result.status).toBe("ok");
      expect(metadata.sourceStatuses).toMatchObject({ "repair-debt": "disabled", freshness: "missing", growth: "ok" });
      expect(metadata.sources["repair-debt"]).toMatchObject({ observedAt: 100, maxAgeSec: 172_800 });
      expect(metadata.sources.freshness).toMatchObject({ observedAt: null, reason: "source-state-missing" });
      expect(metadata.quality.sources.growth).toEqual({ reason: "row-count-threshold" });
      const expired = await runCronSentinelSources(db, "status", [
        { source: "freshness", run: async () => ({ status: "ok" }) },
      ], 172_901);
      expect(JSON.parse(expired.metadata!).quality).toBeUndefined();
      expect(JSON.parse(expired.metadata!).sourceStatuses["repair-debt"]).toBe("expired");
    } finally {
      sqlite.close();
    }
  });
});
