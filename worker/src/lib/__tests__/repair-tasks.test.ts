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

  it("no-ops the repair runner when mode is off", async () => {
    const db = mockD1();

    const result = await runWorkerRepairTaskRunner(db, { mode: "off", nowSec: NOW });

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(0);
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      mode: "off",
      skipped: "mode-off",
      claimed: 0,
    });
    expect(db.getHistory()).toEqual([]);
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

    const result = await runWorkerRepairTaskRunner(db, { mode: "shadow", nowSec: NOW });

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

  it("claims a bounded batch and closes or defers DDR repair tasks", async () => {
    const linkedTaskId = buildRepairTaskId("ddr-repair-required-event", "42");
    const unresolvedTaskId = buildRepairTaskId("ddr-repair-required-event", "43");
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
          stale_claim_count: 0,
        },
      },
      {
        match: "WHERE state IN (?,?) AND (next_attempt_at IS NULL OR next_attempt_at <= ?)",
        rows: [
          {
            task_id: linkedTaskId,
            kind: "ddr-repair-required-event",
            subject_id: "42",
            priority: 50,
            state: "open",
            attempt_count: 0,
            next_attempt_at: null,
            locked_until: null,
            payload_json: JSON.stringify({ eventId: 42, reason: "incident-conflict" }),
            created_at: NOW - 100,
            updated_at: NOW - 100,
          },
          {
            task_id: unresolvedTaskId,
            kind: "ddr-repair-required-event",
            subject_id: "43",
            priority: 50,
            state: "open",
            attempt_count: 0,
            next_attempt_at: null,
            locked_until: null,
            payload_json: JSON.stringify({ eventId: 43, reason: "incident-conflict" }),
            created_at: NOW - 90,
            updated_at: NOW - 90,
          },
        ],
      },
      {
        match: "WHERE state = 'claimed' AND (locked_until IS NULL OR locked_until <= ?)",
        rows: [],
      },
      {
        match: "FROM depeg_resolver_incident_event_links",
        matchBinds: [42],
        rows: [{ ok: 1 }],
        first: { ok: 1 },
      },
      {
        match: "FROM depeg_resolver_incident_event_links",
        matchBinds: [43],
        rows: [],
        first: null,
      },
      {
        match: "FROM depeg_events",
        matchBinds: [43],
        rows: [{ ok: 1 }],
        first: { ok: 1 },
      },
    ]);

    const result = await runWorkerRepairTaskRunner(db, {
      mode: "enabled",
      nowSec: NOW,
      batchLimit: 5,
    });

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(2);
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      mode: "enabled",
      dueCount: 2,
      claimed: 2,
      closed: 1,
      deferred: 1,
      failed: 0,
      outcomes: [
        {
          taskId: linkedTaskId,
          action: "closed",
          reason: "ddr-event-linked",
        },
        {
          taskId: unresolvedTaskId,
          action: "deferred",
          reason: "manual-ddr-repair-required",
        },
      ],
    });

    const history = db.getHistory();
    const claimUpdates = history.filter((entry) => entry.sql.includes("SET state = 'claimed'"));
    expect(claimUpdates).toHaveLength(2);
    expect(claimUpdates.map((entry) => entry.binds)).toEqual([
      [
        expect.stringContaining(`repair-runner:${NOW}:`),
        NOW + 15 * 60,
        NOW,
        NOW,
        linkedTaskId,
        "open",
        "deferred",
        NOW,
        NOW,
      ],
      [
        expect.stringContaining(`repair-runner:${NOW}:`),
        NOW + 15 * 60,
        NOW,
        NOW,
        unresolvedTaskId,
        "open",
        "deferred",
        NOW,
        NOW,
      ],
    ]);
    expect(history.find((entry) => entry.sql.includes("SET state = 'closed'"))?.binds).toEqual([
      NOW,
      NOW,
      linkedTaskId,
      expect.stringContaining(`repair-runner:${NOW}:`),
    ]);
    expect(history.find((entry) => entry.sql.includes("SET state = 'deferred'"))?.binds).toEqual([
      NOW + 24 * 60 * 60,
      "manual-ddr-repair-required",
      NOW,
      unresolvedTaskId,
      expect.stringContaining(`repair-runner:${NOW}:`),
    ]);
  });

  it("defers transient repair processing failures with truncated reasons so the next run can retry", async () => {
    const taskId = buildRepairTaskId("ddr-repair-required-event", "44");
    const failureReason = `temporary D1 failure: ${"x".repeat(600)}`;
    const truncatedFailureReason = failureReason.slice(0, 500);
    const firstRunDb = mockD1([
      {
        match: "COUNT(*) AS due_count",
        rows: [],
        first: { due_count: 1 },
      },
      {
        match: "COUNT(*) AS stale_claim_count",
        rows: [],
        first: { stale_claim_count: 0 },
      },
      {
        match: "WHERE state IN (?,?) AND (next_attempt_at IS NULL OR next_attempt_at <= ?)",
        rows: [{
          task_id: taskId,
          kind: "ddr-repair-required-event",
          subject_id: "44",
          priority: 50,
          state: "open",
          attempt_count: 0,
          next_attempt_at: null,
          locked_until: null,
          payload_json: JSON.stringify({ eventId: 44, reason: "incident-conflict" }),
          created_at: NOW - 100,
          updated_at: NOW - 100,
        }],
      },
      {
        match: "WHERE state = 'claimed' AND (locked_until IS NULL OR locked_until <= ?)",
        rows: [],
      },
      {
        match: "FROM depeg_resolver_incident_event_links",
        matchBinds: [44],
        rows: [],
        throwError: new Error(failureReason),
      },
    ]);

    const firstResult = await runWorkerRepairTaskRunner(firstRunDb, {
      mode: "enabled",
      nowSec: NOW,
      batchLimit: 5,
    });

    expect(firstResult.status).toBe("degraded");
    expect(JSON.parse(firstResult.metadata ?? "{}")).toMatchObject({
      claimed: 1,
      failed: 1,
      outcomes: [
        {
          taskId,
          action: "failed",
          reason: truncatedFailureReason,
        },
      ],
    });
    expect(firstRunDb.getHistory().find((entry) => entry.sql.includes("SET state = 'deferred'"))?.binds).toEqual([
      NOW + 24 * 60 * 60,
      truncatedFailureReason,
      NOW,
      taskId,
      expect.stringContaining(`repair-runner:${NOW}:`),
    ]);
    expect(truncatedFailureReason).toHaveLength(500);

    const retryAt = NOW + 24 * 60 * 60;
    const secondRunDb = mockD1([
      {
        match: "COUNT(*) AS due_count",
        rows: [],
        first: { due_count: 1 },
      },
      {
        match: "COUNT(*) AS stale_claim_count",
        rows: [],
        first: { stale_claim_count: 0 },
      },
      {
        match: "WHERE state IN (?,?) AND (next_attempt_at IS NULL OR next_attempt_at <= ?)",
        rows: [{
          task_id: taskId,
          kind: "ddr-repair-required-event",
          subject_id: "44",
          priority: 50,
          state: "deferred",
          attempt_count: 1,
          next_attempt_at: retryAt,
          locked_until: null,
          payload_json: JSON.stringify({ eventId: 44, reason: "incident-conflict" }),
          created_at: NOW - 100,
          updated_at: NOW,
        }],
      },
      {
        match: "WHERE state = 'claimed' AND (locked_until IS NULL OR locked_until <= ?)",
        rows: [],
      },
      {
        match: "FROM depeg_resolver_incident_event_links",
        matchBinds: [44],
        rows: [{ ok: 1 }],
        first: { ok: 1 },
      },
    ]);

    const secondResult = await runWorkerRepairTaskRunner(secondRunDb, {
      mode: "enabled",
      nowSec: retryAt,
      batchLimit: 5,
    });

    expect(secondResult.status).toBe("ok");
    expect(JSON.parse(secondResult.metadata ?? "{}")).toMatchObject({
      claimed: 1,
      closed: 1,
      failed: 0,
      outcomes: [
        {
          taskId,
          action: "closed",
          reason: "ddr-event-linked",
        },
      ],
    });
    expect(secondRunDb.getHistory().find((entry) => entry.sql.includes("SET state = 'closed'"))).toBeDefined();
  });
});
