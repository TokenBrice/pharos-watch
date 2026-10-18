import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { makeHealthyHealthResponse } from "@shared/test-utils/health-fixtures";
import { StatusCronDetailResponseSchema } from "@shared/types/status";
import { handleStatusCronDetailRoute } from "../status-cron-detail";
import { summarizeCronStatus, CRON_STATUS_LATEST_FACT_KEYS } from "../../lib/status/cron-status-summary";
import { STATUS_RAW_SNAPSHOT_CACHE_KEY } from "../../lib/status/raw-snapshot";
import {
  loadStatusPublicHealthSnapshot,
  STATUS_PUBLIC_HEALTH_SNAPSHOT_CACHE_KEY,
  writeStatusPublicHealthSnapshot,
} from "../../lib/status/public-health-snapshot";

const NOW = 1_800_000_000;

function detailRequest(job: string | null) {
  const request = new Request(`https://ops-api.pharos.watch/api/status-cron-detail${job ? `?job=${job}` : ""}`);
  return { trustedAdmin: true, request, url: new URL(request.url) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("handleStatusCronDetailRoute", () => {
  it("returns full run metadata for the requested job with summary outcome fields", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const metadata = { reason: "stale-slot-reconciled", childDisposition: "abandoned", progressUpdatedAt: NOW - 90,
        reconciledAt: NOW - 30, quality: { reason: "partial-cohort" }, bulky: "x".repeat(4_000) };
      sqlite.prepare(`INSERT INTO cron_runs (job, started_at, duration_ms, status, error, item_count, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run("sync-stablecoins", NOW - 120, 1_000, "error", "e".repeat(900), null, JSON.stringify(metadata));

      const res = await handleStatusCronDetailRoute({ db, ...detailRequest("sync-stablecoins") });
      expect(res.status).toBe(200);
      const body = StatusCronDetailResponseSchema.parse(await res.json());
      expect(body.job).toBe("sync-stablecoins");
      const latest = body.cron.runs[0]!;
      expect(latest.metadata).toMatchObject({ bulky: "x".repeat(4_000) });
      expect(latest.error).toHaveLength(900);
      expect(latest).toMatchObject({
        reason: "stale-slot-reconciled", childDisposition: "abandoned", progressUpdatedAt: NOW - 90,
        reconciledAt: NOW - 30, qualityReasons: ["partial-cohort"],
      });
    } finally {
      sqlite.close();
    }
  });

  it("rejects missing and unknown jobs without reading history", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      expect((await handleStatusCronDetailRoute({ db, ...detailRequest(null) })).status).toBe(400);
      expect((await handleStatusCronDetailRoute({ db, ...detailRequest("not-a-job") })).status).toBe(404);
    } finally {
      sqlite.close();
    }
  });
});

describe("summarizeCronStatus", () => {
  const detail = {
    expectedIntervalSec: 300,
    healthy: true,
    telemetryUnknown: false,
    confirmedOutputAt: NOW - 60,
    inFlight: { startedAt: NOW - 10, updatedAt: NOW - 5, stale: false, metadata: { resourcePressure: undefined, cursor: "a" } },
    runs: [
      { startedAt: NOW - 60, durationMs: 10, status: "ok" as const, error: "y".repeat(800), reason: "r",
        metadata: { freshSent: 3, perAlertType: { depeg: 1 }, authoritativePlanning: { big: true } } },
      { startedAt: NOW - 360, durationMs: 10, status: "error" as const, metadata: { large: "z".repeat(2_000) } },
    ],
  };

  it("drops metadata, bounds errors and keeps one latest-run fact set", () => {
    const summary = summarizeCronStatus("dispatch-telegram-alerts", detail);
    expect(summary.runs).toHaveLength(2);
    for (const run of summary.runs) expect(run).not.toHaveProperty("metadata");
    expect(summary.runs[0]!.error!.length).toBeLessThanOrEqual(501);
    expect(summary.runs[0]!.reason).toBe("r");
    expect(summary.latestRunFacts).toEqual({ freshSent: 3, perAlertType: { depeg: 1 } });
    expect(Object.keys(summary.latestRunFacts!).every((key) =>
      CRON_STATUS_LATEST_FACT_KEYS["dispatch-telegram-alerts"]!.includes(key))).toBe(true);
    expect(summary.inFlight).not.toHaveProperty("metadata");
    expect(summary).not.toHaveProperty("lastRun");
    expect(summary).not.toHaveProperty("recentRuns");
    expect(summary.confirmedOutputAt).toBe(NOW - 60);
  });

  it("serves no facts for jobs outside the registry", () => {
    expect(summarizeCronStatus("sync-blacklist", detail)).not.toHaveProperty("latestRunFacts");
  });
});

describe("public health snapshot independence", () => {
  it("reads only its own key, never the operator envelope", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const health = makeHealthyHealthResponse();
      expect(await writeStatusPublicHealthSnapshot(db, NOW, health)).toBe(true);
      // An unreadable operator envelope must not affect public admission.
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(STATUS_RAW_SNAPSHOT_CACHE_KEY, "{", NOW);
      const loaded = await loadStatusPublicHealthSnapshot(db, NOW + 30);
      expect(loaded).toMatchObject({ kind: "fresh", updatedAt: NOW });
      expect(loaded.kind === "fresh" ? loaded.payload.publicHealth.status : null).toBe(health.status);
      const rows = sqlite.prepare("SELECT key FROM cache ORDER BY key").all() as Array<{ key: string }>;
      expect(rows.map((row) => row.key)).toEqual([STATUS_PUBLIC_HEALTH_SNAPSHOT_CACHE_KEY, STATUS_RAW_SNAPSHOT_CACHE_KEY].sort());
    } finally {
      sqlite.close();
    }
  });

  it("reports missing when only the operator envelope exists", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(STATUS_RAW_SNAPSHOT_CACHE_KEY, "{}", NOW);
      await expect(loadStatusPublicHealthSnapshot(db, NOW)).resolves.toMatchObject({ kind: "missing" });
    } finally {
      sqlite.close();
    }
  });
});
