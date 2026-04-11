import { describe, expect, it } from "vitest";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { mockD1 } from "../../../api/__tests__/helpers/mock-d1";
import { loadCronHealth } from "../cron-health";

interface SeedRun {
  job: string;
  status: "ok" | "error" | "degraded";
  ageSec: number;
}

function makeCronRow(job: string, status: string, ageSec: number, now: number): Record<string, unknown> {
  return {
    job,
    started_at: now - ageSec,
    duration_ms: 100,
    status,
    error: status === "error" ? "test-error" : null,
    item_count: 1,
    metadata: null,
  };
}

function seedWithOverrides(now: number, overrides: SeedRun[]): Record<string, unknown>[] {
  const base: Map<string, Record<string, unknown>[]> = new Map();
  for (const job of Object.keys(CRON_INTERVALS)) {
    base.set(job, [makeCronRow(job, "ok", 30, now)]);
  }
  const clearedForOverride = new Set<string>();
  for (const override of overrides) {
    if (!clearedForOverride.has(override.job)) {
      base.set(override.job, []);
      clearedForOverride.add(override.job);
    }
    base.get(override.job)!.push(makeCronRow(override.job, override.status, override.ageSec, now));
  }
  return [...base.values()]
    .flat()
    .sort((a, b) => (b.started_at as number) - (a.started_at as number));
}

function makeDb(_now: number, rows: Record<string, unknown>[]) {
  return mockD1([
    { match: "ROW_NUMBER() OVER", rows },
    { match: "FROM cron_leases", rows: [] },
    { match: "FROM cron_run_progress", rows: [] },
  ]);
}

describe("loadCronHealth — availabilityImpactingConsecutiveCronErrors", () => {
  // Fixed epoch-seconds value so test assertions are deterministic and do not
  // drift with wall-clock time. Matches the production `now` argument shape
  // (Math.floor(Date.now() / 1000)).
  const NOW = 1_775_890_000;

  it("returns 0 when a critical cron has only one error run followed by ok", async () => {
    // After the base ok row is cleared (because sync-stablecoins appears in
    // overrides), we explicitly seed an earlier ok run so the streak check
    // has a non-error previous entry to compare against.
    const rows = seedWithOverrides(NOW, [
      { job: "sync-stablecoins", status: "error", ageSec: 30 },
      { job: "sync-stablecoins", status: "ok", ageSec: 900 },
    ]);
    const snapshot = await loadCronHealth(makeDb(NOW, rows), NOW);
    expect(snapshot.availabilityImpactingCronErrors).toBe(1);
    expect(snapshot.availabilityImpactingConsecutiveCronErrors).toBe(0);
  });

  it("returns 1 when exactly one critical cron has 2 consecutive errors", async () => {
    const rows = seedWithOverrides(NOW, [
      { job: "sync-stablecoins", status: "error", ageSec: 30 },
      { job: "sync-stablecoins", status: "error", ageSec: 900 },
      { job: "sync-stablecoins", status: "ok", ageSec: 1800 },
    ]);
    const snapshot = await loadCronHealth(makeDb(NOW, rows), NOW);
    expect(snapshot.availabilityImpactingCronErrors).toBe(1);
    expect(snapshot.availabilityImpactingConsecutiveCronErrors).toBe(1);
  });

  it("returns 2 when two critical crons each have 2 consecutive errors", async () => {
    const rows = seedWithOverrides(NOW, [
      { job: "sync-stablecoins", status: "error", ageSec: 30 },
      { job: "sync-stablecoins", status: "error", ageSec: 900 },
      { job: "sync-fx-rates", status: "error", ageSec: 30 },
      { job: "sync-fx-rates", status: "error", ageSec: 900 },
    ]);
    const snapshot = await loadCronHealth(makeDb(NOW, rows), NOW);
    expect(snapshot.availabilityImpactingCronErrors).toBe(2);
    expect(snapshot.availabilityImpactingConsecutiveCronErrors).toBe(2);
  });

  it("ignores watch-tier error streaks", async () => {
    // sync-dex-liquidity is watch-tier (not critical)
    const rows = seedWithOverrides(NOW, [
      { job: "sync-dex-liquidity", status: "error", ageSec: 30 },
      { job: "sync-dex-liquidity", status: "error", ageSec: 1800 },
    ]);
    const snapshot = await loadCronHealth(makeDb(NOW, rows), NOW);
    expect(snapshot.availabilityImpactingConsecutiveCronErrors).toBe(0);
  });

  it("resets the streak when the previous run was not an error", async () => {
    const rows = seedWithOverrides(NOW, [
      { job: "sync-stablecoins", status: "error", ageSec: 30 },
      { job: "sync-stablecoins", status: "ok", ageSec: 900 },
      { job: "sync-stablecoins", status: "error", ageSec: 1800 },
    ]);
    const snapshot = await loadCronHealth(makeDb(NOW, rows), NOW);
    // Most recent 2 runs are error/ok → streak is 0
    expect(snapshot.availabilityImpactingConsecutiveCronErrors).toBe(0);
  });
});
