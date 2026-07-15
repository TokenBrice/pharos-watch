import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(process.cwd(), "worker/migrations");
const PREVIOUS_MIGRATION = "0206_cngn_ddr_events_90573_90584_link.sql";
const TARGET_MIGRATION = "0207_telegram_execution_unknown_backlog_archive.sql";

interface ReviewedGroup {
  sourceEventId: string;
  alertType: "dews" | "depeg" | "safety";
  rows: number;
  minId: number;
  maxId: number;
  idSum: number;
  ownerCount: number;
  created: readonly [min: number, max: number, sum: number];
  started: readonly [min: number, max: number, sum: number];
  completed: readonly [min: number, max: number, sum: number];
  priority: 10 | 20;
  disableSum: number;
  preferenceGenerationSum: number;
  messageLengthSum: number;
  dedupeLengthSum: number;
  scopeLengthSum: number;
  markupLengthSum: number;
  ownerLostCount: number;
  timeoutCount: number;
  job: {
    targetCount: number;
    acceptedCount: number;
    failedCount: number;
    executionUnknownCount: number;
  };
}

const REVIEWED_GROUPS: readonly ReviewedGroup[] = [
  {
    sourceEventId: "telegram-source:v1:6b720f298b9e431463312ba1b23c4f85",
    alertType: "dews",
    rows: 1,
    minId: 785,
    maxId: 785,
    idSum: 785,
    ownerCount: 1,
    created: [1783729661, 1783729661, 1783729661],
    started: [1783729692, 1783729692, 1783729692],
    completed: [1783731188, 1783731188, 1783731188],
    priority: 20,
    disableSum: 1,
    preferenceGenerationSum: 0,
    messageLengthSum: 275,
    dedupeLengthSum: 26,
    scopeLengthSum: 55,
    markupLengthSum: 565,
    ownerLostCount: 1,
    timeoutCount: 0,
    job: { targetCount: 47, acceptedCount: 46, failedCount: 0, executionUnknownCount: 1 },
  },
  {
    sourceEventId: "telegram-source:v1:7e835a90de4c68daec79e8fa9a9e6a63",
    alertType: "depeg",
    rows: 76,
    minId: 23263,
    maxId: 23359,
    idSum: 1771639,
    ownerCount: 1,
    created: [1784050037, 1784050037, 135587802812],
    started: [1784052251, 1784052251, 135587971076],
    completed: [1784053361, 1784055462, 135588143678],
    priority: 10,
    disableSum: 7,
    preferenceGenerationSum: 4,
    messageLengthSum: 34351,
    dedupeLengthSum: 1716,
    scopeLengthSum: 6851,
    markupLengthSum: 32009,
    ownerLostCount: 76,
    timeoutCount: 0,
    job: { targetCount: 296, acceptedCount: 220, failedCount: 0, executionUnknownCount: 76 },
  },
  {
    sourceEventId: "telegram-source:v1:819781859ec1723680693a7d562d2284",
    alertType: "depeg",
    rows: 276,
    minId: 22818,
    maxId: 23093,
    idSum: 6335718,
    ownerCount: 1,
    created: [1784039839, 1784039839, 492394995564],
    started: [1784040142, 1784040142, 492395079192],
    completed: [1784041946, 1784053361, 492397897716],
    priority: 10,
    disableSum: 276,
    preferenceGenerationSum: 8,
    messageLengthSum: 72864,
    dedupeLengthSum: 5914,
    scopeLengthSum: 12420,
    markupLengthSum: 169085,
    ownerLostCount: 276,
    timeoutCount: 0,
    job: { targetCount: 277, acceptedCount: 0, failedCount: 1, executionUnknownCount: 276 },
  },
  {
    sourceEventId: "telegram-source:v1:881425beae03dc9a4657fd29fd4ee4ff",
    alertType: "depeg",
    rows: 1,
    minId: 1861,
    maxId: 1861,
    idSum: 1861,
    ownerCount: 1,
    created: [1783756361, 1783756361, 1783756361],
    started: [1783756414, 1783756414, 1783756414],
    completed: [1783758462, 1783758462, 1783758462],
    priority: 10,
    disableSum: 1,
    preferenceGenerationSum: 0,
    messageLengthSum: 272,
    dedupeLengthSum: 26,
    scopeLengthSum: 51,
    markupLengthSum: 540,
    ownerLostCount: 1,
    timeoutCount: 0,
    job: { targetCount: 279, acceptedCount: 278, failedCount: 0, executionUnknownCount: 1 },
  },
  {
    sourceEventId: "telegram-source:v1:8bdd3703b49abccac055e6079c9331e6",
    alertType: "depeg",
    rows: 169,
    minId: 17040,
    maxId: 17376,
    idSum: 2922180,
    ownerCount: 1,
    created: [1783966335, 1783966335, 301490310615],
    started: [1783967910, 1783967910, 301490576790],
    completed: [1783970123, 1783970241, 301490960109],
    priority: 10,
    disableSum: 165,
    preferenceGenerationSum: 7,
    messageLengthSum: 45513,
    dedupeLengthSum: 3619,
    scopeLengthSum: 9133,
    markupLengthSum: 110486,
    ownerLostCount: 169,
    timeoutCount: 0,
    job: { targetCount: 337, acceptedCount: 168, failedCount: 0, executionUnknownCount: 169 },
  },
  {
    sourceEventId: "telegram-source:v1:c21a04fe56b20e4f20167492380d5aea",
    alertType: "depeg",
    rows: 1,
    minId: 1581,
    maxId: 1581,
    idSum: 1581,
    ownerCount: 1,
    created: [1783755461, 1783755461, 1783755461],
    started: [1783755510, 1783755510, 1783755510],
    completed: [1783756414, 1783756414, 1783756414],
    priority: 10,
    disableSum: 0,
    preferenceGenerationSum: 0,
    messageLengthSum: 274,
    dedupeLengthSum: 26,
    scopeLengthSum: 51,
    markupLengthSum: 540,
    ownerLostCount: 1,
    timeoutCount: 0,
    job: { targetCount: 279, acceptedCount: 278, failedCount: 0, executionUnknownCount: 1 },
  },
  {
    sourceEventId: "telegram-source:v1:c49f3510ea45e73416fc54788d5121af",
    alertType: "depeg",
    rows: 1,
    minId: 901,
    maxId: 901,
    idSum: 901,
    ownerCount: 1,
    created: [1783743761, 1783743761, 1783743761],
    started: [1783743805, 1783743805, 1783743805],
    completed: [1783747387, 1783747387, 1783747387],
    priority: 10,
    disableSum: 0,
    preferenceGenerationSum: 0,
    messageLengthSum: 276,
    dedupeLengthSum: 26,
    scopeLengthSum: 49,
    markupLengthSum: 530,
    ownerLostCount: 1,
    timeoutCount: 0,
    job: { targetCount: 310, acceptedCount: 309, failedCount: 0, executionUnknownCount: 1 },
  },
  {
    sourceEventId: "telegram-source:v1:c946a51c134a090da415f73434fa3a51",
    alertType: "depeg",
    rows: 230,
    minId: 22538,
    maxId: 22816,
    idSum: 5221296,
    ownerCount: 1,
    created: [1784039542, 1784039542, 410329094660],
    started: [1784040142, 1784040142, 410329232660],
    completed: [1784041534, 1784041946, 410329601410],
    priority: 10,
    disableSum: 2,
    preferenceGenerationSum: 9,
    messageLengthSum: 102244,
    dedupeLengthSum: 5140,
    scopeLengthSum: 22682,
    markupLengthSum: 88898,
    ownerLostCount: 230,
    timeoutCount: 0,
    job: { targetCount: 279, acceptedCount: 49, failedCount: 0, executionUnknownCount: 230 },
  },
  {
    sourceEventId: "telegram-source:v1:d16dc7b86f06aa113cc1eaa913561ec3",
    alertType: "depeg",
    rows: 1,
    minId: 1302,
    maxId: 1302,
    idSum: 1302,
    ownerCount: 1,
    created: [1783753661, 1783753661, 1783753661],
    started: [1783753706, 1783753706, 1783753706],
    completed: [1783755510, 1783755510, 1783755510],
    priority: 10,
    disableSum: 0,
    preferenceGenerationSum: 0,
    messageLengthSum: 273,
    dedupeLengthSum: 26,
    scopeLengthSum: 50,
    markupLengthSum: 535,
    ownerLostCount: 1,
    timeoutCount: 0,
    job: { targetCount: 279, acceptedCount: 278, failedCount: 0, executionUnknownCount: 1 },
  },
  {
    sourceEventId: "telegram-source:v1:dbd0f01512f40f7ce5655be124f417a3",
    alertType: "safety",
    rows: 2,
    minId: 7757,
    maxId: 7802,
    idSum: 15559,
    ownerCount: 2,
    created: [1783846362, 1783846362, 3567692724],
    started: [1783846588, 1783846665, 3567693253],
    completed: [1783846588, 1783846665, 3567693253],
    priority: 20,
    disableSum: 0,
    preferenceGenerationSum: 0,
    messageLengthSum: 1246,
    dedupeLengthSum: 46,
    scopeLengthSum: 208,
    markupLengthSum: 780,
    ownerLostCount: 0,
    timeoutCount: 2,
    job: { targetCount: 52, acceptedCount: 50, failedCount: 0, executionUnknownCount: 2 },
  },
];

interface SeededPendingRow {
  chatId: string;
  dedupeKey: string;
}

function applyMigration(db: DatabaseSync, file: string): void {
  // Test-only replay of repository-controlled migration files.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
}

function applyThrough(db: DatabaseSync, throughFile: string): void {
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((entry) => entry.endsWith(".sql"))
    .sort()) {
    applyMigration(db, file);
    if (file === throughFile) return;
  }
  throw new Error(`missing migration ${throughFile}`);
}

function uniqueIntegers(count: number, min: number, max: number, sum: number): number[] {
  if (count === 1) {
    expect(min).toBe(max);
    expect(sum).toBe(min);
    return [min];
  }
  const values = Array.from({ length: count }, (_, index) => min + index);
  let remaining = sum - values.reduce((total, value) => total + value, 0);
  for (let index = count - 1; index >= 1 && remaining > 0; index -= 1) {
    const upper = max - (count - 1 - index);
    const increment = Math.min(remaining, upper - values[index]);
    values[index] += increment;
    remaining -= increment;
  }
  expect(remaining).toBe(0);
  expect(values[0]).toBe(min);
  expect(values.at(-1)).toBe(max);
  expect(new Set(values).size).toBe(count);
  return values;
}

function boundedIntegers(count: number, min: number, max: number, sum: number): number[] {
  if (min === max) {
    expect(sum).toBe(min * count);
    return Array.from({ length: count }, () => min);
  }
  const values = Array.from({ length: count }, () => min);
  values[count - 1] = max;
  let remaining = sum - values.reduce((total, value) => total + value, 0);
  for (let index = count - 2; index >= 1 && remaining > 0; index -= 1) {
    const increment = Math.min(remaining, max - min);
    values[index] += increment;
    remaining -= increment;
  }
  expect(remaining).toBe(0);
  expect(Math.min(...values)).toBe(min);
  expect(Math.max(...values)).toBe(max);
  return values;
}

function fixedLengthStrings(count: number, totalLength: number, fill: string): string[] {
  const baseLength = Math.floor(totalLength / count);
  const remainder = totalLength % count;
  return Array.from(
    { length: count },
    (_, index) => fill.repeat(baseLength + (index < remainder ? 1 : 0)),
  );
}

function paddedUniqueStrings(ids: readonly number[], totalLength: number): string[] {
  const values = ids.map((id) => `d:${id}`);
  let remaining = totalLength - values.reduce((total, value) => total + value.length, 0);
  expect(remaining).toBeGreaterThanOrEqual(0);
  for (let index = 0; index < values.length && remaining > 0; index += 1) {
    const rowsLeft = values.length - index;
    const increment = Math.ceil(remaining / rowsLeft);
    values[index] += "x".repeat(increment);
    remaining -= increment;
  }
  expect(remaining).toBe(0);
  expect(new Set(values).size).toBe(values.length);
  expect(values.reduce((total, value) => total + value.length, 0)).toBe(totalLength);
  return values;
}

function jobId(group: ReviewedGroup): string {
  return `telegram:${group.sourceEventId}:${group.alertType}`;
}

function seedReviewedProductionShape(db: DatabaseSync, includeNewerUnknown = false): Map<string, SeededPendingRow[]> {
  const pendingInsert = db.prepare(`
    INSERT INTO telegram_pending_alerts (
      id, chat_id, message_html, disable_notification, created_at, attempts,
      not_before_at, last_error_class, retry_after_sec, updated_at, dedupe_key,
      chunk_index, priority, source_type, alert_type, expires_at,
      processing_owner, processing_started_at, processing_expires_at,
      delivery_state, delivery_started_at, delivery_completed_at,
      source_event_id, alert_scope_json, preference_generation,
      markup_policy_json, delivery_owner, delivery_generation,
      delivery_claim_expires_at
    ) VALUES (
      ?, ?, ?, ?, ?, 0, NULL, ?, NULL, ?, ?, 0, ?, 'risk_alert', ?, ?,
      NULL, NULL, NULL, 'execution_unknown', ?, ?, ?, ?, ?, ?, ?, 1, NULL
    )
  `);
  const jobInsert = db.prepare(`
    INSERT INTO telegram_alert_jobs (
      job_id, alert_type, source_event_id, severity, created_at, expires_at,
      status, target_count, sent_count, enqueued_count, failed_count, metadata
    ) VALUES (?, ?, ?, 'warning', 1783700000, 1785000000, 'queued', ?, 0, ?, 0, '{"legacy":"kept"}')
  `);
  const targetInsert = db.prepare(`
    INSERT INTO telegram_alert_job_targets (
      job_id, target_key, chat_id, chunk_index, alert_type, status,
      pending_dedupe_key, created_at, sent_at, enqueued_at, failed_at,
      error_class, source_event_id, final_delivery_state, final_delivery_at
    ) VALUES (?, ?, ?, 0, ?, ?, ?, 1783700000, ?, ?, ?, ?, ?, ?, 1784056000)
  `);

  const pendingBySource = new Map<string, SeededPendingRow[]>();
  let globalRow = 0;
  db.exec("BEGIN");
  try {
    REVIEWED_GROUPS.forEach((group, groupIndex) => {
      const ids = uniqueIntegers(group.rows, group.minId, group.maxId, group.idSum);
      const created = boundedIntegers(group.rows, ...group.created);
      const started = boundedIntegers(group.rows, ...group.started);
      const completed = boundedIntegers(group.rows, ...group.completed);
      const messages = fixedLengthStrings(group.rows, group.messageLengthSum, "m");
      const dedupeKeys = paddedUniqueStrings(ids, group.dedupeLengthSum);
      const scopes = fixedLengthStrings(group.rows, group.scopeLengthSum, "s");
      const markups = fixedLengthStrings(group.rows, group.markupLengthSum, "p");
      const rows: SeededPendingRow[] = [];

      ids.forEach((id, rowIndex) => {
        const chatId = `chat:${globalRow % 319}`;
        globalRow += 1;
        const errorClass = rowIndex < group.ownerLostCount ? "pending_effect_owner_lost" : "timeout";
        const preferenceGeneration = rowIndex === 0 ? group.preferenceGenerationSum : 0;
        const deliveryOwner = groupIndex === REVIEWED_GROUPS.length - 1 && rowIndex === 0
          ? `owner:${groupIndex - 1}:0`
          : `owner:${groupIndex}:${rowIndex % group.ownerCount}`;
        pendingInsert.run(
          id,
          chatId,
          messages[rowIndex],
          rowIndex < group.disableSum ? 1 : 0,
          created[rowIndex],
          errorClass,
          completed[rowIndex],
          dedupeKeys[rowIndex],
          group.priority,
          group.alertType,
          created[rowIndex] + 7200,
          started[rowIndex],
          completed[rowIndex],
          group.sourceEventId,
          scopes[rowIndex],
          preferenceGeneration,
          markups[rowIndex],
          deliveryOwner,
        );
        rows.push({ chatId, dedupeKey: dedupeKeys[rowIndex] });
      });
      pendingBySource.set(group.sourceEventId, rows);

      jobInsert.run(
        jobId(group),
        group.alertType,
        group.sourceEventId,
        group.job.targetCount,
        group.job.targetCount,
      );

      const buckets: Array<{ state: "accepted" | "failed" | "execution_unknown"; count: number }> = [
        { state: "accepted", count: group.job.acceptedCount },
        { state: "failed", count: group.job.failedCount },
        { state: "execution_unknown", count: group.job.executionUnknownCount },
      ];
      let unknownIndex = 0;
      buckets.forEach(({ state, count }) => {
        for (let index = 0; index < count; index += 1) {
          const pending = state === "execution_unknown" ? rows[unknownIndex++] : null;
          const status = state === "accepted" ? "sent" : state === "failed" ? "failed" : "queued";
          const key = pending?.dedupeKey ?? `${state}:${groupIndex}:${index}`;
          targetInsert.run(
            jobId(group),
            `${state}:${index}`,
            pending?.chatId ?? `target-chat:${groupIndex}:${index}`,
            group.alertType,
            status,
            key,
            state === "accepted" ? 1784056000 : null,
            state === "execution_unknown" ? 1784050000 : null,
            state === "failed" ? 1784056000 : null,
            state === "failed" ? "permanent_failure" : state === "execution_unknown" ? "execution_unknown" : null,
            group.sourceEventId,
            state,
          );
        }
      });
      expect(unknownIndex).toBe(rows.length);
    });

    if (includeNewerUnknown) {
      pendingInsert.run(
        24000,
        "chat:newer",
        "newer unknown remains live",
        0,
        1784060000,
        "timeout",
        1784060200,
        "newer-dedupe",
        10,
        "depeg",
        1784067200,
        1784060100,
        1784060200,
        "telegram-source:v1:newer-unrelated",
        "{}",
        0,
        "{}",
        "owner:newer",
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return pendingBySource;
}

describe("0207 Telegram execution-unknown backlog archive migration", () => {
  it("archives the exact cohort, preserves newer unknown rows, reconciles jobs, and replays idempotently", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyThrough(db, PREVIOUS_MIGRATION);
      seedReviewedProductionShape(db, true);

      applyMigration(db, TARGET_MIGRATION);

      expect(
        db.prepare("SELECT id, delivery_state FROM telegram_pending_alerts ORDER BY id").all(),
      ).toEqual([{ id: 24000, delivery_state: "execution_unknown" }]);
      expect(
        db.prepare(`
          SELECT COUNT(*) AS rows,
                 COUNT(DISTINCT pending_id) AS pending_ids,
                 COUNT(DISTINCT dead_letter_key) AS dead_letter_keys,
                 SUM(reason = 'execution_unknown_archived') AS archived_reasons,
                 SUM(delivery_state = 'execution_unknown') AS unknown_states,
                 SUM(dead_letter_key = 'pending:' || pending_id || ':delivery:' || delivery_generation) AS exact_keys
          FROM telegram_alert_dead_letters
          WHERE reason = 'execution_unknown_archived'
        `).get(),
      ).toEqual({
        rows: 758,
        pending_ids: 758,
        dead_letter_keys: 758,
        archived_reasons: 758,
        unknown_states: 758,
        exact_keys: 758,
      });

      const jobs = db.prepare(`
        SELECT job_id, status, target_count, planned_count, accepted_count,
               sent_count, enqueued_count, failed_count, cancelled_count,
               expired_count, execution_unknown_count,
               json_extract(metadata, '$.countersSource') AS counters_source
        FROM telegram_alert_jobs
        ORDER BY job_id
      `).all();
      expect(jobs).toEqual(
        REVIEWED_GROUPS.map((group) => ({
          job_id: jobId(group),
          status: "degraded",
          target_count: group.job.targetCount,
          planned_count: 0,
          accepted_count: group.job.acceptedCount,
          sent_count: group.job.acceptedCount,
          enqueued_count: 0,
          failed_count: group.job.failedCount,
          cancelled_count: 0,
          expired_count: 0,
          execution_unknown_count: group.job.executionUnknownCount,
          counters_source: "authoritative-target-rows",
        })).sort((left, right) => left.job_id.localeCompare(right.job_id)),
      );

      applyMigration(db, TARGET_MIGRATION);

      expect(
        db.prepare(`
          SELECT COUNT(*) AS rows, COUNT(DISTINCT dead_letter_key) AS keys
          FROM telegram_alert_dead_letters
          WHERE reason = 'execution_unknown_archived'
        `).get(),
      ).toEqual({ rows: 758, keys: 758 });
      expect(db.prepare("SELECT COUNT(*) AS rows FROM telegram_pending_alerts").get()).toEqual({ rows: 1 });
    } finally {
      db.close();
    }
  });

  it("fails closed before writing when a reviewed payload fingerprint drifts", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyThrough(db, PREVIOUS_MIGRATION);
      seedReviewedProductionShape(db);
      db.prepare("UPDATE telegram_pending_alerts SET message_html = message_html || 'x' WHERE id = 785").run();

      expect(() => applyMigration(db, TARGET_MIGRATION)).toThrow(/malformed JSON/);
      expect(db.prepare("SELECT COUNT(*) AS rows FROM telegram_pending_alerts").get()).toEqual({ rows: 758 });
      expect(
        db.prepare("SELECT COUNT(*) AS rows FROM telegram_alert_dead_letters WHERE reason = 'execution_unknown_archived'").get(),
      ).toEqual({ rows: 0 });
      expect(
        db.prepare("SELECT COUNT(*) AS rows FROM telegram_alert_jobs WHERE status = 'queued'").get(),
      ).toEqual({ rows: 10 });
    } finally {
      db.close();
    }
  });

  it("remains an empty-data no-op during a latest-schema replay", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyThrough(db, TARGET_MIGRATION);
      expect(db.prepare("SELECT COUNT(*) AS rows FROM telegram_pending_alerts").get()).toEqual({ rows: 0 });
      expect(db.prepare("SELECT COUNT(*) AS rows FROM telegram_alert_dead_letters").get()).toEqual({ rows: 0 });
      expect(db.prepare("SELECT COUNT(*) AS rows FROM telegram_alert_jobs").get()).toEqual({ rows: 0 });
    } finally {
      db.close();
    }
  });
});
