import { describe, expect, it } from "vitest";
import { mockD1, type MockD1Database, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { makeSqliteD1, type SqliteD1 } from "./repair-tasks.test-support";
import {
  buildDdrRepairTaskId,
  DDR_REPAIR_RUNNER_BACKOFF_SEC_V1,
  DDR_REPAIR_RUNNER_BATCH_LIMIT_V1,
  loadDdrRepairDebtDetails,
  loadRepairDebtSummary,
  pruneRepairTasks,
  runWorkerRepairTaskRunner,
  syncDdrRepairDebtTasks,
} from "../repair-tasks";

const NOW = 1_775_900_000;

const REPAIR_TASK_RUNNER_TABLES: MockTableConfig[] = [
  { match: "INSERT INTO worker_repair_tasks", rows: [] },
  { match: "UPDATE worker_repair_tasks", rows: [], runMeta: { changes: 1 } },
  { match: "SELECT state FROM worker_repair_tasks", rows: [], first: { state: "closed" } },
  { match: "FROM worker_repair_tasks", rows: [] },
  { match: "INSERT INTO depeg_resolver_event_repair_authorization_consumptions", rows: [] },
  { match: "INSERT INTO depeg_resolver_incident_event_links", rows: [] },
  { match: "INSERT INTO depeg_resolver_incident_revisions", rows: [] },
  { match: "UPDATE depeg_resolver_incidents", rows: [] },
];

function mockRepairD1(tables: MockTableConfig[] = []): MockD1Database {
  return mockD1([...tables, ...REPAIR_TASK_RUNNER_TABLES]);
}


function seedNaturalPredecessorFixture(
  db: SqliteD1,
  options: { includeRevision?: boolean } = {},
): void {
  db.sqlite.exec(`
    INSERT INTO depeg_events
      (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
       started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source)
    VALUES
      (40, 'cngn-compliant-naira', 'cNGN', 'peggedNGN', 'below', -150,
       ${NOW - 7200}, ${NOW - 7100}, 0.985, 0.985, 0.986, 1, 'live'),
      (41, 'cngn-compliant-naira', 'cNGN', 'peggedNGN', 'below', -150,
       ${NOW - 1800}, ${NOW - 1200}, 0.985, 0.985, 0.986, 1, 'live'),
      (42, 'cngn-compliant-naira', 'cNGN', 'peggedNGN', 'below', -150,
       ${NOW - 600}, NULL, 0.985, 0.985, NULL, 1, 'live');

    INSERT INTO depeg_resolver_incident_event_links
      (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
    VALUES
      ('ddr2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 40, 'observed', NULL, ${NOW - 7000}, 'initial'),
      ('ddr2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 41, 'repair_replacement', NULL, ${NOW - 1100}, 'natural adoption');

    INSERT INTO depeg_resolver_incidents
      (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id,
       first_started_at, current_started_at, first_observed_peak_bucket_bps, incident_state,
       superseded_by_incident_key, source_fingerprint, created_at, updated_at)
    VALUES
      ('ddr2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'cngn-compliant-naira', 'NGN', 'below', 40, 41,
       ${NOW - 7200}, ${NOW - 1800}, 150, 'active', NULL, '${"a".repeat(64)}', ${NOW - 7000}, ${NOW - 1100});

    ${options.includeRevision === false ? "" : `
      INSERT INTO depeg_resolver_incident_revisions
        (incident_key, previous_event_id, current_event_id, reason, repair_authorization_id, erratum_id, created_at, created_by)
      VALUES
        ('ddr2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 40, 41, 'natural adoption', NULL, NULL, ${NOW - 1100}, 'fixture');
    `}

    INSERT INTO worker_repair_tasks
      (task_id, kind, subject_id, priority, state, attempt_count, payload_json, created_at, updated_at)
    VALUES
      ('repair:ddr-repair-required-event:42', 'ddr-repair-required-event', '42', 50, 'open', 0,
       '{"eventId":42,"reason":"explicit repair required"}', ${NOW - 600}, ${NOW - 600});
  `);
}

describe("repair tasks", () => {
  it("surfaces a missing mandatory repair-task table during pruning", async () => {
    const db = mockRepairD1([
      {
        match: "DELETE FROM worker_repair_tasks",
        rows: [],
        throwError: new Error("D1_ERROR: no such table: worker_repair_tasks"),
      },
    ]);

    await expect(pruneRepairTasks(db, NOW - 1)).rejects.toThrow(
      "D1_ERROR: no such table: worker_repair_tasks",
    );
  });

  it("surfaces a missing mandatory repair-task table from the runner", async () => {
    const db = mockRepairD1([
      {
        match: "COUNT(*) AS due_count",
        rows: [],
        throwError: new Error("D1_ERROR: no such table: worker_repair_tasks"),
      },
    ]);

    await expect(
      runWorkerRepairTaskRunner(db, { nowSec: NOW }),
    ).rejects.toThrow("D1_ERROR: no such table: worker_repair_tasks");
  });

  it("builds deterministic repair task ids", () => {
    expect(buildDdrRepairTaskId("42")).toBe("repair:ddr-repair-required-event:42");
  });

  it("syncs current DDR repair tasks and closes stale DDR tasks", async () => {
    const db = mockRepairD1();

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
    expect(close?.sql).toContain("state IN ('open', 'deferred')");
    expect(close?.sql).toContain("state = 'failed'");
    expect(close?.binds).toEqual([
      NOW,
      NOW,
      "ddr-repair-required-event",
      NOW,
      "42",
      "43",
    ]);
  });

  it("preserves claimed tasks and failed backoff while reconciling obsolete repair debt", async () => {
    const db = makeSqliteD1();
    try {
      db.sqlite.exec(`
        INSERT INTO worker_repair_tasks
          (task_id, kind, subject_id, priority, state, attempt_count, next_attempt_at, locked_by, locked_until,
           payload_json, created_at, updated_at)
        VALUES
          ('repair:ddr-repair-required-event:1', 'ddr-repair-required-event', '1', 50, 'claimed', 1, NULL,
           'runner', ${NOW + 900}, '{"eventId":1}', ${NOW - 100}, ${NOW - 100}),
          ('repair:ddr-repair-required-event:2', 'ddr-repair-required-event', '2', 50, 'failed', 1, ${NOW + 900}, NULL, NULL,
           '{"eventId":2}', ${NOW - 100}, ${NOW - 100}),
          ('repair:ddr-repair-required-event:3', 'ddr-repair-required-event', '3', 50, 'failed', 1, ${NOW - 1}, NULL, NULL,
           '{"eventId":3}', ${NOW - 100}, ${NOW - 100}),
          ('repair:ddr-repair-required-event:4', 'ddr-repair-required-event', '4', 50, 'open', 0, NULL, NULL, NULL,
           '{"eventId":4}', ${NOW - 100}, ${NOW - 100}),
          ('repair:ddr-repair-required-event:5', 'ddr-repair-required-event', '5', 50, 'failed', 1, ${NOW + 900}, NULL, NULL,
           '{"eventId":5}', ${NOW - 100}, ${NOW - 100}),
          ('repair:ddr-repair-required-event:6', 'ddr-repair-required-event', '6', 50, 'closed', 1, NULL, NULL, NULL,
           '{"eventId":6}', ${NOW - 100}, ${NOW - 100}),
          ('repair:ddr-repair-required-event:7', 'ddr-repair-required-event', '7', 50, 'deferred', 1, NULL, NULL, NULL,
           '{"eventId":7}', ${NOW - 100}, ${NOW - 100});
      `);

      const result = await syncDdrRepairDebtTasks(
        db,
        [
          { eventId: 5, reason: "still-ambiguous" },
          { eventId: 6, reason: "reopened" },
        ],
        NOW,
      );

      expect(result).toEqual({ upserted: 2, closed: 3 });
      const states = db.sqlite.prepare(
        "SELECT subject_id, state, next_attempt_at FROM worker_repair_tasks ORDER BY subject_id",
      ).all() as Array<{ subject_id: string; state: string; next_attempt_at: number | null }>;
      expect(states).toEqual([
        { subject_id: "1", state: "claimed", next_attempt_at: null },
        { subject_id: "2", state: "failed", next_attempt_at: NOW + 900 },
        { subject_id: "3", state: "closed", next_attempt_at: NOW - 1 },
        { subject_id: "4", state: "closed", next_attempt_at: null },
        { subject_id: "5", state: "failed", next_attempt_at: NOW + 900 },
        { subject_id: "6", state: "open", next_attempt_at: null },
        { subject_id: "7", state: "closed", next_attempt_at: null },
      ]);
    } finally {
      db.close();
    }
  });

  it("prunes only old closed repair tasks in SQLite", async () => {
    const db = makeSqliteD1();
    try {
      db.sqlite.exec(`
        INSERT INTO worker_repair_tasks
          (task_id, kind, subject_id, state, created_at, updated_at)
        VALUES
          ('repair:ddr-repair-required-event:old-closed', 'ddr-repair-required-event', 'old-closed', 'closed', ${NOW}, ${NOW - 200}),
          ('repair:ddr-repair-required-event:new-closed', 'ddr-repair-required-event', 'new-closed', 'closed', ${NOW}, ${NOW - 50}),
          ('repair:ddr-repair-required-event:old-failed', 'ddr-repair-required-event', 'old-failed', 'failed', ${NOW}, ${NOW - 200});
      `);

      await expect(pruneRepairTasks(db, NOW - 100)).resolves.toBe(1);
      expect(db.sqlite.prepare(
        "SELECT subject_id, state FROM worker_repair_tasks ORDER BY subject_id",
      ).all()).toEqual([
        { subject_id: "new-closed", state: "closed" },
        { subject_id: "old-failed", state: "failed" },
      ]);
    } finally {
      db.close();
    }
  });

  it("summarizes the fixed DDR repair debt kind", async () => {
    const db = mockRepairD1([
      {
        match: "FROM worker_repair_tasks",
        rows: [
          {
            open_count: 2,
            oldest_created_at: NOW - 3600,
            next_attempt_at: NOW + 900,
          },
        ],
      },
    ]);

    const summary = await loadRepairDebtSummary(db, NOW);

    expect(summary).toEqual({
      status: "present",
      openCount: 2,
      oldestAgeSec: 3600,
      byKind: {
        "ddr-repair-required-event": {
          openCount: 2,
          oldestAgeSec: 3600,
          nextRunnerDueAt: NOW + 900,
        },
      },
      availabilityEscalated: false,
      nextRunnerDueAt: NOW + 900,
      source: "worker-repair-tasks",
    });
  });

  it("projects bounded DDR repair details from active task rows", async () => {
    const db = mockRepairD1([
      {
        match: "COUNT(*) OVER ()",
        rows: [
          {
            subject_id: "43",
            payload_json: JSON.stringify({ eventId: 43, reason: "failed-repair" }),
            updated_at: NOW - 120,
            total_count: 3,
            latest_updated_at: NOW - 60,
          },
          {
            subject_id: "42",
            payload_json: JSON.stringify({ eventId: 42, reason: "incident-conflict" }),
            updated_at: NOW - 60,
            total_count: 3,
            latest_updated_at: NOW - 60,
          },
          {
            subject_id: "44",
            payload_json: JSON.stringify({ eventId: 44, reason: "deferred-repair" }),
            updated_at: NOW - 180,
            total_count: 3,
            latest_updated_at: NOW - 60,
          },
        ],
      },
    ]);

    const details = await loadDdrRepairDebtDetails(db);

    expect(details).toEqual({
      checkedAt: NOW - 60,
      count: 3,
      events: [
        { eventId: 42, reason: "incident-conflict" },
        { eventId: 43, reason: "failed-repair" },
        { eventId: 44, reason: "deferred-repair" },
      ],
      eventsTruncated: false,
    });
    expect(db.getHistory()[0]?.binds).toEqual([
      "ddr-repair-required-event",
    ]);
  });

  it("bounds the detail page while aggregating every active task", async () => {
    const db = makeSqliteD1();
    try {
      const insert = db.sqlite.prepare(`INSERT INTO worker_repair_tasks
        (task_id, kind, subject_id, state, payload_json, created_at, updated_at)
        VALUES (?, 'ddr-repair-required-event', ?, ?, ?, ?, ?)`);
      for (let id = 30; id >= 1; id--) {
        insert.run(`task:${id}`, String(id), "open", JSON.stringify({ reason: `reason-${id}` }), NOW - 100, NOW - 30 + id);
      }
      insert.run("closed", "0", "closed", '{"reason":"closed"}', NOW, NOW + 100);
      await expect(loadDdrRepairDebtDetails(db)).resolves.toEqual({
        checkedAt: NOW,
        count: 30,
        events: Array.from({ length: 25 }, (_, index) => ({ eventId: index + 1, reason: `reason-${index + 1}` })),
        eventsTruncated: true,
      });
    } finally {
      db.close();
    }
  });

  it("omits malformed details without hiding active debt", async () => {
    const db = makeSqliteD1();
    try {
      db.sqlite.exec(`INSERT INTO worker_repair_tasks
        (task_id, kind, subject_id, state, payload_json, created_at, updated_at) VALUES
        ('valid', 'ddr-repair-required-event', '3', 'open', '{"reason":"valid"}', ${NOW}, ${NOW}),
        ('json', 'ddr-repair-required-event', '1', 'failed', '{', ${NOW}, ${NOW}),
        ('fraction', 'ddr-repair-required-event', '2.5', 'deferred', '{"reason":"invalid"}', ${NOW}, ${NOW})`);
      await expect(loadDdrRepairDebtDetails(db)).resolves.toEqual({
        checkedAt: NOW, count: 3, events: [{ eventId: 3, reason: "valid" }], eventsTruncated: true,
      });
    } finally {
      db.close();
    }
  });

  it("returns an empty DDR detail projection when no active task rows exist", async () => {
    const db = mockRepairD1([
      {
        match: "COUNT(*) OVER ()",
        rows: [],
      },
    ]);

    await expect(loadDdrRepairDebtDetails(db)).resolves.toEqual({
      checkedAt: null,
      count: 0,
      events: [],
      eventsTruncated: false,
    });
  });

  it("reports an empty execution run without claiming rows", async () => {
    const db = mockRepairD1([
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
      mode: "execute",
      enabled: true,
      dueCount: 2,
      staleClaimCount: 1,
      claimed: 0,
      autoRepairCount: 0,
    });
    expect(db.getHistory().find((entry) => entry.sql.includes("COUNT(*) AS due_count"))?.binds).toEqual([
      NOW,
    ]);
    expect(db.getHistory().some((entry) => entry.sql.includes("SET state = 'claimed'"))).toBe(false);
  });

  it("gates claims behind the kill switch while keeping backlog counts observable", async () => {
    const db = mockRepairD1([
      {
        match: "COUNT(*) AS due_count",
        rows: [],
        first: { due_count: 2 },
      },
      {
        match: "COUNT(*) AS stale_claim_count",
        rows: [],
        first: { stale_claim_count: 1 },
      },
    ]);

    const result = await runWorkerRepairTaskRunner(db, { nowSec: NOW, enabled: false });

    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      mode: "disabled",
      enabled: false,
      skipped: "kill-switch",
      dueCount: 2,
      staleClaimCount: 1,
      claimed: 0,
      autoRepairCount: 0,
    });
    expect(db.getHistory().some((entry) => entry.sql.includes("SET state = 'claimed'"))).toBe(false);
  });

  it("claims due deferred, failed, and stale rows through SQLite lease transitions", async () => {
    const db = makeSqliteD1();
    try {
      db.sqlite.exec(`
        INSERT INTO worker_repair_tasks
          (task_id, kind, subject_id, priority, state, attempt_count, next_attempt_at, locked_by, locked_until,
           payload_json, created_at, updated_at)
        VALUES
          ('repair:ddr-repair-required-event:1', 'ddr-repair-required-event', '1', 50, 'deferred', 1, ${NOW - 1}, NULL, NULL,
           '{"eventId":1}', ${NOW - 300}, ${NOW - 300}),
          ('repair:ddr-repair-required-event:2', 'ddr-repair-required-event', '2', 50, 'failed', 2, ${NOW - 1}, NULL, NULL,
           '{"eventId":2}', ${NOW - 200}, ${NOW - 200}),
          ('repair:ddr-repair-required-event:3', 'ddr-repair-required-event', '3', 50, 'claimed', 3, NULL, 'old-owner', ${NOW - 1},
           '{"eventId":3}', ${NOW - 100}, ${NOW - 100});
      `);

      const result = await runWorkerRepairTaskRunner(db, { nowSec: NOW });

      expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
        dueCount: 2,
        staleClaimCount: 1,
        claimed: 3,
        deferred: 3,
        failed: 0,
      });
      expect(db.sqlite.prepare(
        "SELECT subject_id, state, attempt_count, next_attempt_at, locked_by, locked_until, last_error FROM worker_repair_tasks ORDER BY subject_id",
      ).all()).toEqual([
        {
          subject_id: "1",
          state: "deferred",
          attempt_count: 2,
          next_attempt_at: NOW + DDR_REPAIR_RUNNER_BACKOFF_SEC_V1,
          locked_by: null,
          locked_until: null,
          last_error: "safe-class-not-proven",
        },
        {
          subject_id: "2",
          state: "deferred",
          attempt_count: 3,
          next_attempt_at: NOW + DDR_REPAIR_RUNNER_BACKOFF_SEC_V1,
          locked_by: null,
          locked_until: null,
          last_error: "safe-class-not-proven",
        },
        {
          subject_id: "3",
          state: "deferred",
          attempt_count: 4,
          next_attempt_at: NOW + DDR_REPAIR_RUNNER_BACKOFF_SEC_V1,
          locked_by: null,
          locked_until: null,
          last_error: "safe-class-not-proven",
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("selects only the five highest-priority due tasks", async () => {
    const db = makeSqliteD1();
    try {
      const insert = db.sqlite.prepare(`INSERT INTO worker_repair_tasks
        (task_id, kind, subject_id, priority, state, payload_json, created_at, updated_at)
        VALUES (?, 'ddr-repair-required-event', ?, ?, 'open', ?, ?, ?)`);
      for (let id = 1; id <= 6; id++) {
        insert.run(`task:${id}`, String(id), 7 - id, JSON.stringify({ eventId: id }), NOW - id, NOW - id);
      }
      const result = await runWorkerRepairTaskRunner(db, { nowSec: NOW });
      expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
        claimed: 5, deferred: 5, failed: 0, autoRepairCount: 0,
        batchLimit: DDR_REPAIR_RUNNER_BATCH_LIMIT_V1,
      });
      expect(db.sqlite.prepare(
        "SELECT subject_id FROM worker_repair_tasks WHERE state = 'deferred' ORDER BY priority",
      ).all()).toEqual(["6", "5", "4", "3", "2"].map((subject_id) => ({ subject_id })));
      expect(db.sqlite.prepare(
        "SELECT state, attempt_count, updated_at, next_attempt_at FROM worker_repair_tasks WHERE task_id = 'task:1'",
      ).get()).toEqual({ state: "open", attempt_count: 0, updated_at: NOW - 1, next_attempt_at: null });
    } finally {
      db.close();
    }
  });

  it("backs off a claimed task when execution fails", async () => {
    const db = mockRepairD1([
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
        match: "SELECT task_id, subject_id, payload_json",
        rows: [{
          task_id: "repair:ddr-repair-required-event:42",
          subject_id: "42",
          payload_json: JSON.stringify({ eventId: 42 }),
        }],
      },
      {
        match: "FROM depeg_events target",
        rows: [],
        throwError: new Error("D1 busy"),
      },
    ]);

    const result = await runWorkerRepairTaskRunner(db, { nowSec: NOW });

    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      claimed: 1,
      failed: 1,
      deferred: 0,
      autoRepairCount: 0,
    });
    const failure = db.getHistory().find((entry) => entry.binds.includes("repair-execution-failed"));
    expect(failure?.binds).toContain("failed");
    expect(failure?.binds).toContain(NOW + DDR_REPAIR_RUNNER_BACKOFF_SEC_V1);
  });


  it("repairs a safe fixture task atomically against the append-only DDR tables", async () => {
    const db = makeSqliteD1();
    try {
      db.sqlite.exec(`
        INSERT INTO depeg_events
          (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
           started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source)
        VALUES
          (40, 'cngn-compliant-naira', 'cNGN', 'peggedNGN', 'below', -150,
           ${NOW - 7200}, ${NOW - 7100}, 0.985, 0.985, 0.986, 1, 'live'),
          (41, 'cngn-compliant-naira', 'cNGN', 'peggedNGN', 'below', -150,
           ${NOW - 1800}, ${NOW - 1200}, 0.985, 0.985, 0.986, 1, 'live'),
          (42, 'cngn-compliant-naira', 'cNGN', 'peggedNGN', 'below', -150,
           ${NOW - 600}, NULL, 0.985, 0.985, NULL, 1, 'live');

        INSERT INTO depeg_resolver_incident_event_links
          (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
        VALUES
          ('ddr2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 40, 'observed', NULL, ${NOW - 7000}, 'initial'),
          ('ddr2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 41, 'repair_replacement', 1, ${NOW - 1100}, 'prior safe repair');

        INSERT INTO depeg_resolver_incidents
          (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id,
           first_started_at, current_started_at, first_observed_peak_bucket_bps, incident_state,
           superseded_by_incident_key, source_fingerprint, created_at, updated_at)
        VALUES
          ('ddr2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'cngn-compliant-naira', 'NGN', 'below', 40, 41,
           ${NOW - 7200}, ${NOW - 1800}, 150, 'active', NULL, '${"a".repeat(64)}', ${NOW - 7000}, ${NOW - 1100});

        INSERT INTO depeg_resolver_event_repair_authorizations
          (id, event_id, incident_key, operation, columns_json, required_revision_id, required_erratum_id,
           reason, created_at, expires_at, created_by)
        VALUES
          (1, 41, 'ddr2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'incident_link', '["event_id","incident_key","relation"]', NULL, NULL,
           'prior link authorization', ${NOW - 1100}, 4102444800, 'fixture'),
          (2, 41, 'ddr2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'incident_current_update', '["current_event_id","current_started_at"]', NULL, NULL,
           'prior pointer authorization', ${NOW - 1100}, 4102444800, 'fixture');

        INSERT INTO depeg_resolver_event_repair_authorization_consumptions
          (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
        VALUES
          (1, 41, 'ddr2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'incident_link', ${NOW - 1100}, 'fixture'),
          (2, 41, 'ddr2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'incident_current_update', ${NOW - 1100}, 'fixture');

        INSERT INTO depeg_resolver_incident_revisions
          (incident_key, previous_event_id, current_event_id, reason, repair_authorization_id, erratum_id, created_at, created_by)
        VALUES
          ('ddr2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 40, 41, 'prior safe repair', 2, NULL, ${NOW - 1100}, 'fixture');

        INSERT INTO worker_repair_tasks
          (task_id, kind, subject_id, priority, state, attempt_count, payload_json, created_at, updated_at)
        VALUES
          ('repair:ddr-repair-required-event:42', 'ddr-repair-required-event', '42', 50, 'open', 0,
           '{"eventId":42,"reason":"explicit repair required"}', ${NOW - 600}, ${NOW - 600});
      `);

      const result = await runWorkerRepairTaskRunner(db, { nowSec: NOW });

      expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
        claimed: 1,
        autoRepairCount: 1,
        closed: 1,
        deferred: 0,
        failed: 0,
      });
      expect(db.sqlite.prepare(
        "SELECT current_event_id, current_started_at FROM depeg_resolver_incidents WHERE incident_key = ?",
      ).get("ddr2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toEqual({
        current_event_id: 42,
        current_started_at: NOW - 600,
      });
      expect(db.sqlite.prepare(
        "SELECT state, locked_by, locked_until, next_attempt_at FROM worker_repair_tasks WHERE task_id = ?",
      ).get("repair:ddr-repair-required-event:42")).toEqual({
        state: "closed",
        locked_by: null,
        locked_until: null,
        next_attempt_at: null,
      });
      expect(db.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM depeg_resolver_incident_event_links WHERE event_id = 42 AND repair_authorization_id IS NOT NULL",
      ).get()).toEqual({ count: 1 });
      expect(db.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM depeg_resolver_incident_revisions WHERE current_event_id = 42 AND repair_authorization_id IS NOT NULL",
      ).get()).toEqual({ count: 1 });
      expect(db.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM depeg_resolver_event_repair_authorization_consumptions WHERE event_id = 42",
      ).get()).toEqual({ count: 2 });
    } finally {
      db.close();
    }
  });

  it("preserves a pending lock audit and defers an otherwise safe repair", async () => {
    const db = makeSqliteD1();
    try {
      seedNaturalPredecessorFixture(db);
      db.sqlite.exec(`INSERT INTO depeg_resolver_lock_opportunity_audit
        (incident_key, event_id, run_at, eligible_at, health_status, action, created_at)
        VALUES ('ddr2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 41, ${NOW}, ${NOW}, 'healthy', 'pending', ${NOW})`);
      await runWorkerRepairTaskRunner(db, { nowSec: NOW });
      expect(db.sqlite.prepare(
        "SELECT state, last_error FROM worker_repair_tasks WHERE subject_id = '42'",
      ).get()).toEqual({ state: "deferred", last_error: "safe-class-not-proven" });
      expect(db.sqlite.prepare(
        "SELECT current_event_id FROM depeg_resolver_incidents",
      ).all()).toEqual([{ current_event_id: 41 }]);
      expect(db.sqlite.prepare(
        "SELECT event_id, action FROM depeg_resolver_lock_opportunity_audit",
      ).all()).toEqual([{ event_id: 41, action: "pending" }]);
    } finally {
      db.close();
    }
  });

  it("repairs a natural-predecessor chain end to end", async () => {
    const db = makeSqliteD1();
    try {
      seedNaturalPredecessorFixture(db);

      const result = await runWorkerRepairTaskRunner(db, { nowSec: NOW });

      expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
        claimed: 1,
        autoRepairCount: 1,
        closed: 1,
        deferred: 0,
        failed: 0,
      });
      expect(db.sqlite.prepare(
        "SELECT current_event_id, current_started_at FROM depeg_resolver_incidents WHERE incident_key = ?",
      ).get("ddr2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toEqual({
        current_event_id: 42,
        current_started_at: NOW - 600,
      });
      expect(db.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM depeg_resolver_event_repair_authorizations WHERE event_id = 42",
      ).get()).toEqual({ count: 2 });
      expect(db.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM depeg_resolver_event_repair_authorization_consumptions WHERE event_id = 42",
      ).get()).toEqual({ count: 2 });
    } finally {
      db.close();
    }
  });

  it("defers a rejected repair guard with the normal retryable deferral state", async () => {
    const db = makeSqliteD1();
    try {
      seedNaturalPredecessorFixture(db);
      db.sqlite.exec(`
        CREATE TRIGGER mutate_repair_guard_fixture
        AFTER UPDATE OF current_event_id ON depeg_resolver_incidents
        WHEN NEW.current_event_id = 42
        BEGIN
          UPDATE depeg_resolver_incidents
          SET current_started_at = NEW.current_started_at + 1
          WHERE incident_key = NEW.incident_key;
        END;
      `);

      const result = await runWorkerRepairTaskRunner(db, { nowSec: NOW });

      expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
        claimed: 1,
        autoRepairCount: 0,
        closed: 0,
        deferred: 1,
        failed: 0,
      });
      expect(db.sqlite.prepare(
        "SELECT state, locked_by, locked_until, next_attempt_at, last_error, closed_at FROM worker_repair_tasks WHERE task_id = ?",
      ).get("repair:ddr-repair-required-event:42")).toEqual({
        state: "deferred",
        locked_by: null,
        locked_until: null,
        next_attempt_at: NOW + DDR_REPAIR_RUNNER_BACKOFF_SEC_V1,
        last_error: "safe-class-not-proven",
        closed_at: null,
      });
    } finally {
      db.close();
    }
  });

  it("marks a task failed when a guarded repair statement reports zero changes", async () => {
    const db = makeSqliteD1();
    try {
      seedNaturalPredecessorFixture(db);
      db.sqlite.exec(`
        CREATE TRIGGER ignore_repair_pointer_update_fixture
        BEFORE UPDATE OF current_event_id ON depeg_resolver_incidents
        WHEN NEW.current_event_id = 42
        BEGIN
          SELECT RAISE(IGNORE);
        END;
      `);

      const result = await runWorkerRepairTaskRunner(db, { nowSec: NOW });

      expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
        claimed: 1,
        autoRepairCount: 0,
        closed: 0,
        deferred: 0,
        failed: 1,
      });
      expect(db.sqlite.prepare(
        "SELECT state, locked_by, locked_until, next_attempt_at, last_error, closed_at FROM worker_repair_tasks WHERE task_id = ?",
      ).get("repair:ddr-repair-required-event:42")).toEqual({
        state: "failed",
        locked_by: null,
        locked_until: null,
        next_attempt_at: NOW + DDR_REPAIR_RUNNER_BACKOFF_SEC_V1,
        last_error: "repair-execution-failed",
        closed_at: null,
      });
    } finally {
      db.close();
    }
  });

  it("rolls back authorization and consumption rows when the atomic repair batch fails", async () => {
    const db = makeSqliteD1();
    try {
      seedNaturalPredecessorFixture(db);
      db.sqlite.exec(`
        CREATE TRIGGER fail_repair_target_link
        BEFORE INSERT ON depeg_resolver_incident_event_links
        WHEN NEW.event_id = 42
        BEGIN
          SELECT RAISE(ABORT, 'injected repair batch failure');
        END;
      `);

      const result = await runWorkerRepairTaskRunner(db, { nowSec: NOW });

      expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
        claimed: 1,
        autoRepairCount: 0,
        closed: 0,
        deferred: 0,
        failed: 1,
      });
      expect(db.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM depeg_resolver_event_repair_authorizations WHERE event_id = 42",
      ).get()).toEqual({ count: 0 });
      expect(db.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM depeg_resolver_event_repair_authorization_consumptions WHERE event_id = 42",
      ).get()).toEqual({ count: 0 });
      expect(db.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM depeg_resolver_incident_event_links WHERE event_id = 42",
      ).get()).toEqual({ count: 0 });
      expect(db.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM depeg_resolver_incident_revisions WHERE current_event_id = 42",
      ).get()).toEqual({ count: 0 });
      expect(db.sqlite.prepare(
        "SELECT current_event_id FROM depeg_resolver_incidents WHERE incident_key = ?",
      ).get("ddr2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toEqual({ current_event_id: 41 });
      expect(db.sqlite.prepare(
        "SELECT state, next_attempt_at FROM worker_repair_tasks WHERE task_id = ?",
      ).get("repair:ddr-repair-required-event:42")).toEqual({
        state: "failed",
        next_attempt_at: NOW + DDR_REPAIR_RUNNER_BACKOFF_SEC_V1,
      });
    } finally {
      db.close();
    }
  });

  it("defers a natural predecessor with ambiguous revision lineage", async () => {
    const db = makeSqliteD1();
    try {
      seedNaturalPredecessorFixture(db, { includeRevision: false });

      const result = await runWorkerRepairTaskRunner(db, { nowSec: NOW });

      expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
        claimed: 1,
        autoRepairCount: 0,
        closed: 0,
        deferred: 1,
        failed: 0,
      });
      expect(db.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM depeg_resolver_event_repair_authorizations WHERE event_id = 42",
      ).get()).toEqual({ count: 0 });
      expect(db.sqlite.prepare(
        "SELECT current_event_id FROM depeg_resolver_incidents WHERE incident_key = ?",
      ).get("ddr2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toEqual({ current_event_id: 41 });
      expect(db.sqlite.prepare(
        "SELECT state, next_attempt_at FROM worker_repair_tasks WHERE task_id = ?",
      ).get("repair:ddr-repair-required-event:42")).toEqual({
        state: "deferred",
        next_attempt_at: NOW + DDR_REPAIR_RUNNER_BACKOFF_SEC_V1,
      });
    } finally {
      db.close();
    }
  });
});
