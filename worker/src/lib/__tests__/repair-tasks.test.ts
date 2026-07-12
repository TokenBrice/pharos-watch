import { describe, expect, it } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import {
  buildRepairTaskId,
  loadRepairDebtSummary,
  runWorkerRepairTaskRunner,
  syncDdrRepairDebtTasks,
} from "../repair-tasks";

const NOW = 1_775_900_000;

describe("repair tasks", () => {
  it("builds deterministic repair task ids", () => {
    expect(buildRepairTaskId("ddr-repair-required-event", "42")).toBe("repair:ddr-repair-required-event:42");
  });

  it("dual-writes current DDR repair debt and closes stale DDR tasks", async () => {
    const db = mockD1();

    const result = await syncDdrRepairDebtTasks(
      db,
      [
        { eventId: 42, reason: "incident-conflict" },
        { eventId: 43, reason: "incident-conflict" },
      ],
      NOW,
    );

    expect(result).toEqual({ upserted: 2, closed: 1 });
    const history = db.getHistory();
    const upserts = history.filter((entry) => entry.sql.includes("INSERT INTO worker_repair_tasks"));
    expect(upserts).toHaveLength(2);
    expect(upserts[0].binds).toEqual([
      "repair:ddr-repair-required-event:42",
      "ddr-repair-required-event",
      "42",
      50,
      null,
      JSON.stringify({ eventId: 42, reason: "incident-conflict" }),
      NOW,
      NOW,
    ]);
    const close = history.find((entry) => entry.sql.includes("subject_id NOT IN"));
    expect(close?.binds).toEqual([
      NOW,
      NOW,
      "ddr-repair-required-event",
      "open",
      "claimed",
      "deferred",
      "failed",
      "42",
      "43",
    ]);
  });

  it("summarizes open repair debt by kind", async () => {
    const db = mockD1([
      {
        match: "FROM worker_repair_tasks",
        rows: [
          {
            kind: "ddr-repair-required-event",
            open_count: 2,
            oldest_created_at: NOW - 3600,
            next_attempt_at: NOW + 900,
          },
          {
            kind: "reserve-history-gap",
            open_count: 1,
            oldest_created_at: NOW - 7200,
            next_attempt_at: null,
          },
        ],
      },
    ]);

    const summary = await loadRepairDebtSummary(db, NOW);

    expect(summary).toEqual({
      status: "present",
      openCount: 3,
      oldestAgeSec: 7200,
      byKind: {
        "ddr-repair-required-event": {
          openCount: 2,
          oldestAgeSec: 3600,
          nextRunnerDueAt: NOW + 900,
        },
        "reserve-history-gap": {
          openCount: 1,
          oldestAgeSec: 7200,
          nextRunnerDueAt: null,
        },
      },
      availabilityEscalated: false,
      nextRunnerDueAt: NOW + 900,
      source: "worker-repair-tasks",
    });
  });

  it("inspects due repair tasks in shadow mode without claiming rows", async () => {
    const db = mockD1([
      {
        match: "COUNT(*) AS due_count",
        rows: [],
        first: {
          due_count: 2,
        },
      },
      {
        match: "COUNT(*) AS stale_claim_count",
        rows: [],
        first: {
          stale_claim_count: 1,
        },
      },
    ]);

    const result = await runWorkerRepairTaskRunner(db, { nowSec: NOW });

    expect(result.status).toBe("ok");
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      mode: "shadow",
      skipped: "shadow-mode",
      dueCount: 2,
      staleClaimCount: 1,
      claimed: 0,
    });
    expect(db.getHistory().some((entry) => entry.sql.includes("SET state = 'claimed'"))).toBe(false);
  });
});
