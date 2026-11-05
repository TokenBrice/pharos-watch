import { describe, expect, it, vi } from "vitest";
import { getCronJobMeta } from "@shared/lib/cron-jobs";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { CONFIRMED_CRON_OUTPUT_AT_SQL as OUTPUT, LATEST_CONFIRMED_CRON_OUTPUT_SQL as LATEST } from "../../cron-output";
import {
  classifyFreshness,
  loadProducerFreshnessFacts,
  type FreshnessThreshold,
  type ProducerFreshnessFact,
} from "../freshness-oracle";

const NOW = 1_800_000_000;
const FACT: ProducerFreshnessFact = {
  job: "producer",
  lastSuccessAt: NOW,
  lastRunAt: NOW,
  expectedIntervalSec: 900,
  lastStatus: "ok",
};

describe("classifyFreshness parity boundaries", () => {
  const policy = (watchAt: FreshnessThreshold, staleAt = watchAt) => ({ watchAt, staleAt });
  const policies = [
    ["status x2", policy({ multiplier: 2 }), 1_800, 1_800],
    ["watchdog x2/x3", policy({ multiplier: 2 }, { multiplier: 3 }), 1_800, 2_700],
    ["canary 4h", policy({ absoluteSec: 14_400 }), 14_400, 14_400],
    ["canary 48h", policy({ absoluteSec: 172_800 }), 172_800, 172_800],
    ["digest 8.5h due-after", policy({ absoluteSec: 30_599 }), 30_599, 30_599],
    ["DEWS 2h", policy({ absoluteSec: 7_200 }), 7_200, 7_200],
  ] as const;

  it.each(policies)("matches %s immediately around each threshold", (_name, policy, watchAt, staleAt) => {
    const state = (age: number | null) => classifyFreshness({
      ...FACT, lastSuccessAt: age == null ? null : NOW - age,
    }, policy, NOW).state;
    expect(state(watchAt)).toBe("fresh");
    if (staleAt > watchAt) {
      expect(state(watchAt + 1)).toBe("watch");
      expect(state(staleAt)).toBe("watch");
    }
    expect(state(staleAt + 1)).toBe("stale");
    expect(state(null)).toBe("stale");
  });

  it.each([
    [NOW, "fresh", null],
    [NOW + 60, "fresh", null],
    [NOW + 61, "stale", "future-timestamp"],
    [NOW + 86400, "stale", "future-timestamp"],
    [NaN, "stale", "invalid-timestamp"],
    [null, "stale", "missing-timestamp"],
  ] as const)("admits timestamp %s without inventing a fresh age", (lastSuccessAt, state, timestampReason) => {
    expect(classifyFreshness({ ...FACT, lastSuccessAt }, policies[0][1], NOW)).toMatchObject({ state, timestampReason, ageSec: timestampReason == null ? 0 : null });
  });

  it.each([
    [120, NOW + 120, undefined, "fresh", 0, null],
    [181, NOW + 120, undefined, "stale", null, "future-timestamp"],
    [120, undefined, 120, "fresh", 0, null],
  ] as const)("admits overlap +%s (read %s, skew %s)", (offset, readAtSec, allowedFutureSkewSec, state, ageSec, timestampReason) => {
    expect(classifyFreshness({ ...FACT, lastSuccessAt: NOW + offset }, policies[0][1], NOW, {
      readAtSec, allowedFutureSkewSec,
    })).toMatchObject({ state, ageSec, timestampReason });
  });
});

describe("loadProducerFreshnessFacts", () => {
  it("range-prunes MAX history without changing facts", async () => {
    const sql: string[] = [];
    const { sqlite, db } = createLatestSchemaSqlite({ onAll: (query) => sql.push(query) });
    try {
      sqlite.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000)
        INSERT INTO cron_runs(job,started_at,duration_ms,status,item_count)
        SELECT 'alpha', ?-86400-x, 0, 'ok', 1 FROM n`).run(NOW);
      const insert = sqlite.prepare("INSERT INTO cron_runs(job,started_at,duration_ms,status,item_count,metadata) VALUES (?,?,?,?,1,?)");
      insert.run("alpha", NOW - 30, 0, "ok", null);
      insert.run("alpha", NOW - 10, 0, "error", null);
      // Older overlapping publication wins.
      insert.run("alpha", NOW - 900, 900000, "ok", JSON.stringify({ outputPublishedAt: NOW - 20 }));
      insert.run("other", NOW, 0, "ok", null);
      const jobs = ["alpha", "beta"];
      const prepare = vi.spyOn(db, "prepare");
      const facts = await loadProducerFreshnessFacts(db, NOW, jobs.map((job, i) => ({
        ...getCronJobMeta("snapshot-supply")!, job, intervalSec: 60 * (i + 1),
      })));
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(sql).toHaveLength(1);
      expect(sql[0]).toContain("last_liveness_at");
      expect(facts).toEqual([
        { job: "alpha", lastSuccessAt: NOW - 20, lastLivenessAt: NOW - 30, lastRunAt: NOW - 10,
          expectedIntervalSec: 60, lastStatus: "error" },
        { job: "beta", lastSuccessAt: null, lastLivenessAt: null, lastRunAt: null,
          expectedIntervalSec: 120, lastStatus: null },
      ]);
      // Frozen 588fe3bd8^ shapes; shared output evidence.
      const legacy = `SELECT job,started_at AS last_run_at,status AS last_status,last_success_at,last_liveness_at
FROM (SELECT job,started_at,status,MAX(${OUTPUT}) OVER (PARTITION BY job) AS last_success_at,
MAX(CASE WHEN status IN ('ok','degraded') AND COALESCE(json_extract(
CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,'$.childDisposition'),'')!='not_started'
THEN started_at END) OVER (PARTITION BY job) AS last_liveness_at,
ROW_NUMBER() OVER (PARTITION BY job ORDER BY started_at DESC,id DESC) AS row_number
FROM cron_runs WHERE job IN (?,?)) WHERE row_number=1`;
      const scalar = `SELECT MAX(${OUTPUT}) AS started_at FROM cron_runs WHERE job = ?1`;
      expect(sqlite.prepare(legacy).all(...jobs)).toEqual(
        sqlite.prepare(sql[0]).all(JSON.stringify(jobs)).filter((row) => row.last_run_at != null),
      );
      // Match MAX history, never the floor_run seek.
      const range = /SEARCH cron_runs USING INDEX idx_cron_runs_job_started \(job=\? AND started_at>\?\)/;
      const plan = (query: string, ...bindings: string[]) => sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`)
        .all(...bindings).some((row) => range.test(String(row.detail)));
      expect(plan(sql[0], JSON.stringify(jobs))).toBe(true);
      expect(plan(legacy, ...jobs)).toBe(false);
      for (const job of [...jobs, "other"]) {
        expect(sqlite.prepare(LATEST).get(job)).toEqual(sqlite.prepare(scalar).get(job));
        expect(plan(LATEST, job)).toBe(true);
        expect(plan(scalar, job)).toBe(false);
      }
    } finally {
      vi.restoreAllMocks();
      sqlite.close();
    }
  });
});
