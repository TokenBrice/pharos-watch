import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

import {
  ADMIN_PENDING_TTL_SECONDS,
  buildSyntheticTelegramFixture,
  CPU_BUDGET_CEILING_MS,
  CPU_BUDGET_SAFETY_FRACTION,
  CRON_INTERVAL_SECONDS,
  D1_WRITE_MS_PER_MESSAGE,
  DISPATCH_CPU_MS,
  DISPATCH_TIMEOUT_SECONDS,
  EFFECTIVE_SEND_MESSAGES_PER_SECOND,
  FORMAT_CPU_MS_PER_CHAT,
  FRESH_ATTEMPTS_PER_RUN,
  LEGACY_PENDING_PRIORITY,
  MINIMUM_TTL_MARGIN_FRACTION,
  NORMAL_SLO_SECONDS,
  PENDING_DRAIN_ATTEMPTS_PER_RUN,
  PENDING_TTL_SECONDS,
  REQUIRED_TARGET,
  RISK_ALERT_PRIORITY,
  SEND_CPU_MS_PER_MESSAGE,
  SEND_LOOP_SOFT_DEADLINE_SECONDS,
  simulateLoadScenarios,
  simulateProductionCalibratedDispatch,
  SPIKE_MAX_SECONDS,
  summarizeFixture,
  TELEGRAM_BROADCAST_MESSAGES_PER_SECOND,
  TELEGRAM_P95_SEND_LATENCY_MS,
  WATCHER_TARGETS,
  type LoadScenarioResult,
  type ProductionCalibratedDispatchScenario,
  type SyntheticFixtureSummary,
  type SyntheticTelegramFixture,
} from "../lib/telegram-load-scenarios";
import { parseTelegramLoadTargets, printTelegramLoadReport } from "../lib/telegram-load-report";
import {
  simulateTelegramRecapLoadScenarios,
  type TelegramRecapLoadScenarioResult,
} from "../lib/telegram-recap-load-scenarios";
import { TELEGRAM_RECAP_TAPE_PAGE_LIMIT } from "@shared/lib/telegram-recap-policy";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

export {
  buildSyntheticTelegramFixture,
  simulateLoadScenarios,
  simulateProductionCalibratedDispatch,
  summarizeFixture,
} from "../lib/telegram-load-scenarios";
export { simulateTelegramRecapLoadScenarios } from "../lib/telegram-recap-load-scenarios";
export type {
  LoadScenarioResult,
  ProductionCalibratedDispatchScenario,
  SyntheticFixtureSummary,
  SyntheticTelegramFixture,
} from "../lib/telegram-load-scenarios";

type QueryPlanStatus = "ok" | "review" | "fail";

/**
 * Reviewed in-memory duration ceiling shared by the status read paths (TGB-043).
 * Measured 2026-07-10 at the 5,000-watcher planning fixture: every budgeted
 * query completes in under 10ms; the generous ceiling absorbs CI variance while
 * still catching an accidental O(n^2) regression at planning scale.
 */
export const STATUS_PATH_MAX_DURATION_MS = 250;
const STATUS_PATH_MEASUREMENT_RUNS = 3;

interface QueryPlanRow {
  id: number;
  parent: number;
  notused: number;
  detail: string;
}

export interface StatusPathBudget {
  /**
   * Tables the reviewed plan fully scans. Their seeded row counts at the
   * required planning target define the deterministic rows-read cost.
   */
  rowsReadTables: string[];
  /** Reviewed maximum rows-read at the required planning target. */
  maxRowsRead: number;
  /** Reviewed maximum in-memory execution duration at the planning target. */
  maxDurationMs: number;
}

export interface QueryPlanCheckDefinition {
  id: string;
  category: "fan-out" | "pulse-status" | "pending-drain" | "lifecycle" | "recap-planner";
  sql: string;
  binds: Array<string | number | null>;
  requiredDetails?: string[];
  allowedFullScanTables?: string[];
  /** TGB-043: reviewed rows-read/duration maxima for status read paths. */
  budget?: StatusPathBudget;
  note?: string;
}

export interface QueryPlanCheckResult {
  id: string;
  category: QueryPlanCheckDefinition["category"];
  status: QueryPlanStatus;
  details: string[];
  missingRequiredDetails: string[];
  unexpectedFullScanTables: string[];
  note?: string;
}

export interface StatusPathBudgetResult {
  id: string;
  category: QueryPlanCheckDefinition["category"];
  status: "ok" | "fail";
  targetActiveWatchers: number;
  rowsRead: number;
  maxRowsRead: number;
  durationMs: number;
  maxDurationMs: number;
  seededRowCounts: Record<string, number>;
  note?: string;
}

export interface TelegramLoadCheckReport {
  assumptions: {
    freshAttemptsPerRun: number;
    pendingDrainAttemptsPerRun: number;
    cronIntervalSeconds: number;
    dispatchTimeoutSeconds: number;
    sendLoopSoftDeadlineSeconds: number;
    telegramBroadcastMessagesPerSecond: number;
    telegramP95SendLatencyMs: number;
    effectiveSendMessagesPerSecond: number;
    d1WriteMsPerMessage: number;
    pendingTtlSeconds: number;
    adminPendingTtlSeconds: number;
    worstCasePlanningDelaySeconds: number;
    minimumTtlMarginFraction: number;
    normalSloSeconds: number;
    spikeMaxSeconds: number;
    dispatchCpuMs: number;
    cpuBudgetSafetyFraction: number;
    cpuBudgetCeilingMs: number;
    formatCpuMsPerChat: number;
    sendCpuMsPerMessage: number;
  };
  fixtureSummaries: SyntheticFixtureSummary[];
  scenarios: LoadScenarioResult[];
  recapScenarios: TelegramRecapLoadScenarioResult[];
  productionDispatchScenario: ProductionCalibratedDispatchScenario;
  queryPlans: QueryPlanCheckResult[];
  statusPathBudgets: StatusPathBudgetResult[];
}

export function findProductionDispatchBreaches(
  report: TelegramLoadCheckReport,
): string[] {
  const scenario = report.productionDispatchScenario;
  const breaches: string[] = [];
  if (scenario.candidateSubscriberCount >= scenario.subscriberCount) {
    breaches.push("candidate-horizon-not-reduced");
  }
  if (scenario.fanoutInputLoadCallCount > scenario.capturePageCount) {
    breaches.push("fanout-input-pages-reloaded");
  }
  if (scenario.duplicatedFanoutInputLoadCallCount > 0) {
    breaches.push("duplicated-fanout-input-loads");
  }
  if (
    scenario.handoffOperationCount >
      scenario.handoffPageCount * scenario.maxHandoffOperationsPerPage
  ) {
    breaches.push("target-oriented-handoff-operations");
  }
  if (scenario.estimatedInvocationWallMs > scenario.maxInvocationWallMs) {
    breaches.push("invocation-wall-budget");
  }
  return breaches;
}
/**
 * Required-target scenarios whose modeled per-invocation CPU exceeds the safety
 * fraction of the cap. Exported so the C102 CPU gate is unit-testable without
 * driving `main()`/`process.exit`.
 */
export function findCpuBudgetBreaches(report: TelegramLoadCheckReport): LoadScenarioResult[] {
  return report.scenarios.filter(
    (scenario) =>
      scenario.targetActiveWatchers === REQUIRED_TARGET &&
      scenario.estimatedCpuMs > report.assumptions.cpuBudgetCeilingMs,
  );
}

export function findTtlMarginBreaches(report: TelegramLoadCheckReport): LoadScenarioResult[] {
  return report.scenarios.filter(
    (scenario) =>
      scenario.targetActiveWatchers === REQUIRED_TARGET &&
      !scenario.exploratory &&
      scenario.ttlMarginFraction < report.assumptions.minimumTtlMarginFraction,
  );
}

export function findRecapLoadBreaches(report: TelegramLoadCheckReport): TelegramRecapLoadScenarioResult[] {
  return report.recapScenarios.filter((scenario) =>
    scenario.targetRecipients === REQUIRED_TARGET
    && (
      scenario.ttlMarginFraction < report.assumptions.minimumTtlMarginFraction
      || scenario.peakPlannerCpuMs > report.assumptions.cpuBudgetCeilingMs
      || scenario.peakDispatchCpuMs > report.assumptions.cpuBudgetCeilingMs
      || !scenario.priorityPreserved
      || scenario.aiCalls !== 0
      || scenario.externalPlanningFetches !== 0
    ),
  );
}
function runExplainQueryPlan(db: DatabaseSync, check: QueryPlanCheckDefinition): QueryPlanCheckResult {
  // Cast: better-sqlite3 .all() returns unknown[]; EXPLAIN QUERY PLAN's row shape is stable per SQLite docs
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${check.sql}`).all(...check.binds) as unknown as QueryPlanRow[];
  const details = rows.map((row) => row.detail);
  return evaluateQueryPlan(check, details);
}

function getFullScanTable(detail: string): string | null {
  if (!detail.startsWith("SCAN ")) return null;
  if (detail.includes(" USING INDEX ") || detail.includes(" USING COVERING INDEX ")) return null;
  const rest = detail.slice("SCAN ".length).trim();
  const [table] = rest.split(" ");
  return table || null;
}

export function evaluateQueryPlan(check: QueryPlanCheckDefinition, details: string[]): QueryPlanCheckResult {
  const requiredDetails = check.requiredDetails ?? [];
  const missingRequiredDetails = requiredDetails.filter(
    (required) => !details.some((detail) => detail.includes(required)),
  );
  const allowedFullScanTables = new Set(check.allowedFullScanTables ?? []);
  const unexpectedFullScanTables = new Set<string>();

  for (const detail of details) {
    const table = getFullScanTable(detail);
    if (!table) continue;
    if (!allowedFullScanTables.has(table)) {
      unexpectedFullScanTables.add(table);
    }
  }

  const status: QueryPlanStatus =
    missingRequiredDetails.length > 0 || unexpectedFullScanTables.size > 0
      ? "fail"
      : check.allowedFullScanTables && check.allowedFullScanTables.length > 0
        ? "review"
        : "ok";

  return {
    id: check.id,
    category: check.category,
    status,
    details,
    missingRequiredDetails,
    unexpectedFullScanTables: [...unexpectedFullScanTables],
    note: check.note,
  };
}

const TELEGRAM_PENDING_DRAIN_SOURCE_PATH = resolve(
  process.cwd(),
  "worker/src/cron/telegram-pending/drain.ts",
);

export function extractProductionPendingClaimSql(sourceText: string): string {
  const sourceFile = ts.createSourceFile(
    TELEGRAM_PENDING_DRAIN_SOURCE_PATH,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const matches: string[] = [];

  function visit(node: ts.Node, insideTargetFunction = false): void {
    const isTargetFunction = ts.isFunctionDeclaration(node)
      && node.name?.text === "selectPendingClaimCandidateIds";
    const inTarget = insideTargetFunction || isTargetFunction;

    if (
      inTarget
      && ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "prepare"
      && node.arguments.length === 1
    ) {
      const [argument] = node.arguments;
      if (ts.isNoSubstitutionTemplateLiteral(argument) || ts.isStringLiteral(argument)) {
        matches.push(argument.text);
      }
    }

    ts.forEachChild(node, (child) => visit(child, inTarget));
  }

  visit(sourceFile);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one static SQL prepare() call in selectPendingClaimCandidateIds(), found ${matches.length}.`,
    );
  }
  return matches[0]!;
}

export function loadProductionPendingClaimSql(): string {
  return extractProductionPendingClaimSql(
    readFileSync(TELEGRAM_PENDING_DRAIN_SOURCE_PATH, "utf8"),
  );
}

export function buildQueryPlanChecks(): QueryPlanCheckDefinition[] {
  const activeSubscriptionCountsSql = `SELECT chat_id,
        SUM(
          CASE
            WHEN alert_dews = 1
              OR alert_depeg = 1
              OR alert_safety = 1
              OR alert_launch = 1
              OR alert_reserve = 1
              OR alert_freeze = 1
            THEN 1 ELSE 0
          END
        ) AS active_sub_count
   FROM telegram_subscriptions
  GROUP BY chat_id`;
  const activePresetCountsSql = `SELECT chat_id,
        SUM(
          CASE
            WHEN alert_dews = 1
              OR alert_depeg = 1
              OR alert_safety = 1
            THEN 1 ELSE 0
          END
        ) AS active_preset_count
   FROM telegram_preset_subscriptions
  GROUP BY chat_id`;
  const activeWatcherCondition = `s.global_alert_dews = 1
  OR s.global_alert_depeg = 1
  OR s.global_alert_safety = 1
  OR s.global_alert_launch = 1
  OR s.global_alert_reserve = 1
  OR s.global_alert_freeze = 1
  OR COALESCE(sub.active_sub_count, 0) > 0
  OR COALESCE(preset.active_preset_count, 0) > 0`;

  return [
    {
      id: "fanout-direct-depeg",
      category: "fan-out",
      sql: `SELECT sub.stablecoin_id, sub.chat_id, u.last_active_at
         FROM telegram_subscriptions sub
         JOIN telegram_subscribers u ON u.chat_id = sub.chat_id
        WHERE sub.stablecoin_id IN (?, ?, ?)
          AND sub.alert_depeg = 1
          AND (u.alert_snooze_until_ts IS NULL OR u.alert_snooze_until_ts <= ?)
          AND (sub.alert_snooze_until_ts IS NULL OR sub.alert_snooze_until_ts <= ?)`,
      binds: ["usdc-circle", "usdt-tether", "dai-makerdao", 1_800_000_000, 1_800_000_000],
      requiredDetails: ["idx_tg_sub_depeg_coin_chat", "sqlite_autoindex_telegram_subscribers_1"],
    },
    {
      id: "fanout-direct-dews",
      category: "fan-out",
      sql: `SELECT sub.stablecoin_id, sub.chat_id, u.last_active_at
         FROM telegram_subscriptions sub
         JOIN telegram_subscribers u ON u.chat_id = sub.chat_id
        WHERE sub.stablecoin_id IN (?, ?, ?)
          AND sub.alert_dews = 1
          AND (u.alert_snooze_until_ts IS NULL OR u.alert_snooze_until_ts <= ?)
          AND (sub.alert_snooze_until_ts IS NULL OR sub.alert_snooze_until_ts <= ?)`,
      binds: ["usdc-circle", "usdt-tether", "dai-makerdao", 1_800_000_000, 1_800_000_000],
      requiredDetails: ["idx_tg_sub_dews_coin_chat", "sqlite_autoindex_telegram_subscribers_1"],
    },
    {
      id: "fanout-direct-safety",
      category: "fan-out",
      sql: `SELECT sub.stablecoin_id, sub.chat_id, u.last_active_at
         FROM telegram_subscriptions sub
         JOIN telegram_subscribers u ON u.chat_id = sub.chat_id
        WHERE sub.stablecoin_id IN (?, ?, ?)
          AND sub.alert_safety = 1
          AND (u.alert_snooze_until_ts IS NULL OR u.alert_snooze_until_ts <= ?)
          AND (sub.alert_snooze_until_ts IS NULL OR sub.alert_snooze_until_ts <= ?)`,
      binds: ["usdc-circle", "usdt-tether", "dai-makerdao", 1_800_000_000, 1_800_000_000],
      requiredDetails: ["idx_tg_sub_safety_coin_chat", "sqlite_autoindex_telegram_subscribers_1"],
    },
    {
      id: "fanout-global-depeg",
      category: "fan-out",
      sql: `SELECT chat_id, last_active_at
         FROM telegram_subscribers
        WHERE global_alert_depeg = 1
          AND (alert_snooze_until_ts IS NULL OR alert_snooze_until_ts <= ?)`,
      binds: [1_800_000_000],
      requiredDetails: ["idx_telegram_subscribers_global_alert_depeg"],
    },
    {
      id: "fanout-preset-depeg",
      category: "fan-out",
      sql: `SELECT p.chat_id, p.preset_id, u.last_active_at
         FROM telegram_preset_subscriptions p
         JOIN telegram_subscribers u ON u.chat_id = p.chat_id
        WHERE p.alert_depeg = 1
          AND p.preset_id IN (?, ?)
          AND (u.alert_snooze_until_ts IS NULL OR u.alert_snooze_until_ts <= ?)`,
      binds: ["usd-top25", "mcap-ge-1b", 1_800_000_000],
      requiredDetails: ["idx_telegram_preset_subscriptions_preset", "sqlite_autoindex_telegram_subscribers_1"],
      note: "Preset fan-out resolves preset definitions before querying and restricts subscriber rows to matching preset ids.",
    },
    {
      id: "fanout-per-coin-snooze",
      category: "fan-out",
      sql: `SELECT stablecoin_id, chat_id
         FROM telegram_subscriptions
        WHERE stablecoin_id IN (?, ?, ?)
          AND alert_snooze_until_ts IS NOT NULL
          AND alert_snooze_until_ts > ?`,
      binds: ["usdc-circle", "usdt-tether", "dai-makerdao", 1_800_000_000],
      requiredDetails: ["idx_tg_sub_coin"],
    },
    {
      id: "fanout-direct-reserve",
      category: "fan-out",
      sql: `SELECT sub.stablecoin_id, sub.chat_id, u.last_active_at
         FROM telegram_subscriptions sub
         JOIN telegram_subscribers u ON u.chat_id = sub.chat_id
        WHERE sub.stablecoin_id IN (?, ?, ?)
          AND sub.alert_reserve = 1
          AND (u.alert_snooze_until_ts IS NULL OR u.alert_snooze_until_ts <= ?)
          AND (sub.alert_snooze_until_ts IS NULL OR sub.alert_snooze_until_ts <= ?)`,
      binds: ["usdc-circle", "usdt-tether", "dai-makerdao", 1_800_000_000, 1_800_000_000],
      requiredDetails: ["idx_tg_sub_coin", "sqlite_autoindex_telegram_subscribers_1"],
    },
    {
      id: "fanout-global-reserve",
      category: "fan-out",
      sql: `SELECT chat_id, last_active_at
         FROM telegram_subscribers
        WHERE global_alert_reserve = 1
          AND (alert_snooze_until_ts IS NULL OR alert_snooze_until_ts <= ?)`,
      binds: [1_800_000_000],
      requiredDetails: ["idx_telegram_subscribers_global_alert_reserve"],
    },
    {
      id: "pending-claim-ready",
      category: "pending-drain",
      sql: loadProductionPendingClaimSql(),
      binds: [
        PENDING_TTL_SECONDS,
        1_800_000_000,
        1_800_000_000,
        RISK_ALERT_PRIORITY,
        LEGACY_PENDING_PRIORITY,
        RISK_ALERT_PRIORITY,
        1_800_000_000,
        LEGACY_PENDING_PRIORITY,
        PENDING_DRAIN_ATTEMPTS_PER_RUN,
      ],
      requiredDetails: ["idx_tpa_delivery_reconcile", "idx_tajt_pending_status"],
      note: "Executes the SQL from selectPendingClaimCandidateIds() in telegram-pending/drain.ts. SQLite uses the delivery-state reconciliation index for pending candidates and the target status index for the terminal-target dedupe exclusion; this guards the production claim drain against a regression to a full table scan.",
    },
    {
      id: "pending-backoff-aggregate",
      category: "pending-drain",
      sql: `SELECT chat_id, MAX(not_before_at) AS not_before_at
         FROM telegram_pending_alerts
        WHERE created_at >= ?
          AND not_before_at IS NOT NULL
          AND not_before_at > ?
        GROUP BY chat_id`,
      binds: [1_799_996_400, 1_800_000_000],
      requiredDetails: ["idx_telegram_pending_alerts_chat_id"],
    },
    {
      id: "recap-due-preferences",
      category: "recap-planner",
      sql: `SELECT p.chat_id, p.delivery_hour_local, p.next_due_at, s.preference_generation
        FROM telegram_recap_preferences p
        JOIN telegram_subscribers s ON s.chat_id = p.chat_id
       WHERE p.enabled = 1 AND p.chat_kind = 'private'
         AND p.next_due_at IS NOT NULL AND p.next_due_at <= ?
       ORDER BY p.next_due_at ASC, p.chat_id ASC
       LIMIT ?`,
      binds: [1_800_000_000, 90],
      requiredDetails: ["idx_telegram_recap_preferences_due", "sqlite_autoindex_telegram_subscribers_1"],
      note: "Mirrors the bounded due-page read used by the personalized recap planner.",
    },
    {
      id: "recap-tape-window",
      category: "recap-planner",
      sql: `SELECT id, event_id, type, severity, ts, coin_id, chain, payload_json
        FROM tape_events
       WHERE ts > ? AND ts <= ?
         AND type IN (?, ?, ?, ?, ?, ?)
       ORDER BY ts ASC, id ASC
       LIMIT ?`,
      binds: [1_799_870_400_000, 1_800_000_000_000, "depeg.opened", "dews.escalated", "score.downgraded", "freeze.blocked", "mint_burn.large_mint", "yield.warning_emitted", TELEGRAM_RECAP_TAPE_PAGE_LIMIT + 1],
      requiredDetails: ["idx_tape_type_ts"],
      note: "Reviews the Tape type/time index and cap-plus-one bounded scan used by recap planning.",
    },
    {
      id: "recap-direct-membership",
      category: "recap-planner",
      sql: `SELECT chat_id, stablecoin_id, alert_snooze_until_ts
        FROM telegram_subscriptions
       WHERE chat_id IN (?, ?, ?)
         AND (alert_dews = 1 OR alert_depeg = 1 OR alert_safety = 1
           OR alert_launch = 1 OR alert_reserve = 1 OR alert_freeze = 1)`,
      binds: ["recap-1", "recap-2", "recap-3"],
      requiredDetails: ["sqlite_autoindex_telegram_subscriptions_1"],
      note: "Mirrors the planner's bounded direct-watchlist membership read by due chat ids.",
    },
    {
      id: "recap-preset-membership",
      category: "recap-planner",
      sql: `SELECT chat_id, preset_id
        FROM telegram_preset_subscriptions
       WHERE chat_id IN (?, ?, ?)
         AND (alert_dews = 1 OR alert_depeg = 1 OR alert_safety = 1)`,
      binds: ["recap-1", "recap-2", "recap-3"],
      requiredDetails: ["sqlite_autoindex_telegram_preset_subscriptions_1"],
      note: "Mirrors the planner's bounded preset membership read by due chat ids.",
    },
    {
      id: "recap-target-guarded-transition",
      category: "recap-planner",
      sql: `UPDATE telegram_recap_preferences
         SET next_due_at = ?, updated_at = ?
       WHERE chat_id = ? AND enabled = 1 AND next_due_at = ?
         AND EXISTS (
           SELECT 1
             FROM telegram_recap_targets target
             JOIN telegram_subscribers subscriber ON subscriber.chat_id = target.chat_id
            WHERE target.recap_key = ? AND target.status = 'queued'
              AND target.preference_generation = ?
              AND subscriber.preference_generation = ?
         )`,
      binds: [1_800_086_400, 1_800_000_000, "recap-1", 1_800_000_000, "recap:recap-1:2026-07-11:v1", 1, 1],
      requiredDetails: [
        "sqlite_autoindex_telegram_recap_preferences_1",
        "sqlite_autoindex_telegram_recap_targets_1",
        "sqlite_autoindex_telegram_subscribers_1",
      ],
      note: "Mirrors the target-state and preference-generation-fenced schedule transition.",
    },
    {
      id: "recap-pending-handoff",
      category: "recap-planner",
      sql: "SELECT id FROM telegram_pending_alerts WHERE dedupe_key = ?",
      binds: ["recap:recap-1:2026-07-11:v1"],
      requiredDetails: ["idx_tpa_dedupe_key"],
      note: "Mirrors the exact pending-row lookup used to attach a recap target after its idempotent handoff.",
    },
    {
      id: "pulse-aggregate",
      category: "pulse-status",
      sql: `SELECT
             SUM(CASE WHEN s.global_alert_dews = 1
                   OR s.global_alert_depeg = 1
                   OR s.global_alert_safety = 1
                   OR s.global_alert_launch = 1
                   OR s.global_alert_reserve = 1
                   OR s.global_alert_freeze = 1
                   OR COALESCE(sub.active_sub_count, 0) > 0
                   OR COALESCE(preset.active_preset_count, 0) > 0
                 THEN 1 ELSE 0 END) AS active_watchers
           FROM telegram_subscribers s
           LEFT JOIN (
             SELECT chat_id,
                    SUM(CASE WHEN alert_dews = 1 OR alert_depeg = 1 OR alert_safety = 1 OR alert_launch = 1 OR alert_reserve = 1 OR alert_freeze = 1 THEN 1 ELSE 0 END) AS active_sub_count
               FROM telegram_subscriptions
              GROUP BY chat_id
           ) sub ON sub.chat_id = s.chat_id
           LEFT JOIN (
             ${activePresetCountsSql}
           ) preset ON preset.chat_id = s.chat_id`,
      binds: [],
      allowedFullScanTables: ["s"],
      budget: {
        rowsReadTables: ["telegram_subscribers", "telegram_subscriptions", "telegram_preset_subscriptions"],
        maxRowsRead: 35_000,
        maxDurationMs: STATUS_PATH_MAX_DURATION_MS,
      },
      note: "Pulse common path serves telegram:pulse:snapshot from cache; this reviews the refresh/fallback aggregate query. Measured 2026-07-11 at the 5,000-watcher fixture: 33,751 rows read, ~13ms in-memory; no rollup justified yet.",
    },
    {
      id: "status-top-stablecoins",
      category: "pulse-status",
      sql: `SELECT stablecoin_id AS source_id, COUNT(DISTINCT chat_id) AS subscribers
        FROM telegram_subscriptions
       WHERE alert_dews = 1
          OR alert_depeg = 1
          OR alert_safety = 1
          OR alert_launch = 1
          OR alert_reserve = 1
          OR alert_freeze = 1
       GROUP BY stablecoin_id
       UNION ALL
      SELECT preset_id AS source_id, COUNT(DISTINCT chat_id) AS subscribers
        FROM telegram_preset_subscriptions
       WHERE alert_dews = 1
          OR alert_depeg = 1
          OR alert_safety = 1
       GROUP BY preset_id`,
      binds: [],
      allowedFullScanTables: ["telegram_subscriptions", "telegram_preset_subscriptions"],
      budget: {
        rowsReadTables: ["telegram_subscriptions", "telegram_preset_subscriptions"],
        maxRowsRead: 30_000,
        maxDurationMs: STATUS_PATH_MAX_DURATION_MS,
      },
      note: "Top-coin status runs separate explicit-coin and preset-follower aggregates before resolving preset targets in memory; reviewed until a dedicated status snapshot exists. Measured 2026-07-11 at the 5,000-watcher fixture: 28,751 rows read, ~8ms in-memory; no rollup justified yet.",
    },
    {
      id: "lifecycle-current-active-history",
      category: "lifecycle",
      sql: `SELECT
             date(s.created_at, 'unixepoch') AS day,
             strftime('%s', date(s.created_at, 'unixepoch')) AS day_ts,
             COUNT(*) AS new_watchers
           FROM telegram_subscribers s
           LEFT JOIN (
             ${activeSubscriptionCountsSql}
           ) sub ON sub.chat_id = s.chat_id
           LEFT JOIN (
             ${activePresetCountsSql}
           ) preset ON preset.chat_id = s.chat_id
           WHERE ${activeWatcherCondition}
           GROUP BY day
           ORDER BY day ASC`,
      binds: [],
      allowedFullScanTables: ["s"],
      budget: {
        rowsReadTables: ["telegram_subscribers", "telegram_subscriptions", "telegram_preset_subscriptions"],
        maxRowsRead: 35_000,
        maxDurationMs: STATUS_PATH_MAX_DURATION_MS,
      },
      note: "Legacy fallback history still scans subscribers only when lifecycle snapshots are missing; production history uses telegram_watcher_lifecycle_daily once populated. Measured 2026-07-11 at the 5,000-watcher fixture: 33,751 rows read, ~15ms in-memory; no rollup justified yet.",
    },
  ];
}

// Telegram migrations depend on shared Worker schema (for example effect
// fencing depends on scheduler tables), so this fixture replays the same full
// ordered stream as production instead of guessing dependencies by filename.
// Since the 2026-07-30 squash the full schema lives in 0000_baseline.sql, so
// the guard requires the baseline plus however many unsquashed migrations exist.
const MIN_TELEGRAM_PLAN_MIGRATIONS = 1;

function selectTelegramPlanMigrations(migrationsDir: string): string[] {
  // Mirrors getMigrationFiles() in check-worker-migrations.ts, inlined to
  // avoid pulling that module's top-level await into this tsx-transformed CLI.
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

function createTelegramPlanDatabase(migrationsDir = resolve("worker/migrations")): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const migrationFiles = selectTelegramPlanMigrations(migrationsDir);
  if (!migrationFiles.includes("0000_baseline.sql")) {
    throw new Error("Telegram plan replay requires worker/migrations/0000_baseline.sql.");
  }
  if (migrationFiles.length < MIN_TELEGRAM_PLAN_MIGRATIONS) {
    throw new Error(
      `Expected at least ${MIN_TELEGRAM_PLAN_MIGRATIONS} Telegram plan migrations, found ${migrationFiles.length}. ` +
        `Update MIN_TELEGRAM_PLAN_MIGRATIONS in check-telegram-load.ts if this is intentional.`,
    );
  }
  for (const file of migrationFiles) {
    db.exec(readFileSync(join(migrationsDir, file), "utf8"));
  }
  return db;
}

export function runQueryPlanChecks(migrationsDir?: string): QueryPlanCheckResult[] {
  const db = createTelegramPlanDatabase(migrationsDir);
  try {
    return buildQueryPlanChecks().map((check) => runExplainQueryPlan(db, check));
  } finally {
    db.close();
  }
}

const STATUS_PATH_FIXTURE_BASE_CREATED_AT = 1_735_689_600; // 2025-01-01T00:00:00Z
const STATUS_PATH_FIXTURE_CREATED_AT_SPREAD_DAYS = 180;

/**
 * Materializes the synthetic watcher fixture into the migrated plan database so
 * status-path budgets measure real query cost at the planning target instead of
 * empty-table plans. Created-at values are spread across distinct UTC days so
 * the lifecycle fallback GROUP BY does representative work.
 */
function seedStatusPathFixture(db: DatabaseSync, fixture: SyntheticTelegramFixture): void {
  const insertSubscriber = db.prepare(
    `INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at, quiet_hours_enabled,
       global_alert_dews, global_alert_depeg, global_alert_safety, global_alert_launch, global_alert_reserve, global_alert_freeze,
       alert_snooze_until_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertSubscription = db.prepare(
    `INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety,
       alert_launch, alert_reserve, alert_freeze, alert_snooze_until_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertPreset = db.prepare(
    `INSERT INTO telegram_preset_subscriptions (chat_id, preset_id, alert_dews, alert_depeg, alert_safety,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  db.exec("BEGIN");
  try {
    fixture.watchers.forEach((watcher, index) => {
      const createdAt = STATUS_PATH_FIXTURE_BASE_CREATED_AT
        + (index % STATUS_PATH_FIXTURE_CREATED_AT_SPREAD_DAYS) * 86_400;
      const snoozeUntil = createdAt + 999_999_999;
      insertSubscriber.run(
        watcher.chatId, createdAt, createdAt + 3_600, watcher.quietHours ? 1 : 0,
        watcher.globals.dews ? 1 : 0, watcher.globals.depeg ? 1 : 0, watcher.globals.safety ? 1 : 0,
        watcher.globals.launch ? 1 : 0, watcher.globals.reserve ? 1 : 0,
        watcher.globals.freeze ? 1 : 0,
        watcher.chatSnoozed ? snoozeUntil : null,
      );
      for (const subscription of watcher.directSubscriptions) {
        insertSubscription.run(
          watcher.chatId, subscription.stablecoinId,
          subscription.flags.dews ? 1 : 0, subscription.flags.depeg ? 1 : 0, subscription.flags.safety ? 1 : 0,
          subscription.flags.launch ? 1 : 0, subscription.flags.reserve ? 1 : 0,
          subscription.flags.freeze ? 1 : 0,
          subscription.snoozed ? snoozeUntil : null,
        );
      }
      for (const preset of watcher.presetSubscriptions) {
        insertPreset.run(
          watcher.chatId, preset.presetId,
          preset.flags.dews ? 1 : 0, preset.flags.depeg ? 1 : 0, preset.flags.safety ? 1 : 0,
          createdAt, createdAt,
        );
      }
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function countTableRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table.replaceAll('"', '""')}"`).get() as { n: number };
  return row.n;
}

export function evaluateStatusPathBudget(
  check: QueryPlanCheckDefinition,
  budget: StatusPathBudget,
  measurement: { rowsRead: number; durationMs: number; seededRowCounts: Record<string, number> },
): StatusPathBudgetResult {
  return {
    id: check.id,
    category: check.category,
    status: measurement.rowsRead <= budget.maxRowsRead && measurement.durationMs <= budget.maxDurationMs
      ? "ok"
      : "fail",
    targetActiveWatchers: REQUIRED_TARGET,
    rowsRead: measurement.rowsRead,
    maxRowsRead: budget.maxRowsRead,
    durationMs: measurement.durationMs,
    maxDurationMs: budget.maxDurationMs,
    seededRowCounts: measurement.seededRowCounts,
    note: check.note,
  };
}

/**
 * TGB-043: enforce reviewed rows-read/duration maxima for the pulse aggregate,
 * top-coins status, and lifecycle-fallback read paths at the required planning
 * target. Rows-read is deterministic (the reviewed plans fully scan their base
 * tables, so seeded row counts are the exact per-refresh read cost); duration
 * is the fastest of a few in-memory runs to dampen CI jitter.
 */
export function runStatusPathBudgetChecks(migrationsDir?: string): StatusPathBudgetResult[] {
  const budgetedChecks = buildQueryPlanChecks().filter(
    (check): check is QueryPlanCheckDefinition & { budget: StatusPathBudget } => check.budget != null,
  );
  if (budgetedChecks.length === 0) return [];

  const db = createTelegramPlanDatabase(migrationsDir);
  try {
    seedStatusPathFixture(db, buildSyntheticTelegramFixture(REQUIRED_TARGET));
    return budgetedChecks.map((check) => {
      const seededRowCounts = Object.fromEntries(
        check.budget.rowsReadTables.map((table) => [table, countTableRows(db, table)]),
      );
      const rowsRead = Object.values(seededRowCounts).reduce((sum, count) => sum + count, 0);
      const statement = db.prepare(check.sql);
      let durationMs = Number.POSITIVE_INFINITY;
      for (let run = 0; run < STATUS_PATH_MEASUREMENT_RUNS; run += 1) {
        const startedAt = performance.now();
        statement.all(...(check.binds as never[]));
        durationMs = Math.min(durationMs, performance.now() - startedAt);
      }
      return evaluateStatusPathBudget(check, check.budget, {
        rowsRead,
        durationMs: Math.round(durationMs * 10) / 10,
        seededRowCounts,
      });
    });
  } finally {
    db.close();
  }
}

export function buildTelegramLoadCheckReport(
  options: {
    targets?: readonly number[];
    skipQueryPlans?: boolean;
    migrationsDir?: string;
  } = {},
): TelegramLoadCheckReport {
  const targets = options.targets ?? WATCHER_TARGETS;
  const fixtures = targets.map((target) => buildSyntheticTelegramFixture(target));
  const scenarios = fixtures.flatMap((fixture) => simulateLoadScenarios(fixture));
  const recapScenarios = fixtures.flatMap((fixture) => {
    const riskBurst = simulateLoadScenarios(fixture).find((scenario) => scenario.scenarioId === "market-wide-burst");
    return simulateTelegramRecapLoadScenarios(fixture.activeWatchers, {
      riskBurstChunks: riskBurst?.messageChunks ?? fixture.activeWatchers,
    });
  });
  const requiredPlanningScenarios = scenarios.filter((scenario) => scenario.targetActiveWatchers === REQUIRED_TARGET);
  const worstCasePlanningDelaySeconds = Math.max(
    0,
    ...(requiredPlanningScenarios.length > 0 ? requiredPlanningScenarios : scenarios).map(
      (scenario) => scenario.planningDelaySeconds,
    ),
  );
  return {
    assumptions: {
      freshAttemptsPerRun: FRESH_ATTEMPTS_PER_RUN,
      pendingDrainAttemptsPerRun: PENDING_DRAIN_ATTEMPTS_PER_RUN,
      cronIntervalSeconds: CRON_INTERVAL_SECONDS,
      dispatchTimeoutSeconds: DISPATCH_TIMEOUT_SECONDS,
      sendLoopSoftDeadlineSeconds: SEND_LOOP_SOFT_DEADLINE_SECONDS,
      telegramBroadcastMessagesPerSecond: TELEGRAM_BROADCAST_MESSAGES_PER_SECOND,
      telegramP95SendLatencyMs: TELEGRAM_P95_SEND_LATENCY_MS,
      effectiveSendMessagesPerSecond: Math.round(EFFECTIVE_SEND_MESSAGES_PER_SECOND * 10) / 10,
      d1WriteMsPerMessage: D1_WRITE_MS_PER_MESSAGE,
      pendingTtlSeconds: PENDING_TTL_SECONDS,
      adminPendingTtlSeconds: ADMIN_PENDING_TTL_SECONDS,
      worstCasePlanningDelaySeconds,
      minimumTtlMarginFraction: MINIMUM_TTL_MARGIN_FRACTION,
      normalSloSeconds: NORMAL_SLO_SECONDS,
      spikeMaxSeconds: SPIKE_MAX_SECONDS,
      dispatchCpuMs: DISPATCH_CPU_MS,
      cpuBudgetSafetyFraction: CPU_BUDGET_SAFETY_FRACTION,
      cpuBudgetCeilingMs: CPU_BUDGET_CEILING_MS,
      formatCpuMsPerChat: FORMAT_CPU_MS_PER_CHAT,
      sendCpuMsPerMessage: SEND_CPU_MS_PER_MESSAGE,
    },
    fixtureSummaries: fixtures.map(summarizeFixture),
    scenarios,
    recapScenarios,
    productionDispatchScenario: simulateProductionCalibratedDispatch(),
    queryPlans: options.skipQueryPlans ? [] : runQueryPlanChecks(options.migrationsDir),
    statusPathBudgets: options.skipQueryPlans ? [] : runStatusPathBudgetChecks(options.migrationsDir),
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const skipQueryPlans = args.includes("--skip-query-plans");
  const enforceTargetSlo = args.includes("--enforce-target-slo");
  const targets = parseTelegramLoadTargets(args) ?? WATCHER_TARGETS;
  const report = buildTelegramLoadCheckReport({ targets, skipQueryPlans });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printTelegramLoadReport(report);
  }

  const failedPlans = report.queryPlans.filter((plan) => plan.status === "fail");
  const failedStatusPathBudgets = report.statusPathBudgets.filter((budget) => budget.status === "fail");
  const normalTargetSloFailures = report.scenarios.filter(
    (scenario) =>
      enforceTargetSlo &&
      scenario.targetActiveWatchers === REQUIRED_TARGET &&
      (scenario.scenarioId === "single-depeg" || scenario.scenarioId === "dews-safety-burst") &&
      scenario.sloStatus !== "ok",
  );
  const spikeTargetSloBreaches = report.scenarios.filter(
    (scenario) =>
      enforceTargetSlo &&
      scenario.targetActiveWatchers === REQUIRED_TARGET &&
      (scenario.scenarioId === "market-wide-burst" || scenario.scenarioId === "telegram-429-storm") &&
      scenario.sloStatus === "breach",
  );
  // C102 gate: the required-target burst must stay under the CPU safety fraction
  // of the per-invocation cap. Always enforced (not gated on --enforce-target-slo).
  const cpuBudgetBreaches = findCpuBudgetBreaches(report);
  const ttlMarginBreaches = enforceTargetSlo ? findTtlMarginBreaches(report) : [];
  const recapLoadBreaches = enforceTargetSlo ? findRecapLoadBreaches(report) : [];
  const productionDispatchBreaches = findProductionDispatchBreaches(report);

  if (
    failedPlans.length > 0 ||
    failedStatusPathBudgets.length > 0 ||
    normalTargetSloFailures.length > 0 ||
    spikeTargetSloBreaches.length > 0 ||
    cpuBudgetBreaches.length > 0 ||
    ttlMarginBreaches.length > 0 ||
    recapLoadBreaches.length > 0 ||
    productionDispatchBreaches.length > 0
  ) {
    if (failedPlans.length > 0) {
      console.error(`\n${failedPlans.length} query-plan check(s) failed.`);
    }
    if (failedStatusPathBudgets.length > 0) {
      console.error(
        `\n${failedStatusPathBudgets.length} status-path budget check(s) exceeded reviewed maxima: ${failedStatusPathBudgets
          .map((budget) => `${budget.id} rowsRead ${budget.rowsRead.toLocaleString()}/${budget.maxRowsRead.toLocaleString()}, duration ${budget.durationMs}ms/${budget.maxDurationMs}ms`)
          .join("; ")}.`,
      );
    }
    if (normalTargetSloFailures.length > 0) {
      console.error(
        `\n${normalTargetSloFailures.length} required ${REQUIRED_TARGET.toLocaleString()}-watcher normal SLO scenario(s) were not OK.`,
      );
    }
    if (spikeTargetSloBreaches.length > 0) {
      console.error(
        `\n${spikeTargetSloBreaches.length} required ${REQUIRED_TARGET.toLocaleString()}-watcher spike scenario(s) breached.`,
      );
    }
    if (cpuBudgetBreaches.length > 0) {
      console.error(
        `\n${cpuBudgetBreaches.length} required ${REQUIRED_TARGET.toLocaleString()}-watcher scenario(s) exceeded the ${report.assumptions.cpuBudgetCeilingMs.toLocaleString()}ms CPU budget ceiling: ${cpuBudgetBreaches
          .map((scenario) => `${scenario.scenarioId} ~${scenario.estimatedCpuMs.toLocaleString()}ms`)
          .join(", ")}.`,
      );
    }
    if (ttlMarginBreaches.length > 0) {
      console.error(
        `\n${ttlMarginBreaches.length} required ${REQUIRED_TARGET.toLocaleString()}-watcher scenario(s) missed the ${(MINIMUM_TTL_MARGIN_FRACTION * 100).toFixed(0)}% TTL margin: ${ttlMarginBreaches
          .map((scenario) => `${scenario.scenarioId} ${(scenario.ttlMarginFraction * 100).toFixed(1)}%`)
          .join(", ")}.`,
      );
    }
    if (recapLoadBreaches.length > 0) {
      console.error(
        `\n${recapLoadBreaches.length} required ${REQUIRED_TARGET.toLocaleString()}-recipient recap scenario(s) failed the TTL, CPU, priority, or zero-call boundary: ${recapLoadBreaches
          .map((scenario) => scenario.scenarioId)
          .join(", ")}.`,
      );
    }
    if (productionDispatchBreaches.length > 0) {
      console.error(
        `\nProduction-calibrated Telegram dispatch failed: ${productionDispatchBreaches.join(", ")}.`,
      );
    }
    process.exit(1);
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  main();
}
