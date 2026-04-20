import { describe, expect, it } from "vitest";
import { pruneStatusProbeRuns, runPruneStatusProbeRuns } from "../prune-status-probe-runs";

interface ProbeRunRow {
  id: number;
  status: string;
  sample_count: number;
  pass_count: number;
  fail_count: number;
  p95_latency_ms: number;
  details_json: string;
  created_at: number;
}

/**
 * Minimal in-memory D1 stub that understands exactly the INSERT / DELETE /
 * SELECT COUNT(*) surface that the prune function and the test's verification
 * queries exercise. Keeps us from spinning up miniflare for a single TTL test.
 */
function createStubDb(): D1Database {
  const rows: ProbeRunRow[] = [];
  let nextId = 1;

  function prepare(sql: string): D1PreparedStatement {
    let bound: unknown[] = [];
    const stmt = {
      bind: (...args: unknown[]) => {
        bound = args;
        return stmt as unknown as D1PreparedStatement;
      },
      run: async () => {
        if (sql.startsWith("INSERT INTO status_probe_runs")) {
          const [status, sample, pass, fail, p95, details, createdAt] = bound as [
            string, number, number, number, number, string, number,
          ];
          rows.push({
            id: nextId++,
            status,
            sample_count: sample,
            pass_count: pass,
            fail_count: fail,
            p95_latency_ms: p95,
            details_json: details,
            created_at: createdAt,
          });
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.startsWith("DELETE FROM status_probe_runs")) {
          const [cutoffA, cutoffB, limit] = bound as [number, number, number];
          // DELETE ... WHERE created_at < cutoffA AND id IN (SELECT id ... WHERE created_at < cutoffB ORDER BY created_at ASC LIMIT ?)
          const eligible = rows
            .filter((row) => row.created_at < cutoffB)
            .sort((a, b) => a.created_at - b.created_at)
            .slice(0, limit);
          const eligibleIds = new Set(eligible.map((row) => row.id));
          let removed = 0;
          for (let i = rows.length - 1; i >= 0; i--) {
            const row = rows[i];
            if (row.created_at < cutoffA && eligibleIds.has(row.id)) {
              rows.splice(i, 1);
              removed += 1;
            }
          }
          return { success: true, meta: { changes: removed } };
        }
        return { success: true, meta: { changes: 0 } };
      },
      first: async () => {
        if (sql.startsWith("SELECT COUNT(*) AS cnt FROM status_probe_runs")) {
          return { cnt: rows.length };
        }
        return null;
      },
      all: async () => ({ results: [], success: true, meta: {} }),
    };
    return stmt as unknown as D1PreparedStatement;
  }

  return {
    prepare,
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

async function seedProbeRuns(
  db: D1Database,
  opts: { count: number; createdAt: number; statusRotation: Array<"healthy" | "degraded" | "stale"> },
) {
  for (let i = 0; i < opts.count; i++) {
    const status = opts.statusRotation[i % opts.statusRotation.length];
    await db
      .prepare(
        "INSERT INTO status_probe_runs (status, sample_count, pass_count, fail_count, p95_latency_ms, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(status, 50, 50, 0, 100, "{}", opts.createdAt)
      .run();
  }
}

describe("pruneStatusProbeRuns", () => {
  it("throws before D1 work when the cron signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("probe prune aborted"));

    await expect(runPruneStatusProbeRuns(createStubDb(), controller.signal)).rejects.toThrow("probe prune aborted");
  });

  it("deletes rows older than cutoffSec and stops at batchSize", async () => {
    const db = createStubDb();
    const now = Math.floor(Date.now() / 1000);
    const cutoffSec = now - 90 * 86_400;
    // Seed: 150 rows 91 days ago (candidates), 10 rows from today (must survive).
    await seedProbeRuns(db, {
      count: 150,
      createdAt: now - 91 * 86_400,
      statusRotation: ["healthy", "degraded", "stale"],
    });
    await seedProbeRuns(db, {
      count: 10,
      createdAt: now - 300,
      statusRotation: ["healthy"],
    });

    // First pass: batchSize=100 caps the deletion, leaving 50 eligible rows.
    const first = await pruneStatusProbeRuns(db, { cutoffSec, batchSize: 100 });
    expect(first.deleted).toBe(100);

    // Second pass finishes the backlog.
    const second = await pruneStatusProbeRuns(db, { cutoffSec, batchSize: 100 });
    expect(second.deleted).toBe(50);

    // Recent rows survive.
    const remaining = await db
      .prepare("SELECT COUNT(*) AS cnt FROM status_probe_runs")
      .first<{ cnt: number }>();
    expect(remaining?.cnt).toBe(10);
  });
});
