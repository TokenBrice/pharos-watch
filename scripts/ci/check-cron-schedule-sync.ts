import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  API_FRESHNESS_MAX_AGE_SEC,
  CACHE_FRESHNESS_LANES,
  DEWS_GENERATION_CONSUMER_MAX_AGE_SEC,
  STABLECOINS_GENERATION_CONSUMER_MAX_AGE_SEC,
} from "@shared/lib/api-freshness";
import {
  CRON_SCHEDULE_CADENCES,
  DEX_LIQUIDITY_EVIDENCE_MAX_AGE_SEC,
} from "@shared/lib/cron-cadences";
import {
  CRON_CONNECTION_BUDGET_ENTRIES,
  CRON_GROWTH_HEADROOM_POLICY,
  CRON_INTERVALS,
  CRON_JOB_DEFINITIONS,
  CRON_SCHEDULE_DEFINITIONS,
  CRON_SCHEDULES,
  CRON_TRIGGER_SCHEDULES,
  SAFETY_SCORE_V9_PUBLICATION_REFRESH_INTERVAL_SEC,
  type CronScheduleKey,
} from "@shared/lib/cron-jobs";
import { REFERENCE_CLOSURE_HOLD_BANDS_BPS } from "@shared/lib/depeg-config";
import { resolveExitExecutionPriceLegBudget } from "@shared/lib/safety-score-v9/exit-execution";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import {
  SCHEDULED_SLOT_PLANS,
  type ScheduledWorkerRole,
} from "@shared/lib/scheduled-runner-registry";
import { STATUS_YIELD_HEALTH_THRESHOLDS } from "@shared/lib/status-thresholds";
import { reportViolations } from "../lib/report-violations.mts";
import { scanSourceGate } from "../lib/source-gate.mts";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
import {
  applyGuardBaselineToViolations,
  normalizeBaselineFilePath,
  STATIC_GUARD_BASELINE_PATH,
  verifyStaticGuardBaselineRatchet,
} from "../lib/static-guard-baseline.mjs";
import { parseAssignments } from "../lib/wrangler-toml.mjs";
import { syncWranglerCronTriggers } from "../maintenance/generate-wrangler-cron-triggers";
import type {
  CronGrowthTopologyPolicyForCheck,
  CronJobDefinitionForCheck,
  ScheduledSlotPlanForCheck,
} from "../lib/cron-check-types.mts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const SOURCE_OWNER = {
  wrangler: "worker/wrangler.toml + worker/wrangler.heavy.toml [triggers.crons]",
  schedules: "shared/lib/cron-jobs.ts [CRON_SCHEDULES/CRON_TRIGGER_SCHEDULES]",
  jobDefinitions: "shared/lib/cron-jobs.ts [CRON_JOB_DEFINITIONS]",
  budgetDefinitions: "shared/lib/cron-jobs.ts [CRON_CONNECTION_BUDGET_ENTRIES]",
  slotPlans: "shared/lib/scheduled-runner-registry.ts [SCHEDULED_SLOT_PLANS]",
} as const;


export interface CronScheduleSyncReport {
  physicalTriggerLimitExceeded: boolean;
  growthPolicy: CronGrowthTopologyPolicyForCheck;
  duplicateSlotPlanSchedules: string[];
  duplicateWranglerSchedules: string[];
  misownedWranglerSchedules: string[];
  workerTriggerCounts: Record<ScheduledWorkerRole, number>;
  extraPlanKeys: string[];
  failed: boolean;
  missingBudgetJobs: string[];
  missingPlanKeys: string[];
  missingRuntimeJobs: string[];
  missingSlotPlanSchedules: string[];
  onlyInSlotPlanSchedules: string[];
  scheduleKeyByExpression: Map<string, string>;
  slotPlanKeyByExpression: Map<string, string>;
  slotPlanTriggerCount: number;
  unknownBudgetJobs: string[];
  unknownRuntimeJobs: string[];
  wranglerTriggerCount: number;
}

export function parseWranglerCronTriggers(wranglerToml: string): string[] {
  const cronAssignments = parseAssignments(wranglerToml).filter(
    ({ key, section }) => key === "crons" && section === "triggers",
  );
  if (cronAssignments.length !== 1) {
    throw new Error("Could not find exactly one [triggers].crons array in wrangler.toml");
  }

  return [...cronAssignments[0].value.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function findDuplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function keyByExpression(entries: Iterable<readonly [string, string]>): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, schedule] of entries) {
    if (!result.has(schedule)) {
      result.set(schedule, key);
    }
  }
  return result;
}

function formatSchedule(schedule: string, keyBySchedule: Map<string, string>): string {
  const key = keyBySchedule.get(schedule);
  return key ? `${key}: "${schedule}"` : `"${schedule}"`;
}

function formatList(values: readonly string[], format: (value: string) => string = (value) => value): string[] {
  return values.map((value) => `  - ${format(value)}`);
}

function flattenScheduledJobs(plan: ScheduledSlotPlanForCheck): string[] {
  return plan.jobChains.flatMap((chain) => chain);
}

function getScheduledBudgetEntries(plan: ScheduledSlotPlanForCheck): string[] {
  return [...flattenScheduledJobs(plan), ...(plan.budgetOnlyJobs ?? [])];
}

function getCronScheduleByKey(cronSchedules: Readonly<Record<string, string>>, key: string): string | undefined {
  return cronSchedules[key];
}

export function evaluateCronScheduleSync(input: {
  cronConnectionBudgetEntries?: readonly CronJobDefinitionForCheck[];
  cronJobDefinitions?: readonly CronJobDefinitionForCheck[];
  cronSchedules?: Record<string, string>;
  cronTriggerSchedules?: Readonly<Record<string, readonly string[]>>;
  growthPolicy?: CronGrowthTopologyPolicyForCheck;
  scheduledSlotPlans?: Readonly<Record<string, ScheduledSlotPlanForCheck>>;
  wranglerCronTriggers: Record<ScheduledWorkerRole, Iterable<string>>;
}): CronScheduleSyncReport {
  const cronSchedules = input.cronSchedules ?? CRON_SCHEDULES;
  const cronTriggerSchedules: Readonly<Record<string, readonly string[]>> =
    input.cronTriggerSchedules
    ?? (
      input.cronSchedules
        ? Object.fromEntries(
            Object.entries(cronSchedules).map(([key, schedule]) => [key, [schedule]]),
          )
        : CRON_TRIGGER_SCHEDULES
    );
  const scheduledSlotPlans: Readonly<Record<string, ScheduledSlotPlanForCheck>> =
    input.scheduledSlotPlans ?? SCHEDULED_SLOT_PLANS;
  const cronJobDefinitions = input.cronJobDefinitions ?? CRON_JOB_DEFINITIONS;
  const cronConnectionBudgetEntries = input.cronConnectionBudgetEntries ?? CRON_CONNECTION_BUDGET_ENTRIES;
  const growthPolicy = input.growthPolicy ?? CRON_GROWTH_HEADROOM_POLICY;

  const workerTriggers = {
    public: [...input.wranglerCronTriggers.public],
    heavy: [...input.wranglerCronTriggers.heavy],
  };
  const wranglerCronTriggers = [...workerTriggers.public, ...workerTriggers.heavy];
  const duplicateWranglerSchedules = findDuplicates(wranglerCronTriggers);
  const wranglerCrons = new Set(wranglerCronTriggers);
  const sharedScheduleEntries = Object.entries(cronTriggerSchedules).flatMap(
    ([key, schedules]) => schedules.map((schedule) => [key, schedule] as const),
  );
  const sharedCrons = new Set<string>(sharedScheduleEntries.map(([, schedule]) => schedule));
  const scheduleKeyByExpression = keyByExpression(sharedScheduleEntries);
  const slotPlanScheduleEntries = Object.entries(scheduledSlotPlans)
    .flatMap(([key, plan]) => {
      const schedules =
        plan.triggerSchedules
        ?? cronTriggerSchedules[key]
        ?? [plan.schedule ?? getCronScheduleByKey(cronSchedules, key) ?? ""];
      return schedules.map((schedule) => [key, schedule] as const);
    })
    .filter(([, schedule]) => schedule.length > 0);
  const slotPlanKeyByExpression = keyByExpression(slotPlanScheduleEntries);
  const slotPlanCrons = new Set<string>(slotPlanScheduleEntries.map(([, schedule]) => schedule));
  const duplicateSlotPlanSchedules = findDuplicates(
    slotPlanScheduleEntries.map(([, schedule]) => schedule),
  );

  const misownedWranglerSchedules = (["public", "heavy"] as const).flatMap((role) =>
    workerTriggers[role].filter((expression) => {
      const key = slotPlanKeyByExpression.get(expression);
      return key != null && scheduledSlotPlans[key]?.worker !== role;
    }).map((expression) => `${role}:${expression}`),
  );
  const onlyInSlotPlanSchedules = [...slotPlanCrons].filter((schedule) => !sharedCrons.has(schedule));
  const missingSlotPlanSchedules = [...sharedCrons].filter((schedule) => !slotPlanCrons.has(schedule));

  const planKeys = new Set(Object.keys(scheduledSlotPlans));
  const missingPlanKeys = Object.keys(cronSchedules).filter((key) => !planKeys.has(key));
  const extraPlanKeys = [...planKeys].filter((key) => !(key in cronSchedules));

  const runtimeJobs = new Set(Object.values(scheduledSlotPlans).flatMap(flattenScheduledJobs));
  const expectedCronJobs = new Set(cronJobDefinitions.map((definition) => definition.job));
  const missingRuntimeJobs = [...expectedCronJobs].filter(
    (job) => !runtimeJobs.has(job),
  );
  const unknownRuntimeJobs = [...runtimeJobs].filter((job) => !expectedCronJobs.has(job));

  const scheduledBudgetJobs = new Set(Object.values(scheduledSlotPlans).flatMap(getScheduledBudgetEntries));
  const expectedBudgetJobs = new Set(cronConnectionBudgetEntries.map((definition) => definition.job));
  const missingBudgetJobs = [...expectedBudgetJobs].filter(
    (job) => !scheduledBudgetJobs.has(job),
  );
  const unknownBudgetJobs = [...scheduledBudgetJobs].filter((job) => !expectedBudgetJobs.has(job));
  const physicalTriggerLimitExceeded = wranglerCrons.size > growthPolicy.maxPhysicalTriggersBeforeRebalance;

  const failed = Boolean(
    duplicateWranglerSchedules.length ||
    misownedWranglerSchedules.length ||
    duplicateSlotPlanSchedules.length ||
    onlyInSlotPlanSchedules.length ||
    missingSlotPlanSchedules.length ||
    missingPlanKeys.length ||
    extraPlanKeys.length ||
    missingRuntimeJobs.length ||
    unknownRuntimeJobs.length ||
    missingBudgetJobs.length ||
    unknownBudgetJobs.length ||
    physicalTriggerLimitExceeded,
  );

  return {
    physicalTriggerLimitExceeded,
    growthPolicy,
    extraPlanKeys,
    duplicateSlotPlanSchedules,
    duplicateWranglerSchedules,
    misownedWranglerSchedules,
    workerTriggerCounts: { public: workerTriggers.public.length, heavy: workerTriggers.heavy.length },
    failed,
    missingBudgetJobs,
    missingPlanKeys,
    missingRuntimeJobs,
    missingSlotPlanSchedules,
    onlyInSlotPlanSchedules,
    scheduleKeyByExpression,
    slotPlanKeyByExpression,
    slotPlanTriggerCount: slotPlanCrons.size,
    unknownBudgetJobs,
    unknownRuntimeJobs,
    wranglerTriggerCount: wranglerCrons.size,
  };
}

export function printCronScheduleSyncReport(report: CronScheduleSyncReport): void {
  if (!report.failed) {
    console.log(
      `Cron schedule check passed (${report.wranglerTriggerCount} union triggers: public ${report.workerTriggerCounts.public}, heavy ${report.workerTriggerCounts.heavy}; ${report.slotPlanTriggerCount} mapped).`,
    );
    return;
  }

  console.error("Cron schedule mismatch detected!");
  if (report.misownedWranglerSchedules.length) {
    console.error(`\nWrong Worker ownership in ${SOURCE_OWNER.wrangler}:`);
    console.error(formatList(report.misownedWranglerSchedules).join("\n"));
  }

  if (report.physicalTriggerLimitExceeded) {
    console.error(
      `\nCron growth decision required: ${report.wranglerTriggerCount} physical triggers exceed the reviewed ${report.growthPolicy.maxPhysicalTriggersBeforeRebalance}-trigger topology. Consolidate or rebalance before adding fetch-heavy scheduled work.`,
    );
  }

  if (report.duplicateWranglerSchedules.length) {
    console.error(`\nDuplicate raw schedules in ${SOURCE_OWNER.wrangler}:`);
    console.error(formatList(report.duplicateWranglerSchedules).join("\n"));
  }

  if (report.duplicateSlotPlanSchedules.length) {
    console.error(`\nDuplicate raw trigger schedules in ${SOURCE_OWNER.slotPlans}:`);
    console.error(
      formatList(report.duplicateSlotPlanSchedules, (schedule) =>
        formatSchedule(schedule, report.slotPlanKeyByExpression),
      ).join("\n"),
    );
  }

  if (
    report.onlyInSlotPlanSchedules.length ||
    report.missingSlotPlanSchedules.length ||
    report.missingPlanKeys.length ||
    report.extraPlanKeys.length
  ) {
    console.error(`\nSlot plan drift (${SOURCE_OWNER.slotPlans} <-> ${SOURCE_OWNER.schedules}):`);
    if (report.onlyInSlotPlanSchedules.length) {
      console.error(`Extra schedule in ${SOURCE_OWNER.slotPlans}; no owner in ${SOURCE_OWNER.schedules}:`);
      console.error(
        formatList(report.onlyInSlotPlanSchedules, (schedule) =>
          formatSchedule(schedule, report.slotPlanKeyByExpression),
        ).join("\n"),
      );
    }
    if (report.missingSlotPlanSchedules.length) {
      console.error(`Missing schedule in ${SOURCE_OWNER.slotPlans}; owned by ${SOURCE_OWNER.schedules}:`);
      console.error(
        formatList(report.missingSlotPlanSchedules, (schedule) =>
          formatSchedule(schedule, report.scheduleKeyByExpression),
        ).join("\n"),
      );
    }
    if (report.missingPlanKeys.length) {
      console.error(`Missing key in ${SOURCE_OWNER.slotPlans}; owned by ${SOURCE_OWNER.schedules}:`);
      console.error(formatList(report.missingPlanKeys).join("\n"));
    }
    if (report.extraPlanKeys.length) {
      console.error(`Extra key in ${SOURCE_OWNER.slotPlans}; no owner in ${SOURCE_OWNER.schedules}:`);
      console.error(formatList(report.extraPlanKeys).join("\n"));
    }
  }

  if (report.missingRuntimeJobs.length || report.unknownRuntimeJobs.length) {
    console.error(`\nRuntime job drift (${SOURCE_OWNER.slotPlans} jobChains <-> ${SOURCE_OWNER.jobDefinitions}):`);
    if (report.missingRuntimeJobs.length) {
      console.error(`Missing from ${SOURCE_OWNER.slotPlans} jobChains; owned by ${SOURCE_OWNER.jobDefinitions}:`);
      console.error(formatList(report.missingRuntimeJobs).join("\n"));
    }
    if (report.unknownRuntimeJobs.length) {
      console.error(`Unknown job in ${SOURCE_OWNER.slotPlans} jobChains; no owner in ${SOURCE_OWNER.jobDefinitions}:`);
      console.error(formatList(report.unknownRuntimeJobs).join("\n"));
    }
  }

  if (report.missingBudgetJobs.length || report.unknownBudgetJobs.length) {
    console.error(
      `\nConnection-budget drift (${SOURCE_OWNER.slotPlans} jobChains/budgetOnlyJobs <-> ${SOURCE_OWNER.budgetDefinitions}):`,
    );
    if (report.missingBudgetJobs.length) {
      console.error(
        `Missing from ${SOURCE_OWNER.slotPlans} jobChains/budgetOnlyJobs; owned by ${SOURCE_OWNER.budgetDefinitions}:`,
      );
      console.error(formatList(report.missingBudgetJobs).join("\n"));
    }
    if (report.unknownBudgetJobs.length) {
      console.error(
        `Unknown budget entry in ${SOURCE_OWNER.slotPlans} jobChains/budgetOnlyJobs; no owner in ${SOURCE_OWNER.budgetDefinitions}:`,
      );
      console.error(formatList(report.unknownBudgetJobs).join("\n"));
    }
  }
}

function isMainModule(): boolean {
  return isDirectRun(import.meta.url, process.argv[1]);
}

// ---------------------------------------------------------------------------
// Guard G2 (#2305): Cadence & freshness-budget single-authority + clock hygiene
// ---------------------------------------------------------------------------

export const DEFAULT_FRESHNESS_HYGIENE_ROOTS = [
  "worker/src",
  "shared/lib",
  "scripts/maintenance",
] as const;

const FRESHNESS_HYGIENE_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".mts"]);

const CANONICAL_FRESHNESS_AUTHORITY_FILES = new Set([
  "worker/src/lib/api-freshness-age.ts",
  "worker/src/lib/status/freshness-oracle.ts",
  "shared/lib/relative-time.ts",
]);

// Pinned in shared/data/safety-score-v9/evaluation-build-manifest-v1.ts;
// defer migration to the next planned evaluator release (zero digest churn).
export const PINNED_EVALUATOR_DEFERRED_FILES = new Set([
  "worker/src/lib/safety-score-v9/fact-set-exit.ts",
  "shared/lib/p4-exit-route-observation-assembly.ts",
]);

const CANONICAL_STALE_HEADER_FILES = new Set([
  "worker/src/lib/api-freshness.ts",
  "worker/src/lib/api-freshness-headers.ts",
  "worker/src/lib/safety-score-v9/http-response.ts",
]);

export interface ReviewedTighterAdvisoryBudget {
  apiFreshnessKey: keyof typeof API_FRESHNESS_MAX_AGE_SEC;
  producerJob: string;
  reason: string;
  consumerAlternative: string;
}

export const REVIEWED_TIGHTER_ADVISORY_BUDGETS: Readonly<Record<string, ReviewedTighterAdvisoryBudget>> = {
  stablecoins: {
    apiFreshnessKey: "stablecoins",
    producerJob: "sync-stablecoins",
    reason: "Stricter public endpoint advisory budget (600 s vs 900 s sync-stablecoins).",
    consumerAlternative: "STABLECOINS_GENERATION_CONSUMER_MAX_AGE_SEC",
  },
  bluechipRatings: {
    apiFreshnessKey: "bluechip",
    producerJob: "sync-bluechip",
    reason: "Stricter public advisory budget (43,200 s vs 86,400 s sync-bluechip); availability retains 86,400 s.",
    consumerAlternative: "CACHE_FRESHNESS_LANES.bluechipRatings.availabilityMaxAgeSec",
  },
  mintBurnEvents: {
    apiFreshnessKey: "mintBurnEvents",
    producerJob: "sync-mint-burn",
    reason: "Events feed warns after one missed critical scan (900 s vs 1,800 s sync-mint-burn).",
    consumerAlternative: "API_FRESHNESS_MAX_AGE_SEC.mintBurnFlows",
  },
};

const TIGHTER_ADVISORY_API_KEYS = new Set<string>(
  Object.values(REVIEWED_TIGHTER_ADVISORY_BUDGETS).map((entry) => entry.apiFreshnessKey),
);

const REVIEWED_CAPTURE_CLOCK_FEEDS: Readonly<Record<string, { maxAgeSec: number; reason: string }>> = {
  "frxusd-frax": {
    maxAgeSec: 3600,
    reason: "Chainlink ETH/USD feed is evaluated against capture clock in exit-execution unit tests, not the 4h sync-redemption-backstops cadence.",
  },
};

const WEEKEND_CLOSURE_MIN_SEC = 72 * 3600;
const ALLOW_FRESHNESS_CLAMP_PATTERN = /\/\/\s*pharos-allow-freshness-clamp:\s*(\S[\s\S]*)/;
const MIN_FRESHNESS_ESCAPE_REASON_LEN = 8;

const CURRENT_CLOCK_IDENTIFIERS = new Set([
  "now",
  "nowSec",
  "nowSeconds",
  "nowMs",
  "clockSec",
  "assessedAt",
  "assessedAtSec",
  "readClock",
  "currentSec",
  "currentTs",
  "currentTimeSec",
  "currentTimeMs",
]);

const STORED_TIMESTAMP_NAME_PATTERN =
  /(?:updatedAt|updated_at|publishedAt|published_at|acceptedAt|computedAt|computed_at|observedAt|observed_at|fetchedAt|fetched_at|recordedAt|recorded_at|reviewedAt|reviewed_at|generatedAt|generated_at|lastSuccessAt|lastSyncedAt|lastUpdated|lastSeenAt|timestamp|sourceTimestamp|cachedAt|snapshotAt|syncedAt|capturedAt|createdAt|created_at|pendingSince|lastPublish|blockTimestamp|lastCheckedAt|lastRunAt)(?:Sec|Ms)?$/i;

export interface CadenceAuthorityViolation {
  rule:
    | "consumer-admission-below-cadence"
    | "advisory-budget-unreviewed"
    | "closure-aware-invariant"
    | "sub-cadence-native-usd-feed";
  subject: string;
  message: string;
}

export interface CadenceFreshnessAuthorityReport {
  failed: boolean;
  checkedConsumers: number;
  checkedLanes: number;
  violations: CadenceAuthorityViolation[];
}

export type FreshnessHygieneRule =
  | "adhoc-age-clamp"
  | "advisory-budget-as-admission"
  | "hardcoded-stale-header"
  | "stale-baseline"
  | "baseline-ratchet";

export interface FreshnessHygieneViolation {
  file: string;
  line: number;
  text: string;
  rule: FreshnessHygieneRule;
}

export interface FreshnessHygieneReport {
  scannedFiles: string[];
  violations: FreshnessHygieneViolation[];
}

function readSourceWithOverride(
  cwd: string,
  relPath: string,
  overrides?: Readonly<Record<string, string>>,
): string | null {
  const normalized = normalizeBaselineFilePath(relPath);
  if (overrides && Object.hasOwn(overrides, normalized)) {
    return overrides[normalized]!;
  }
  const absPath = resolve(cwd, normalized);
  if (!existsSync(absPath)) return null;
  return readFileSync(absPath, "utf8");
}

function hasExportedSymbolInSource(source: string, file: string, symbolName: string): boolean {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    const isExported = ts.canHaveModifiers(node)
      && Boolean(ts.getModifiers(node)?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword));
    if (isExported && ts.isFunctionDeclaration(node) && node.name?.text === symbolName) {
      found = true;
      return;
    }
    if (isExported && ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === symbolName) {
          found = true;
          return;
        }
      }
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const elem of node.exportClause.elements) {
        if (elem.name.text === symbolName) {
          found = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return found;
}

function evalNumericConstExpr(
  expr: ts.Expression,
  env: Readonly<Record<string, unknown>>,
): number | null {
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) {
    return evalNumericConstExpr(expr.expression, env);
  }
  if (ts.isIdentifier(expr)) {
    const val = env[expr.text];
    return typeof val === "number" ? val : null;
  }
  if (ts.isPropertyAccessExpression(expr)) {
    const base = resolveObjectExpr(expr.expression, env);
    if (base && typeof base === "object" && expr.name.text in base) {
      const val = (base as Record<string, unknown>)[expr.name.text];
      return typeof val === "number" ? val : null;
    }
    return null;
  }
  if (ts.isElementAccessExpression(expr) && ts.isStringLiteral(expr.argumentExpression)) {
    const base = resolveObjectExpr(expr.expression, env);
    if (base && typeof base === "object" && expr.argumentExpression.text in base) {
      const val = (base as Record<string, unknown>)[expr.argumentExpression.text];
      return typeof val === "number" ? val : null;
    }
    return null;
  }
  if (ts.isBinaryExpression(expr)) {
    const left = evalNumericConstExpr(expr.left, env);
    const right = evalNumericConstExpr(expr.right, env);
    if (left === null || right === null) return null;
    switch (expr.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken: return left + right;
      case ts.SyntaxKind.MinusToken: return left - right;
      case ts.SyntaxKind.AsteriskToken: return left * right;
      case ts.SyntaxKind.SlashToken: return right !== 0 ? left / right : null;
      default: return null;
    }
  }
  return null;
}

function resolveObjectExpr(
  expr: ts.Expression,
  env: Readonly<Record<string, unknown>>,
): unknown {
  if (ts.isIdentifier(expr)) return env[expr.text];
  if (ts.isPropertyAccessExpression(expr)) {
    const base = resolveObjectExpr(expr.expression, env);
    return base && typeof base === "object" ? (base as Record<string, unknown>)[expr.name.text] : undefined;
  }
  if (ts.isElementAccessExpression(expr) && ts.isStringLiteral(expr.argumentExpression)) {
    const base = resolveObjectExpr(expr.expression, env);
    return base && typeof base === "object"
      ? (base as Record<string, unknown>)[expr.argumentExpression.text]
      : undefined;
  }
  return undefined;
}

function readExportedNumericConstFromSource(
  source: string,
  file: string,
  symbolName: string,
  env: Readonly<Record<string, unknown>>,
): number | null {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
  let value: number | null = null;
  const visit = (node: ts.Node): void => {
    if (value !== null) return;
    if (ts.isVariableStatement(node)) {
      const isExported = ts.canHaveModifiers(node)
        && Boolean(ts.getModifiers(node)?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword));
      if (isExported) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text === symbolName && decl.initializer) {
            value = evalNumericConstExpr(decl.initializer, env);
            return;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return value;
}

function computeSlotOffsetLagSec(
  producerScheduleKey: CronScheduleKey,
  consumerSchedule?: CronScheduleKey,
): number {
  if (!consumerSchedule || consumerSchedule === producerScheduleKey) return 0;
  const prod = CRON_SCHEDULE_DEFINITIONS[producerScheduleKey];
  const cons = CRON_SCHEDULE_DEFINITIONS[consumerSchedule];
  if (!prod || !cons || prod.intervalSec <= 0) return 0;
  const diff = (cons.offsetSec - prod.offsetSec) % prod.intervalSec;
  return diff < 0 ? diff + prod.intervalSec : diff;
}

export interface ConsumerAdmissionBudgetSpec {
  consumer: string;
  producerJob: string;
  consumerSchedule?: CronScheduleKey;
  maxAgeSec: number;
  deferralMechanism?: {
    file: string;
    exportedSymbol: string;
  };
}

export function evaluateCadenceFreshnessAuthority(options: {
  cwd?: string;
  sourceOverrides?: Readonly<Record<string, string>>;
  extraConsumerBudgets?: readonly ConsumerAdmissionBudgetSpec[];
} = {}): CadenceFreshnessAuthorityReport {
  const cwd = options.cwd ?? ROOT;
  const overrides = options.sourceOverrides;
  const violations: CadenceAuthorityViolation[] = [];

  const jobByName = new Map(CRON_JOB_DEFINITIONS.map((def) => [def.job, def]));
  const constEnv: Readonly<Record<string, unknown>> = {
    CRON_INTERVALS,
    CRON_SCHEDULE_CADENCES,
    SAFETY_SCORE_V9_PUBLICATION_REFRESH_INTERVAL_SEC,
  };

  // Read Worker-owned consumer freshness constants via AST (preserves ADR-2 script->worker boundary)
  const v9ConsumerFile = "worker/src/lib/safety-score-v9/consumer-freshness.ts";
  const v9ConsumerSource = readSourceWithOverride(cwd, v9ConsumerFile, overrides);
  const v9ConsumerMaxAgeSec = v9ConsumerSource
    ? readExportedNumericConstFromSource(v9ConsumerSource, v9ConsumerFile, "SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC", constEnv)
    : null;

  const v9CaptureFile = "worker/src/cron/compute-safety-score-v9.ts";
  const v9CaptureSource = readSourceWithOverride(cwd, v9CaptureFile, overrides);
  const v9StablecoinsCaptureMaxAgeSec = v9CaptureSource
    ? readExportedNumericConstFromSource(v9CaptureSource, v9CaptureFile, "SAFETY_SCORE_V9_STABLECOINS_CAPTURE_MAX_AGE_SEC", constEnv)
    : null;

  if (v9ConsumerMaxAgeSec === null) {
    violations.push({
      rule: "consumer-admission-below-cadence",
      subject: "SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC",
      message: `Unable to resolve SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC from ${v9ConsumerFile}`,
    });
  }
  if (v9StablecoinsCaptureMaxAgeSec === null) {
    violations.push({
      rule: "consumer-admission-below-cadence",
      subject: "SAFETY_SCORE_V9_STABLECOINS_CAPTURE_MAX_AGE_SEC",
      message: `Unable to resolve SAFETY_SCORE_V9_STABLECOINS_CAPTURE_MAX_AGE_SEC from ${v9CaptureFile}`,
    });
  }

  const erc4626Model = V9_CANDIDATE_POLICY_V1.policy.semantic.exit.executionModels["erc4626-instant"];
  const supplyAttributionPolicy = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution;

  const consumerBudgets: ConsumerAdmissionBudgetSpec[] = [
    {
      consumer: "STABLECOINS_GENERATION_CONSUMER_MAX_AGE_SEC",
      producerJob: "sync-stablecoins",
      maxAgeSec: STABLECOINS_GENERATION_CONSUMER_MAX_AGE_SEC,
    },
    {
      consumer: "DEWS_GENERATION_CONSUMER_MAX_AGE_SEC",
      producerJob: "compute-dews",
      maxAgeSec: DEWS_GENERATION_CONSUMER_MAX_AGE_SEC,
    },
    ...(v9ConsumerMaxAgeSec !== null
      ? [{
          consumer: "SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC",
          producerJob: "compute-safety-score-v9",
          maxAgeSec: v9ConsumerMaxAgeSec,
        }]
      : []),
    {
      consumer: "DEX_LIQUIDITY_EVIDENCE_MAX_AGE_SEC",
      producerJob: "sync-dex-liquidity",
      maxAgeSec: DEX_LIQUIDITY_EVIDENCE_MAX_AGE_SEC,
    },
    ...(v9StablecoinsCaptureMaxAgeSec !== null
      ? [{
          consumer: "SAFETY_SCORE_V9_STABLECOINS_CAPTURE_MAX_AGE_SEC",
          producerJob: "prepare-safety-score-v9-input",
          consumerSchedule: "v9PublicationOffset" as CronScheduleKey,
          maxAgeSec: v9StablecoinsCaptureMaxAgeSec,
        }]
      : []),
    {
      consumer: "STATUS_YIELD_HEALTH_THRESHOLDS.supplementalMaxAgeSec",
      producerJob: "sync-yield-supplemental",
      maxAgeSec: STATUS_YIELD_HEALTH_THRESHOLDS.supplementalMaxAgeSec,
    },
    {
      consumer: "STATUS_YIELD_HEALTH_THRESHOLDS.benchmarkMaxAgeSec",
      producerJob: "fetch-tbill-rate",
      maxAgeSec: STATUS_YIELD_HEALTH_THRESHOLDS.benchmarkMaxAgeSec,
    },
    {
      consumer: "V9_CANDIDATE_POLICY_V1.exit.executionModels[erc4626-instant].sourceMaxAgeSec",
      producerJob: "sync-redemption-backstops",
      maxAgeSec: erc4626Model.sourceMaxAgeSec,
    },
    {
      consumer: "V9_CANDIDATE_POLICY_V1.exit.executionModels[erc4626-instant].priceMaxAgeSec",
      producerJob: "sync-redemption-backstops",
      maxAgeSec: erc4626Model.priceMaxAgeSec,
    },
    {
      consumer: "V9_CANDIDATE_POLICY_V1.supplyAttribution.referencePriceMaxAgeSec",
      producerJob: "prepare-safety-score-v9-input",
      consumerSchedule: "v9SupplyAttributionOffset",
      maxAgeSec: supplyAttributionPolicy.referencePriceMaxAgeSec,
      deferralMechanism: {
        file: "worker/src/lib/safety-score-v9/supply-attribution-capture.ts",
        exportedSymbol: "supplyAttributionCaptureAdmission",
      },
    },
    ...(options.extraConsumerBudgets ?? []),
  ];

  // 1. Producer-to-consumer admission invariant
  for (const spec of consumerBudgets) {
    const job = jobByName.get(spec.producerJob);
    if (!job) {
      violations.push({
        rule: "consumer-admission-below-cadence",
        subject: spec.consumer,
        message: `Unknown producer job "${spec.producerJob}"`,
      });
      continue;
    }
    const lagSec = computeSlotOffsetLagSec(job.scheduleKey, spec.consumerSchedule);
    const requiredMinSec = job.intervalSec + lagSec;
    if (spec.maxAgeSec < requiredMinSec) {
      if (spec.deferralMechanism) {
        const deferralSrc = readSourceWithOverride(cwd, spec.deferralMechanism.file, overrides);
        const verified = deferralSrc !== null
          && hasExportedSymbolInSource(deferralSrc, spec.deferralMechanism.file, spec.deferralMechanism.exportedSymbol);
        if (verified) continue;
        violations.push({
          rule: "consumer-admission-below-cadence",
          subject: spec.consumer,
          message: `${spec.consumer} (${spec.maxAgeSec}s) < producer "${spec.producerJob}" interval+lag (${requiredMinSec}s) and required deferral symbol "${spec.deferralMechanism.exportedSymbol}" is missing from ${spec.deferralMechanism.file}`,
        });
      } else {
        violations.push({
          rule: "consumer-admission-below-cadence",
          subject: spec.consumer,
          message: `${spec.consumer} (${spec.maxAgeSec}s) < producer "${spec.producerJob}" interval+lag (${requiredMinSec}s)`,
        });
      }
    }
  }

  // 2. Public endpoint & cache availability lanes vs producer cadence
  const observedTighterKeys = new Set<string>();
  const laneEntries = Object.entries(CACHE_FRESHNESS_LANES);
  for (const [laneKey, lane] of laneEntries) {
    const producerIntervalSec = CRON_INTERVALS[lane.producerJob];
    if (typeof producerIntervalSec !== "number") {
      violations.push({
        rule: "advisory-budget-unreviewed",
        subject: `CACHE_FRESHNESS_LANES.${laneKey}`,
        message: `Unknown producerJob "${lane.producerJob}"`,
      });
      continue;
    }
    const isTighter = lane.endpointMaxAgeSec < producerIntervalSec || lane.availabilityMaxAgeSec < producerIntervalSec;
    if (isTighter) {
      observedTighterKeys.add(laneKey);
      const reviewed = REVIEWED_TIGHTER_ADVISORY_BUDGETS[laneKey];
      if (!reviewed || !reviewed.reason.trim() || !reviewed.consumerAlternative.trim()) {
        violations.push({
          rule: "advisory-budget-unreviewed",
          subject: `CACHE_FRESHNESS_LANES.${laneKey}`,
          message: `Lane "${laneKey}" has tighter budget (endpoint=${lane.endpointMaxAgeSec}s, availability=${lane.availabilityMaxAgeSec}s) than producer "${lane.producerJob}" (${producerIntervalSec}s) without a reviewed REVIEWED_TIGHTER_ADVISORY_BUDGETS entry`,
        });
      }
    }
  }

  const endpointProducerMap: ReadonlyArray<[keyof typeof API_FRESHNESS_MAX_AGE_SEC, string, string]> = [
    ["stablecoins", "sync-stablecoins", "stablecoins"],
    ["stablecoinCharts", "sync-stablecoin-charts", "stablecoinCharts"],
    ["chains", "sync-stablecoins", "chains"],
    ["pegSummary", "sync-stablecoins", "pegSummary"],
    ["depegEvents", "sync-stablecoins", "depegEvents"],
    ["stressSignals", "compute-dews", "dews"],
    ["reportCards", "compute-safety-score-v9", "reportCards"],
    ["depegResolver", "compute-depeg-resolver", "depegResolver"],
    ["depegResolverReview", "compute-depeg-resolver", "depegResolverReview"],
    ["redemptionBackstops", "sync-redemption-backstops", "redemptionBackstops"],
    ["supplyHistory", "snapshot-supply", "supplyHistory"],
    ["mintBurnFlows", "sync-mint-burn", "mintBurnFlows"],
    ["mintBurnEvents", "sync-mint-burn", "mintBurnEvents"],
    ["blacklist", "sync-blacklist", "blacklist"],
    ["blacklistSummary", "sync-blacklist", "blacklistSummary"],
    ["dexLiquidity", "sync-dex-liquidity", "dexLiquidity"],
    ["yieldRankings", "sync-yield-data", "yieldData"],
    ["yieldHistory", "sync-yield-data", "yieldData"],
    ["stabilityIndex", "stability-index", "stabilityIndex"],
    ["dailyDigest", "daily-digest", "dailyDigest"],
    ["digestArchive", "daily-digest", "digestArchive"],
    ["bluechip", "sync-bluechip", "bluechipRatings"],
    ["usdsStatus", "sync-usds-status", "usdsStatus"],
    ["nonUsdShare", "snapshot-supply", "nonUsdShare"],
  ];

  for (const [apiKey, producerJob, reviewKey] of endpointProducerMap) {
    const budget = API_FRESHNESS_MAX_AGE_SEC[apiKey];
    const producerIntervalSec = CRON_INTERVALS[producerJob];
    if (typeof producerIntervalSec === "number" && budget < producerIntervalSec) {
      observedTighterKeys.add(reviewKey);
      const reviewed = REVIEWED_TIGHTER_ADVISORY_BUDGETS[reviewKey];
      if (!reviewed || !reviewed.reason.trim() || !reviewed.consumerAlternative.trim()) {
        violations.push({
          rule: "advisory-budget-unreviewed",
          subject: `API_FRESHNESS_MAX_AGE_SEC.${apiKey}`,
          message: `Endpoint "${apiKey}" budget (${budget}s) < producer "${producerJob}" interval (${producerIntervalSec}s) without a reviewed REVIEWED_TIGHTER_ADVISORY_BUDGETS entry`,
        });
      }
    }
  }

  for (const key of Object.keys(REVIEWED_TIGHTER_ADVISORY_BUDGETS)) {
    if (!observedTighterKeys.has(key)) {
      violations.push({
        rule: "advisory-budget-unreviewed",
        subject: `REVIEWED_TIGHTER_ADVISORY_BUDGETS.${key}`,
        message: `Stale reviewed tighter-budget entry "${key}" is no longer tighter than its producer cadence`,
      });
    }
  }

  // 3. Closure-aware FX / metal feed invariant
  const fxStateFile = "worker/src/lib/fx-rate-state.ts";
  const fxStateSource = readSourceWithOverride(cwd, fxStateFile, overrides);
  const hasBuildFxCacheStatus = fxStateSource !== null
    && hasExportedSymbolInSource(fxStateSource, fxStateFile, "buildFxCacheStatus");
  if (CACHE_FRESHNESS_LANES.fxRates.endpointMaxAgeSec < WEEKEND_CLOSURE_MIN_SEC && !hasBuildFxCacheStatus) {
    violations.push({
      rule: "closure-aware-invariant",
      subject: "CACHE_FRESHNESS_LANES.fxRates",
      message: `fxRates budget (${CACHE_FRESHNESS_LANES.fxRates.endpointMaxAgeSec}s) < 72h weekend closure and buildFxCacheStatus is missing from ${fxStateFile}`,
    });
  }
  const metalPriceMaxAgeSec = V9_CANDIDATE_POLICY_V1.policy.semantic.exit.physicalToUsd.metalPriceMaxAgeSec;
  if (metalPriceMaxAgeSec < WEEKEND_CLOSURE_MIN_SEC && Object.keys(REFERENCE_CLOSURE_HOLD_BANDS_BPS).length === 0) {
    violations.push({
      rule: "closure-aware-invariant",
      subject: "V9_CANDIDATE_POLICY_V1.exit.physicalToUsd.metalPriceMaxAgeSec",
      message: `metalPriceMaxAgeSec (${metalPriceMaxAgeSec}s) < 72h weekend closure without REFERENCE_CLOSURE_HOLD_BANDS_BPS`,
    });
  }
  if (erc4626Model.priceMaxAgeSec < WEEKEND_CLOSURE_MIN_SEC && typeof resolveExitExecutionPriceLegBudget !== "function") {
    violations.push({
      rule: "closure-aware-invariant",
      subject: "V9_CANDIDATE_POLICY_V1.exit.executionModels[erc4626-instant].priceMaxAgeSec",
      message: `erc4626-instant priceMaxAgeSec (${erc4626Model.priceMaxAgeSec}s) < 72h weekend closure without resolveExitExecutionPriceLegBudget`,
    });
  }

  // 4. Pure numeric sub-cadence nativeUsdFeed review check (no AST scanning of V9-pinned files)
  const exitReviewsFile = "shared/data/safety-score-v9/exit-execution-model-reviews-v1.json";
  const exitReviewsRaw = readSourceWithOverride(cwd, exitReviewsFile, overrides);
  const redemptionCadenceSec = CRON_INTERVALS["sync-redemption-backstops"] ?? 14_400;
  if (exitReviewsRaw) {
    const parsed = JSON.parse(exitReviewsRaw) as {
      reviews?: Array<{
        identity?: { assetId?: string };
        producer?: {
          externalShareToken?: {
            nativeUsdFeed?: { maxAgeSec?: number; clockScope?: string };
          };
        };
      }>;
    };
    for (const review of parsed.reviews ?? []) {
      const feed = review.producer?.externalShareToken?.nativeUsdFeed;
      if (!feed || typeof feed.maxAgeSec !== "number") continue;
      if (feed.maxAgeSec >= redemptionCadenceSec) continue;
      const assetId = review.identity?.assetId ?? "unknown";
      const reviewedCapture = REVIEWED_CAPTURE_CLOCK_FEEDS[assetId];
      if (feed.clockScope === "capture") continue;
      if (!reviewedCapture || reviewedCapture.maxAgeSec !== feed.maxAgeSec) {
        violations.push({
          rule: "sub-cadence-native-usd-feed",
          subject: `${exitReviewsFile}:${assetId}`,
          message: `nativeUsdFeed.maxAgeSec (${feed.maxAgeSec}s) < sync-redemption-backstops cadence (${redemptionCadenceSec}s) without clockScope:"capture" or REVIEWED_CAPTURE_CLOCK_FEEDS entry`,
        });
      }
    }
  }

  return {
    failed: violations.length > 0,
    checkedConsumers: consumerBudgets.length,
    checkedLanes: laneEntries.length,
    violations,
  };
}

function unwrapTsExpr(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (
    ts.isParenthesizedExpression(cur)
    || ts.isAsExpression(cur)
    || ts.isSatisfiesExpression(cur)
    || ts.isNonNullExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

function isZeroLiteral(expr: ts.Expression): boolean {
  const unwrapped = unwrapTsExpr(expr);
  return ts.isNumericLiteral(unwrapped) && Number(unwrapped.text) === 0;
}

function isDateNowCall(expr: ts.Expression): boolean {
  const unwrapped = unwrapTsExpr(expr);
  return ts.isCallExpression(unwrapped)
    && ts.isPropertyAccessExpression(unwrapped.expression)
    && ts.isIdentifier(unwrapped.expression.expression)
    && unwrapped.expression.expression.text === "Date"
    && unwrapped.expression.name.text === "now";
}

function isCurrentClockExpr(expr: ts.Expression): boolean {
  const cur = unwrapTsExpr(expr);
  if (ts.isIdentifier(cur)) {
    return CURRENT_CLOCK_IDENTIFIERS.has(cur.text);
  }
  if (ts.isPropertyAccessExpression(cur)) {
    return CURRENT_CLOCK_IDENTIFIERS.has(cur.name.text);
  }
  if (isDateNowCall(cur)) return true;
  // Math.floor(Date.now() / 1000) / Math.round(Date.now() / 1_000)
  if (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)
    && ts.isIdentifier(cur.expression.expression) && cur.expression.expression.text === "Math"
    && (cur.expression.name.text === "floor" || cur.expression.name.text === "round" || cur.expression.name.text === "trunc")
    && cur.arguments.length === 1) {
    const inner = unwrapTsExpr(cur.arguments[0]!);
    if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.SlashToken) {
      return isDateNowCall(inner.left);
    }
  }
  return false;
}

function isStoredTimestampExpr(expr: ts.Expression): boolean {
  let cur = unwrapTsExpr(expr);
  // Allow Number(row.updated_at) or Math.floor(tsMs / 1000)
  if (ts.isCallExpression(cur) && ts.isIdentifier(cur.expression) && cur.expression.text === "Number"
    && cur.arguments.length === 1) {
    cur = unwrapTsExpr(cur.arguments[0]!);
  } else if (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)
    && ts.isIdentifier(cur.expression.expression) && cur.expression.expression.text === "Math"
    && (cur.expression.name.text === "floor" || cur.expression.name.text === "round" || cur.expression.name.text === "trunc")
    && cur.arguments.length === 1) {
    const inner = unwrapTsExpr(cur.arguments[0]!);
    if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.SlashToken) {
      cur = unwrapTsExpr(inner.left);
    }
  }
  if (ts.isIdentifier(cur)) {
    return STORED_TIMESTAMP_NAME_PATTERN.test(cur.text);
  }
  if (ts.isPropertyAccessExpression(cur)) {
    return STORED_TIMESTAMP_NAME_PATTERN.test(cur.name.text);
  }
  return false;
}

function extractClockSubtraction(expr: ts.Expression): ts.BinaryExpression | null {
  let cur = unwrapTsExpr(expr);
  // Handle Math.floor((nowMs - updatedAtMs) / 1000) inside Math.max(0, ...)
  if (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)
    && ts.isIdentifier(cur.expression.expression) && cur.expression.expression.text === "Math"
    && (cur.expression.name.text === "floor" || cur.expression.name.text === "round" || cur.expression.name.text === "trunc")
    && cur.arguments.length === 1) {
    cur = unwrapTsExpr(cur.arguments[0]!);
  }
  if (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.SlashToken) {
    cur = unwrapTsExpr(cur.left);
  }
  if (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.MinusToken) {
    return cur;
  }
  return null;
}

function hasFreshnessClampAllowComment(target: ts.Node, sourceFile: ts.SourceFile): boolean {
  const matchesAt = (position: number): boolean => (
    ts.getLeadingCommentRanges(sourceFile.text, position) ?? []
  ).some((comment) => {
    if (comment.kind !== ts.SyntaxKind.SingleLineCommentTrivia) return false;
    const match = ALLOW_FRESHNESS_CLAMP_PATTERN.exec(sourceFile.text.slice(comment.pos, comment.end));
    return Boolean(match && match[1]!.trim().length >= MIN_FRESHNESS_ESCAPE_REASON_LEN);
  });
  let node: ts.Node = target;
  while (!ts.isBlock(node) && !ts.isSourceFile(node)) {
    if (matchesAt(node.getFullStart())) return true;
    if (ts.isStatement(node) || !node.parent) break;
    node = node.parent;
  }
  return false;
}

function isFreshnessTestOrHelperPath(relPath: string): boolean {
  return /(?:^|\/)(?:__tests__|__mocks__|test-helpers|test-utils|fixtures)\//.test(relPath)
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relPath)
    || /test-support\.[cm]?[jt]sx?$/.test(relPath);
}

export function scanFreshnessClockSource(file: string, source: string): FreshnessHygieneViolation[] {
  const relPath = normalizeBaselineFilePath(file);
  if (isFreshnessTestOrHelperPath(relPath)) return [];

  const checkAgeClamp = !CANONICAL_FRESHNESS_AUTHORITY_FILES.has(relPath)
    && !PINNED_EVALUATOR_DEFERRED_FILES.has(relPath);
  const checkAdvisoryAdmission = !relPath.startsWith("worker/src/api/")
    && !relPath.startsWith("src/")
    && relPath !== "shared/lib/api-freshness.ts"
    && relPath !== "shared/lib/data-surface-descriptors.ts";
  const checkStaleHeader = !CANONICAL_STALE_HEADER_FILES.has(relPath);

  const lines = source.split("\n");
  const sourceFile = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true);
  const violations: FreshnessHygieneViolation[] = [];

  const visit = (node: ts.Node): void => {
    // 1. adhoc-age-clamp: Math.max(0, now - ts) or Math.max(now - ts, 0)
    if (checkAgeClamp && ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Math"
      && node.expression.name.text === "max"
      && node.arguments.length === 2) {
      const [arg0, arg1] = node.arguments;
      const candidate = isZeroLiteral(arg0!) ? arg1! : isZeroLiteral(arg1!) ? arg0! : null;
      if (candidate) {
        const sub = extractClockSubtraction(candidate);
        if (sub && isCurrentClockExpr(sub.left) && isStoredTimestampExpr(sub.right)) {
          if (!hasFreshnessClampAllowComment(node, sourceFile)) {
            const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
            violations.push({
              file: relPath,
              line,
              text: `${lines[line - 1]?.trim() ?? ""} (ad-hoc Math.max(0, now - ts) hides future clocks; use assessFreshnessTimestamp or classifyFreshness)`,
              rule: "adhoc-age-clamp",
            });
          }
        }
      }
    }

    // 2. advisory-budget-as-admission: API_FRESHNESS_MAX_AGE_SEC.<tighterKey> outside API/UI
    if (checkAdvisoryAdmission) {
      if (ts.isPropertyAccessExpression(node)
        && ts.isIdentifier(node.expression) && node.expression.text === "API_FRESHNESS_MAX_AGE_SEC"
        && TIGHTER_ADVISORY_API_KEYS.has(node.name.text)
        && !hasFreshnessClampAllowComment(node, sourceFile)) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        violations.push({
          file: relPath,
          line,
          text: `${lines[line - 1]?.trim() ?? ""} (advisory budget API_FRESHNESS_MAX_AGE_SEC.${node.name.text} is tighter than producer cadence; use consumer admission constant)`,
          rule: "advisory-budget-as-admission",
        });
      } else if (ts.isElementAccessExpression(node)
        && ts.isIdentifier(node.expression) && node.expression.text === "API_FRESHNESS_MAX_AGE_SEC"
        && ts.isStringLiteral(node.argumentExpression)
        && TIGHTER_ADVISORY_API_KEYS.has(node.argumentExpression.text)
        && !hasFreshnessClampAllowComment(node, sourceFile)) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        violations.push({
          file: relPath,
          line,
          text: `${lines[line - 1]?.trim() ?? ""} (advisory budget API_FRESHNESS_MAX_AGE_SEC["${node.argumentExpression.text}"] is tighter than producer cadence; use consumer admission constant)`,
          rule: "advisory-budget-as-admission",
        });
      }
    }

    // 3. hardcoded-stale-header: "X-Data-Freshness": "stale" or headers.set("X-Data-Freshness", "stale")
    if (checkStaleHeader) {
      if (ts.isPropertyAssignment(node)) {
        const keyText = ts.isStringLiteral(node.name) ? node.name.text : null;
        const init = unwrapTsExpr(node.initializer);
        if (keyText?.toLowerCase() === "x-data-freshness"
          && ts.isStringLiteral(init) && init.text.toLowerCase() === "stale") {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          violations.push({
            file: relPath,
            line,
            text: `${lines[line - 1]?.trim() ?? ""} (hardcoded X-Data-Freshness: stale outside canonical freshness header authority)`,
            rule: "hardcoded-stale-header",
          });
        }
      } else if (ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "set"
        && node.arguments.length >= 2) {
        const headerArg = unwrapTsExpr(node.arguments[0]!);
        const valueArg = unwrapTsExpr(node.arguments[1]!);
        if (ts.isStringLiteral(headerArg) && headerArg.text.toLowerCase() === "x-data-freshness"
          && ts.isStringLiteral(valueArg) && valueArg.text.toLowerCase() === "stale") {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          violations.push({
            file: relPath,
            line,
            text: `${lines[line - 1]?.trim() ?? ""} (hardcoded X-Data-Freshness: stale outside canonical freshness header authority)`,
            rule: "hardcoded-stale-header",
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return violations;
}

export function scanFreshnessClockHygiene(
  roots: readonly string[] = DEFAULT_FRESHNESS_HYGIENE_ROOTS,
  cwd = ROOT,
  options: { applyBaseline?: boolean; checkRatchet?: boolean; baseRef?: string } = {},
): FreshnessHygieneReport {
  const raw = scanSourceGate<FreshnessHygieneViolation>({
    roots,
    cwd,
    extensions: FRESHNESS_HYGIENE_EXTENSIONS,
    scanFile: ({ relativePath, content }) => scanFreshnessClockSource(relativePath, content),
  });

  const useBaseline = options.applyBaseline ?? true;
  if (!useBaseline) {
    return raw;
  }

  const isDefaultScan = roots.length === DEFAULT_FRESHNESS_HYGIENE_ROOTS.length
    && DEFAULT_FRESHNESS_HYGIENE_ROOTS.every((root, index) => roots[index] === root);
  const hasBaselineFile = existsSync(resolve(cwd, STATIC_GUARD_BASELINE_PATH));
  const coveredRoots = roots.map((root) => normalizeBaselineFilePath(root));

  const { violations, stale } = applyGuardBaselineToViolations("g2-freshness-clock-hygiene", raw.violations, {
    cwd,
    coveredRoots,
    checkStale: hasBaselineFile,
    required: isDefaultScan && hasBaselineFile,
  });

  const combined: FreshnessHygieneViolation[] = [
    ...violations,
    ...stale.map((item) => ({ ...item, rule: "stale-baseline" as const })),
  ];

  const shouldCheckRatchet = options.checkRatchet ?? (isDefaultScan && hasBaselineFile);
  if (shouldCheckRatchet) {
    const ratchetErrors = verifyStaticGuardBaselineRatchet({
      cwd,
      baseRef: options.baseRef,
      required: true,
    });
    for (const error of ratchetErrors) {
      combined.push({
        file: STATIC_GUARD_BASELINE_PATH,
        line: 1,
        text: error,
        rule: "baseline-ratchet",
      });
    }
  }

  return { scannedFiles: raw.scannedFiles, violations: combined };
}

export function printCadenceFreshnessReports(
  authority: CadenceFreshnessAuthorityReport,
  hygiene: FreshnessHygieneReport,
): number {
  let exitCode = 0;
  if (authority.failed) {
    console.error("Cadence & freshness-budget authority check failed:");
    for (const violation of authority.violations) {
      console.error(`  [${violation.rule}] ${violation.subject}: ${violation.message}`);
    }
    exitCode = 1;
  } else {
    console.log(
      `Cadence & freshness-budget authority: OK (${authority.checkedConsumers} consumer budgets, ${authority.checkedLanes} cache lanes verified).`,
    );
  }

  const hygieneStatus = reportViolations({
    label: "Freshness clock hygiene",
    heading: "Freshness clock hygiene violations",
    violations: hygiene.violations.map((v) => `${v.file}:${v.line}: [${v.rule}] ${v.text}`),
    hint: "Fix: route age checks through assessFreshnessTimestamp / classifyFreshness (or annotate with // pharos-allow-freshness-clamp: <reason>), use consumer admission constants instead of tighter advisory API budgets, and use buildFreshnessMeta instead of hardcoded X-Data-Freshness: stale. Shrink .ci/static-guard-baselines.json when fixing baselined sites.",
    scannedCount: hygiene.scannedFiles.length,
  });
  if (hygieneStatus !== 0) exitCode = 1;
  return exitCode;
}

if (isMainModule()) {
  try {
    syncWranglerCronTriggers(ROOT, true);
    const wranglerToml = readFileSync(join(ROOT, "worker/wrangler.toml"), "utf-8");
    const heavyToml = readFileSync(join(ROOT, "worker/wrangler.heavy.toml"), "utf-8");
    const report = evaluateCronScheduleSync({
      wranglerCronTriggers: {
        public: parseWranglerCronTriggers(wranglerToml),
        heavy: parseWranglerCronTriggers(heavyToml),
      },
    });
    printCronScheduleSyncReport(report);
    const authority = evaluateCadenceFreshnessAuthority({ cwd: ROOT });
    const hygiene = scanFreshnessClockHygiene(DEFAULT_FRESHNESS_HYGIENE_ROOTS, ROOT);
    const freshnessExit = printCadenceFreshnessReports(authority, hygiene);
    if (report.failed || freshnessExit !== 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
