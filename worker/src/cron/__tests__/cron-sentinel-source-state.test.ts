import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { runCronSentinelSources } from "../cron-sentinel-result";
import type { CronResult } from "../../lib/cron-logger";
import type { CronSentinelRuleSource } from "../cron-sentinel-rules";

const evaluation = (source: CronSentinelRuleSource, status: CronResult["status"]) => ({
  source, run: async () => ({ status }),
});

const fixtures = createLatestSchemaFixtureTracker();
afterEach(fixtures.closeAll);
describe("cron sentinel persisted source state", () => {
  it("bootstraps the last evaluated source, survives other modes, and clears on fresh recovery", async () => {
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status, metadata) VALUES ('cron-sentinel', ?, 1, ?, ?)");
    insert.run(100, "degraded", JSON.stringify({ mode: "daily", sources: { growth: { status: "degraded", itemCount: 2_400_000, metadata: { rowCount: 2_400_000 } } } }));
    insert.run(150, "ok", JSON.stringify({ mode: "daily", sources: { growth: { status: "skipped_neutral", itemCount: 0 } } }));
    insert.run(160, "error", "malformed-json");
    insert.run(170, "ok", JSON.stringify({ sources: { growth: "invalid-source-shape" } }));
    const status = await runCronSentinelSources(db, "status", [evaluation("freshness", "ok")], 200);
    expect(status.status).toBe("degraded");
    expect(JSON.parse(status.metadata!).sources.growth).toMatchObject({ status: "degraded", observedAt: 100 });
    expect((await runCronSentinelSources(db, "daily", [evaluation("growth", "ok")], 50)).status).toBe("degraded");
    const expired = await runCronSentinelSources(
      db, "status",
      [evaluation("freshness", "ok")],
      200_000,
    );
    expect(expired.status).toBe("degraded");
    expect(JSON.parse(expired.metadata!).reason).toBe("source-state-expired:growth");
    expect(JSON.parse(expired.metadata!).quality).toMatchObject({
      reason: "sentinel-source-expired", reasons: ["source-state-expired:growth"],
    });
    expect(JSON.parse(expired.metadata!).sources.growth).toMatchObject({
      status: "expired", lastStatus: "degraded", observedAt: 100, maxAgeSec: 172_800,
    });
    expect((await runCronSentinelSources(db, "daily", [evaluation("growth", "ok")], 300)).status).toBe("ok");
  });

  it.each([
    ["freshness", 1_800],
    ["digest-publication", 1_800],
    ["growth", 172_800],
    ["duration", 172_800],
    ["repair-debt", 172_800],
    ["turnover", 7_200],
    ["reserve-post-sync", 28_800],
  ] as const)("escalates %s expiry to a degraded sentinel with a machine reason", async (source, budget) => {
    const { db } = fixtures.open();
    const observedAt = 1_800_000_000;
    const other: CronSentinelRuleSource = source === "freshness" ? "digest-publication" : "freshness";
    await runCronSentinelSources(db, "daily", [evaluation(source, "error")], observedAt);
    const assess = (at: number) => runCronSentinelSources(db, "status", [
      evaluation(other, "ok"),
      evaluation(source, "skipped_locked"),
    ], at);
    expect((await assess(observedAt + budget)).status).toBe("error");
    const expired = await assess(observedAt + budget + 1);
    expect(expired.status).toBe("degraded");
    expect(JSON.parse(expired.metadata!).reason).toBe(`source-state-expired:${source}`);
    expect(JSON.parse(expired.metadata!).quality).toMatchObject({
      reason: "sentinel-source-expired", reasons: [`source-state-expired:${source}`],
    });
    expect(JSON.parse(expired.metadata!).sources[source]).toMatchObject({
      status: "expired", lastStatus: "error", observedAt, maxAgeSec: budget, reason: "source-state-expired",
      nextRetryAt: observedAt + budget + 901,
      attempt: { count: 3, attemptedAt: observedAt + budget + 1, status: "skipped_locked" },
    });
    const recovered = await runCronSentinelSources(db, "daily", [
      evaluation(source, "ok"),
    ], observedAt + budget + 900);
    expect(JSON.parse(recovered.metadata!).sources[source]).toMatchObject({
      status: "ok", observedAt: observedAt + budget + 900,
    });
  });

  it("distinguishes explicitly disabled repair execution from missing and expired observations", async () => {
    const { db } = fixtures.open();
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
      evaluation("freshness", "ok"),
      // Keep growth current so only the explicitly disabled repair source ages out.
      evaluation("growth", "ok"),
    ], 172_901);
    expect(expired.status).toBe("ok");
    expect(JSON.parse(expired.metadata!).quality).toBeUndefined();
    expect(JSON.parse(expired.metadata!).sourceStatuses["repair-debt"]).toBe("expired");
  });

  it.each([false, true])("bounds cross-mode retries and preserves skipped/aborted clocks (%s)", async (aborted) => {
    const { db } = fixtures.open();
    await runCronSentinelSources(db, "daily", (["growth", "duration"] as const).map(source => evaluation(source, "error")), 100);
    const attempts: string[] = [];
    const retry = async (source: CronSentinelRuleSource) => {
      attempts.push(source);
      return source === "growth" ? { status: "skipped_neutral", ...(aborted ? { aborted } : {}) } as CronResult : { status: "ok" } as CronResult;
    };
    for (const at of [1000, 1000, 1001]) await runCronSentinelSources(db, "status", [], at, undefined, retry);
    expect(attempts).toEqual(["growth", "duration"]);
    const result = await runCronSentinelSources(db, "status", [], 1002);
    expect(JSON.parse(result.metadata!).sources.growth).toMatchObject({
      observedAt: 100, reason: "source-evaluation-error", nextRetryAt: 1900, retryBackoffSec: 900,
      attempt: { count: 2, attemptedAt: 1000, mode: "status", status: aborted ? "incomplete" : "skipped_neutral" },
    });
  });
});
