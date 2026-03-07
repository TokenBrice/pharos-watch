import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDiscrepancy,
  getDiscrepancyStreak,
  getLatestStatusProbe,
  getStatusStateSnapshot,
  listRecentStatusTransitions,
  markDiscrepancyAlertSent,
  markProbeFailureAlertSent,
  reconcileStatusState,
  updateDiscrepancyObservation,
  writeStatusProbeRun,
} from "../status-reliability";

type StatusLevel = "healthy" | "degraded" | "stale";

interface StatusStateRow {
  scope: string;
  current_status: StatusLevel;
  raw_status: StatusLevel;
  last_evaluated_at: number;
  last_changed_at: number;
  consecutive_healthy: number;
  consecutive_degraded: number;
  consecutive_stale: number;
  confidence: number;
  causes_json: string | null;
}

interface StatusTransitionRow {
  id: number;
  scope: string;
  previous_status: StatusLevel | null;
  next_status: StatusLevel;
  raw_status: StatusLevel;
  transition_type: "degrade" | "recover" | "init";
  reason: string;
  confidence: number;
  causes_json: string | null;
  created_at: number;
}

interface StatusProbeRow {
  created_at: number;
  status: StatusLevel;
  sample_count: number;
  pass_count: number;
  fail_count: number;
  p95_latency_ms: number;
  details_json: string | null;
}

interface DiscrepancyStateRow {
  scope: string;
  consecutive_divergent: number;
  last_divergent_at: number | null;
  last_alert_at: number | null;
  consecutive_probe_failures: number;
  last_probe_failure_at: number | null;
  last_probe_alert_at: number | null;
  updated_at: number;
}

function makeStatefulDb() {
  const store: {
    stateRow: StatusStateRow | null;
    transitions: StatusTransitionRow[];
    probes: StatusProbeRow[];
    discrepancy: DiscrepancyStateRow | null;
  } = {
    stateRow: null,
    transitions: [],
    probes: [],
    discrepancy: null,
  };

  const createStatement = (sql: string, boundValues: unknown[] = []) => ({
    bind: (...args: unknown[]) => createStatement(sql, args),
    all: async <T>() => {
      if (sql.includes("FROM status_transitions")) {
        const hasFrom = sql.includes("created_at >= ?");
        const hasTo = sql.includes("created_at <= ?");
        let argIndex = 1;
        const from = hasFrom ? Number(boundValues[argIndex++]) : null;
        const to = hasTo ? Number(boundValues[argIndex++]) : null;
        const limit = Number(boundValues[argIndex] ?? 30);

        const rows = store.transitions
          .filter((row) => row.scope === "global")
          .filter((row) => from == null || row.created_at >= from)
          .filter((row) => to == null || row.created_at <= to)
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, limit);
        return { results: rows as T[], success: true, meta: {} };
      }

      return { results: [] as T[], success: true, meta: {} };
    },
    first: async <T>() => {
      if (sql.includes("FROM status_state")) {
        return store.stateRow as T | null;
      }

      if (sql.includes("FROM status_probe_runs")) {
        const latest = [...store.probes].sort((a, b) => b.created_at - a.created_at)[0] ?? null;
        return latest as T | null;
      }

      if (sql.includes("SELECT consecutive_divergent FROM status_discrepancy_state")) {
        return (store.discrepancy
          ? { consecutive_divergent: store.discrepancy.consecutive_divergent }
          : null) as T | null;
      }

      if (sql.includes("FROM status_discrepancy_state")) {
        return store.discrepancy as T | null;
      }

      return null as T | null;
    },
    run: async () => {
      if (sql.includes("INSERT INTO status_state")) {
        store.stateRow = {
          scope: String(boundValues[0]),
          current_status: boundValues[1] as StatusLevel,
          raw_status: boundValues[2] as StatusLevel,
          last_evaluated_at: Number(boundValues[3]),
          last_changed_at: Number(boundValues[4]),
          consecutive_healthy: Number(boundValues[5]),
          consecutive_degraded: Number(boundValues[6]),
          consecutive_stale: Number(boundValues[7]),
          confidence: Number(boundValues[8]),
          causes_json: boundValues[9] as string | null,
        };
      } else if (sql.includes("UPDATE status_state")) {
        store.stateRow = {
          ...(store.stateRow ?? {
            scope: "global",
            current_status: "healthy",
            raw_status: "healthy",
            last_evaluated_at: 0,
            last_changed_at: 0,
            consecutive_healthy: 0,
            consecutive_degraded: 0,
            consecutive_stale: 0,
            confidence: 1,
            causes_json: "[]",
          }),
          current_status: boundValues[0] as StatusLevel,
          raw_status: boundValues[1] as StatusLevel,
          last_evaluated_at: Number(boundValues[2]),
          last_changed_at: Number(boundValues[3]),
          consecutive_healthy: Number(boundValues[4]),
          consecutive_degraded: Number(boundValues[5]),
          consecutive_stale: Number(boundValues[6]),
          confidence: Number(boundValues[7]),
          causes_json: boundValues[8] as string | null,
        };
      } else if (sql.includes("INSERT INTO status_transitions")) {
        store.transitions.push({
          id: store.transitions.length + 1,
          scope: String(boundValues[0]),
          previous_status: (boundValues[1] as StatusLevel | null) ?? null,
          next_status: boundValues[2] as StatusLevel,
          raw_status: boundValues[3] as StatusLevel,
          transition_type: boundValues[4] as "degrade" | "recover" | "init",
          reason: String(boundValues[5]),
          confidence: Number(boundValues[6]),
          causes_json: boundValues[7] as string | null,
          created_at: Number(boundValues[8]),
        });
      } else if (sql.includes("INSERT INTO status_probe_runs")) {
        store.probes.push({
          created_at: Number(boundValues[6]),
          status: boundValues[4] as StatusLevel,
          sample_count: Number(boundValues[0]),
          pass_count: Number(boundValues[1]),
          fail_count: Number(boundValues[2]),
          p95_latency_ms: Number(boundValues[3]),
          details_json: (boundValues[5] as string | null) ?? null,
        });
      } else if (sql.includes("INSERT INTO status_discrepancy_state")) {
        store.discrepancy = {
          scope: String(boundValues[0]),
          consecutive_divergent: Number(boundValues[1]),
          last_divergent_at: (boundValues[2] as number | null) ?? null,
          last_alert_at: (boundValues[3] as number | null) ?? null,
          consecutive_probe_failures: Number(boundValues[4]),
          last_probe_failure_at: (boundValues[5] as number | null) ?? null,
          last_probe_alert_at: (boundValues[6] as number | null) ?? null,
          updated_at: Number(boundValues[7]),
        };
      } else if (sql.includes("SET last_alert_at = ?")) {
        store.discrepancy = {
          ...(store.discrepancy ?? {
            scope: "global",
            consecutive_divergent: 0,
            last_divergent_at: null,
            last_alert_at: null,
            consecutive_probe_failures: 0,
            last_probe_failure_at: null,
            last_probe_alert_at: null,
            updated_at: 0,
          }),
          last_alert_at: Number(boundValues[0]),
          updated_at: Number(boundValues[1]),
        };
      } else if (sql.includes("SET last_probe_alert_at = ?")) {
        store.discrepancy = {
          ...(store.discrepancy ?? {
            scope: "global",
            consecutive_divergent: 0,
            last_divergent_at: null,
            last_alert_at: null,
            consecutive_probe_failures: 0,
            last_probe_failure_at: null,
            last_probe_alert_at: null,
            updated_at: 0,
          }),
          last_probe_alert_at: Number(boundValues[0]),
          updated_at: Number(boundValues[1]),
        };
      }

      return { success: true, meta: { changes: 1 } };
    },
  });

  const db = {
    prepare: (sql: string) => createStatement(sql),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;

  return { db, store };
}

function makeFailingDb(): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        all: async () => {
          throw new Error("missing migration");
        },
        first: async () => {
          throw new Error("missing migration");
        },
        run: async () => {
          throw new Error("missing migration");
        },
      }),
      all: async () => {
        throw new Error("missing migration");
      },
      first: async () => {
        throw new Error("missing migration");
      },
      run: async () => {
        throw new Error("missing migration");
      },
    }),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

describe("status-reliability", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("initializes state and clamps invalid confidence", async () => {
    const { db, store } = makeStatefulDb();
    const causes = [{ code: "seed", layer: "availability", severity: "warning", message: "seed" }] as const;

    const result = await reconcileStatusState(db, 100, "healthy", Number.POSITIVE_INFINITY, [...causes]);

    expect(result.effectiveStatus).toBe("healthy");
    expect(result.transition).toMatchObject({
      transitionType: "init",
      reason: "status-state-initialized",
      confidence: 0.1,
    });
    expect(store.stateRow?.current_status).toBe("healthy");
    expect(store.transitions).toHaveLength(1);
  });

  it("applies hysteresis across stale escalation and staged recoveries", async () => {
    const { db, store } = makeStatefulDb();

    await reconcileStatusState(db, 100, "healthy", 0.95, []);
    const stale = await reconcileStatusState(db, 160, "stale", 0.95, []);
    expect(stale.effectiveStatus).toBe("stale");
    expect(stale.transition?.reason).toBe("raw-stale-immediate-escalation");

    const hold = await reconcileStatusState(db, 200, "degraded", 0.95, []);
    expect(hold.effectiveStatus).toBe("stale");
    expect(hold.transition).toBeNull();

    const recoverToDegraded = await reconcileStatusState(db, 400, "degraded", 0.95, []);
    expect(recoverToDegraded.effectiveStatus).toBe("degraded");
    expect(recoverToDegraded.transition?.reason).toBe("raw-degraded-recovery-from-stale");

    await reconcileStatusState(db, 520, "healthy", 0.95, []);
    await reconcileStatusState(db, 640, "healthy", 0.95, []);
    const recoverToHealthy = await reconcileStatusState(db, 760, "healthy", 0.95, []);
    expect(recoverToHealthy.effectiveStatus).toBe("healthy");
    expect(recoverToHealthy.transition?.reason).toBe("raw-healthy-recovery-threshold");

    expect(store.transitions.map((row) => row.transition_type)).toEqual(["init", "degrade", "recover", "recover"]);
  });

  it("returns snapshots with staleness metadata and nulls on DB failure", async () => {
    const { db } = makeStatefulDb();
    await reconcileStatusState(db, 100, "degraded", 0.9, []);

    const snapshot = await getStatusStateSnapshot(db, 2_100);
    expect(snapshot.state?.currentStatus).toBe("degraded");
    expect(snapshot.staleness).toEqual({
      ageSeconds: 2_000,
      maxAgeSec: 1_800,
      isStale: true,
    });

    const failed = await getStatusStateSnapshot(makeFailingDb(), 2_100);
    expect(failed).toEqual({ state: null, staleness: null });
  });

  it("lists recent transitions with bounds and safely parses invalid causes", async () => {
    const { db, store } = makeStatefulDb();
    store.transitions.push(
      {
        id: 1,
        scope: "global",
        previous_status: null,
        next_status: "healthy",
        raw_status: "healthy",
        transition_type: "init",
        reason: "init",
        confidence: 1,
        causes_json: "[]",
        created_at: 100,
      },
      {
        id: 2,
        scope: "global",
        previous_status: "healthy",
        next_status: "degraded",
        raw_status: "degraded",
        transition_type: "degrade",
        reason: "degrade",
        confidence: 0.8,
        causes_json: "not-json",
        created_at: 200,
      },
      {
        id: 3,
        scope: "global",
        previous_status: "degraded",
        next_status: "healthy",
        raw_status: "healthy",
        transition_type: "recover",
        reason: "recover",
        confidence: 0.9,
        causes_json: '[{"code":"ok","layer":"availability","severity":"info","message":"ok"}]',
        created_at: 300,
      },
    );

    const rows = await listRecentStatusTransitions(db, 999, { from: 150, to: 300 });

    expect(rows).toHaveLength(2);
    expect(rows[0]?.at).toBe(300);
    expect(rows[0]?.causes).toHaveLength(1);
    expect(rows[1]?.at).toBe(200);
    expect(rows[1]?.causes).toEqual([]);
  });

  it("writes probe runs and returns latest probe or unknown fallback", async () => {
    const { db } = makeStatefulDb();

    expect(await getLatestStatusProbe(db)).toEqual({
      timestamp: null,
      status: "unknown",
      sampleCount: 0,
      passCount: 0,
      failCount: 0,
      p95LatencyMs: null,
    });

    await writeStatusProbeRun(db, 100, {
      status: "healthy",
      sampleCount: 10,
      passCount: 10,
      failCount: 0,
      p95LatencyMs: 180,
      details: { route: "/api/health" },
    });
    await writeStatusProbeRun(db, 200, {
      status: "degraded",
      sampleCount: 8,
      passCount: 6,
      failCount: 2,
      p95LatencyMs: 450,
    });

    expect(await getLatestStatusProbe(db)).toEqual({
      timestamp: 200,
      status: "degraded",
      sampleCount: 8,
      passCount: 6,
      failCount: 2,
      p95LatencyMs: 450,
    });
  });

  it("tracks discrepancy streaks and alert timestamps", async () => {
    const { db } = makeStatefulDb();

    const first = await updateDiscrepancyObservation(db, 100, true, true);
    expect(first).toEqual({
      consecutiveDivergent: 1,
      lastAlertAt: null,
      consecutiveProbeFailures: 1,
      lastProbeAlertAt: null,
    });

    await markDiscrepancyAlertSent(db, 200);
    await markProbeFailureAlertSent(db, 300);

    const second = await updateDiscrepancyObservation(db, 400, false, false);
    expect(second).toEqual({
      consecutiveDivergent: 0,
      lastAlertAt: 200,
      consecutiveProbeFailures: 0,
      lastProbeAlertAt: 300,
    });

    expect(await getDiscrepancyStreak(db)).toBe(0);
  });

  it("builds discrepancies for unknown, stale, and divergent probe states", () => {
    expect(
      buildDiscrepancy(
        "stale",
        {
          timestamp: null,
          status: "unknown",
          sampleCount: 0,
          passCount: 0,
          failCount: 0,
          p95LatencyMs: null,
        },
        500,
        2,
      ),
    ).toEqual({
      hasDivergence: false,
      severityDelta: 0,
      statusSeverity: 2,
      probeSeverity: -1,
      details: null,
      probeAgeSeconds: null,
      consecutiveDivergent: 2,
    });

    expect(
      buildDiscrepancy(
        "stale",
        {
          timestamp: 1,
          status: "healthy",
          sampleCount: 10,
          passCount: 10,
          failCount: 0,
          p95LatencyMs: 200,
        },
        2_000,
        1,
      ).hasDivergence,
    ).toBe(false);

    const divergent = buildDiscrepancy(
      "stale",
      {
        timestamp: 100,
        status: "healthy",
        sampleCount: 10,
        passCount: 10,
        failCount: 0,
        p95LatencyMs: 200,
      },
      200,
      3,
    );
    expect(divergent.hasDivergence).toBe(true);
    expect(divergent.severityDelta).toBe(2);
    expect(divergent.details).toBe("status=stale, probe=healthy, probeAge=100s");
  });
});
