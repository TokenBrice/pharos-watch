import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { runCronSentinelSources } from "../cron-sentinel-result";
import type { CronResult } from "../../lib/cron-logger";
import type { CronSentinelRuleSource } from "../cron-sentinel-rules";

const evaluation = (source: CronSentinelRuleSource, status: CronResult["status"], metadata?: unknown) => ({
  source, run: async () => ({ status, metadata: JSON.stringify(metadata) }),
});

const fixtures = createLatestSchemaFixtureTracker();
let fixture: ReturnType<typeof fixtures.open>;
beforeEach(() => { fixture = fixtures.open(); });
afterEach(fixtures.closeAll);
const run = (...args: Parameters<typeof runCronSentinelSources> extends [D1Database, ...infer P] ? P : never) =>
  runCronSentinelSources(fixture.db, ...args);
const sources = (result: CronResult) => JSON.parse(result.metadata!).sources;
describe("cron sentinel persisted source state", () => {
  it("retains reserve census identities with bounded arrays across modes", async () => {
    const added = Array.from({ length: 41 }, (_, i) => `slice:${i}`);
    const removed = ["sky-makercore:module:stablecoins-residual"];
    await run("reserve-post-sync", [evaluation("reserve-post-sync", "ok", {
      compositionCensus: { findings: [{ stablecoinId: "usds-sky", added, removed, shareDriftPct: 0.01 }] },
    })], 100);
    const result = await run("status", [], 200);
    expect(sources(result)["reserve-post-sync"].metadata.compositionCensus.findings).toEqual([{
      stablecoinId: "usds-sky", added: [...added.slice(0, 40), "[1 more]"], removed, shareDriftPct: 0.01,
    }]);
  });

  it("bootstraps the last evaluated source, survives other modes, and clears on fresh recovery", async () => {
    const { sqlite } = fixture;
    const insert = sqlite.prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status, metadata) VALUES ('cron-sentinel', ?, 1, ?, ?)");
    insert.run(100, "degraded", JSON.stringify({ mode: "daily", sources: { growth: { status: "degraded", itemCount: 2_400_000, metadata: { rowCount: 2_400_000 } } } }));
    insert.run(150, "ok", JSON.stringify({ mode: "daily", sources: { growth: { status: "skipped_neutral", itemCount: 0 } } }));
    insert.run(160, "error", "malformed-json");
    insert.run(170, "ok", JSON.stringify({ sources: { growth: "invalid-source-shape" } }));
    const status = await run("status", [evaluation("freshness", "ok")], 200);
    expect(status.status).toBe("degraded");
    expect(sources(status).growth).toMatchObject({ status: "degraded", observedAt: 100 });
    expect((await run("daily", [evaluation("growth", "ok")], 50)).status).toBe("degraded");
    const expired = await run(
      "status",
      [evaluation("freshness", "ok")],
      200_000,
    );
    expect(expired.status).toBe("degraded");
    expect(JSON.parse(expired.metadata!).reason).toBe("source-state-expired:growth");
    expect(JSON.parse(expired.metadata!).quality).toMatchObject({
      reason: "sentinel-source-expired", reasons: ["source-state-expired:growth"],
    });
    expect(sources(expired).growth).toMatchObject({
      status: "expired", lastStatus: "degraded", observedAt: 100, maxAgeSec: 172_800,
    });
    expect((await run("daily", [evaluation("growth", "ok")], 300)).status).toBe("ok");
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
    const observedAt = 1_800_000_000;
    const other: CronSentinelRuleSource = source === "freshness" ? "digest-publication" : "freshness";
    await run("daily", [evaluation(source, "error")], observedAt);
    const assess = (at: number) => run("status", [
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
    expect(sources(expired)[source]).toMatchObject({
      status: "expired", lastStatus: "error", observedAt, maxAgeSec: budget, reason: "source-state-expired",
      ...(["growth", "duration"].includes(source) ? { nextRetryAt: observedAt + budget + 901 } : {}),
      attempt: { count: 3, attemptedAt: observedAt + budget + 1, status: "skipped_locked" },
    });
    const recovered = await run("daily", [
      evaluation(source, "ok"),
    ], observedAt + budget + 900);
    expect(sources(recovered)[source]).toMatchObject({
      status: "ok", observedAt: observedAt + budget + 900,
    });
  });

  it("distinguishes explicitly disabled repair execution from missing and expired observations", async () => {
    const result = await run("daily", [
      evaluation("repair-debt", "ok", { mode: "disabled", enabled: false }),
      evaluation("growth", "ok", { quality: { reason: "row-count-threshold" } }),
    ], 100);
    const metadata = JSON.parse(result.metadata!);
    expect(result.status).toBe("ok");
    expect(metadata.sourceStatuses).toMatchObject({ "repair-debt": "disabled", freshness: "missing", growth: "ok" });
    expect(metadata.sources["repair-debt"]).toMatchObject({ observedAt: 100, maxAgeSec: 172_800 });
    expect(metadata.sources.freshness).toMatchObject({ observedAt: null, reason: "source-state-missing" });
    expect(metadata.quality.sources.growth).toEqual({ reason: "row-count-threshold" });
    const expired = await run("status", [
      evaluation("freshness", "ok"),
      evaluation("growth", "ok"),
    ], 172_901);
    expect(expired.status).toBe("ok");
    expect(JSON.parse(expired.metadata!).quality).toBeUndefined();
    expect(JSON.parse(expired.metadata!).sourceStatuses["repair-debt"]).toBe("expired");
  });

  it.each(["error", "skipped_neutral", "skipped_locked", "aborted"] as const)("caps cross-mode %s retries without losing failure evidence", async (outcome) => {
    await run("daily", (["growth", "duration"] as const).map(source => evaluation(source, "error")), 100);
    const attempts: string[] = [];
    const retry = async (source: CronSentinelRuleSource) => {
      attempts.push(source);
      return source === "growth" ? { status: outcome === "aborted" ? "skipped_neutral" : outcome,
        ...(outcome === "aborted" ? { aborted: true } : {}) } as CronResult : { status: "ok" } as CronResult;
    };
    for (const at of [1000, 1000, 1001]) await run("status", [], at, undefined, retry);
    expect(attempts).toEqual(["growth", "duration"]);
    const result = await run("status", [], 1002);
    expect(sources(result).growth).toMatchObject({
      observedAt: outcome === "error" ? 1000 : 100, reason: "source-evaluation-error", nextRetryAt: 1900, retryBackoffSec: 900,
      attempt: { count: 2, attemptedAt: 1000, mode: "status", status: outcome === "aborted" ? "incomplete" : outcome },
    });
    for (const at of [1900, 2800, 3700]) await run("turnover", [], at, undefined, retry);
    expect(attempts).toEqual(["growth", "duration", "growth", "growth"]);
    const capped = await run("reserve-post-sync", [], 4000, undefined, retry);
    expect(capped.status).toBe("error");
    expect(sources(capped).growth).toMatchObject({
      status: "error", reason: "source-retry-exhausted", nextRetryAt: null,
      retryAttemptLimit: 4, retryExhausted: true, attempt: { count: 4, attemptedAt: 2800 },
    });
    const expired = await run("status", [], 200_000, undefined, retry);
    expect(expired.status).toBe("degraded");
    expect(sources(expired).growth).toMatchObject({
      status: "expired", reason: "source-state-expired", lastStatus: "error", retryExhausted: true, nextRetryAt: null,
    });
    expect(attempts).toHaveLength(4);
    const daily = await run("daily", [evaluation("growth", "error")], 201_000);
    expect(sources(daily).growth).toMatchObject({ retryExhausted: false, attempt: { count: 1 } });
    const recovered = await run("status", [], 201_900, undefined, async () => ({ status: "ok" }));
    expect(sources(recovered).growth).toMatchObject({ status: "ok", attempt: { count: 2 } });
  });
});
