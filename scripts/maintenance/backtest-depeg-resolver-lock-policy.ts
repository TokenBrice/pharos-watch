#!/usr/bin/env tsx

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isRecord } from "@shared/lib/type-guards";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
  DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD,
} from "@shared/lib/methodology-versions/depeg-resolver";
import {
  parseCoverageAuditCliArgs,
  runAsMain,
  runCoverageAuditCli,
} from "../lib/coverage-audit-cli";

export const DDR_LOCK_READINESS_THRESHOLD = DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD;
export const DDR_LOCK_BACKSTOP_DELAY_SEC = DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC;

export type DdrLockHealthStatus = "healthy" | "degraded";
export type DdrBacktestOutcomeKind = "prediction" | "no_call";
export type DdrBacktestDecisionAction =
  | "lock_prediction"
  | "lock_no_call"
  | "pending_lock"
  | "lock_deferred"
  | "already_sealed";
export type DdrBacktestEligibilityReason =
  | "readiness_early_lock"
  | "backstop_72h"
  | "readiness_not_met"
  | "existing_public_prediction";

export interface DdrLockPolicyBacktestRow {
  incidentKey: string;
  eventId: number;
  startedAt: number;
  evaluatedAt: number;
  readinessScore: number | null;
  healthStatus?: DdrLockHealthStatus;
  outcomeKind?: DdrBacktestOutcomeKind;
  existingPublicPredictionId?: number | null;
  expectedAction?: DdrBacktestDecisionAction;
}

export interface DdrLockPolicyDecision {
  incidentKey: string;
  eventId: number;
  action: DdrBacktestDecisionAction;
  eligibilityReason: DdrBacktestEligibilityReason;
  shouldSeal: boolean;
  outcomeKind: DdrBacktestOutcomeKind | null;
  eligibleAt: number;
  readiness: {
    score: number | null;
    threshold: number;
    earlyLockSatisfied: boolean;
    backstopAt: number;
    evaluatedAt: number;
  };
  existingPublicPredictionId: number | null;
  decisionHash: string;
}

export interface DdrLockPolicyBacktestResult {
  generatedAt: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    earlyLockCount: number;
    backstopPredictionCount: number;
    backstopNoCallCount: number;
    pendingCount: number;
    deferredCount: number;
    alreadySealedCount: number;
  };
  rows: Array<{
    input: DdrLockPolicyBacktestRow;
    decision: DdrLockPolicyDecision;
    passed: boolean;
    failure: string | null;
  }>;
}

interface CliOptions {
  fixturePath: string | null;
  reportPath: string | null;
  format: "markdown" | "json";
  generatedAt: string | null;
}

function decisionHash(input: Omit<DdrLockPolicyDecision, "decisionHash">): string {
  return sha256Hex(stableJsonStringifyV1(input));
}

function validateRow(row: unknown, index: number): DdrLockPolicyBacktestRow {
  if (!isRecord(row)) throw new Error(`fixture row ${index} must be an object`);
  const incidentKeyValue = row.incidentKey;
  const eventIdValue = row.eventId;
  const startedAtValue = row.startedAt;
  const evaluatedAtValue = row.evaluatedAt;
  if (typeof incidentKeyValue !== "string" || incidentKeyValue.length === 0) {
    throw new Error(`fixture row ${index} incidentKey must be a non-empty string`);
  }
  if (typeof eventIdValue !== "number" || !Number.isSafeInteger(eventIdValue) || eventIdValue <= 0) {
    throw new Error(`fixture row ${index} eventId must be a positive integer`);
  }
  if (typeof startedAtValue !== "number" || !Number.isSafeInteger(startedAtValue) || startedAtValue < 0) {
    throw new Error(`fixture row ${index} startedAt must be a non-negative integer`);
  }
  if (typeof evaluatedAtValue !== "number" || !Number.isSafeInteger(evaluatedAtValue) || evaluatedAtValue < 0) {
    throw new Error(`fixture row ${index} evaluatedAt must be a non-negative integer`);
  }
  const readinessScoreValue = row.readinessScore;
  if (
    readinessScoreValue != null &&
    (typeof readinessScoreValue !== "number" ||
      !Number.isFinite(readinessScoreValue) ||
      readinessScoreValue < 0 ||
      readinessScoreValue > 1)
  ) {
    throw new Error(`fixture row ${index} readinessScore must be null or a number in [0, 1]`);
  }
  const healthStatusValue = row.healthStatus ?? "healthy";
  if (healthStatusValue !== "healthy" && healthStatusValue !== "degraded") {
    throw new Error(`fixture row ${index} healthStatus must be healthy or degraded`);
  }
  const outcomeKindValue = row.outcomeKind ?? "prediction";
  if (outcomeKindValue !== "prediction" && outcomeKindValue !== "no_call") {
    throw new Error(`fixture row ${index} outcomeKind must be prediction or no_call`);
  }
  const existingPublicPredictionIdValue = row.existingPublicPredictionId ?? null;
  if (
    existingPublicPredictionIdValue !== null &&
    (typeof existingPublicPredictionIdValue !== "number" ||
      !Number.isSafeInteger(existingPublicPredictionIdValue) ||
      existingPublicPredictionIdValue <= 0)
  ) {
    throw new Error(`fixture row ${index} existingPublicPredictionId must be null or a positive integer`);
  }
  const expectedActionValue = row.expectedAction;
  const allowedActions: DdrBacktestDecisionAction[] = [
    "lock_prediction",
    "lock_no_call",
    "pending_lock",
    "lock_deferred",
    "already_sealed",
  ];
  if (expectedActionValue !== undefined && !allowedActions.includes(expectedActionValue as DdrBacktestDecisionAction)) {
    throw new Error(`fixture row ${index} expectedAction is unsupported`);
  }
  return {
    incidentKey: incidentKeyValue,
    eventId: eventIdValue,
    startedAt: startedAtValue,
    evaluatedAt: evaluatedAtValue,
    readinessScore: readinessScoreValue ?? null,
    healthStatus: healthStatusValue,
    outcomeKind: outcomeKindValue,
    existingPublicPredictionId: existingPublicPredictionIdValue,
    expectedAction: expectedActionValue as DdrBacktestDecisionAction | undefined,
  };
}

export function evaluateDdrLockPolicy(row: DdrLockPolicyBacktestRow): DdrLockPolicyDecision {
  const healthStatus = row.healthStatus ?? "healthy";
  const outcomeKind = row.outcomeKind ?? "prediction";
  const existingPublicPredictionId = row.existingPublicPredictionId ?? null;
  const backstopAt = row.startedAt + DDR_LOCK_BACKSTOP_DELAY_SEC;
  const earlyLockSatisfied = row.readinessScore != null && row.readinessScore > DDR_LOCK_READINESS_THRESHOLD;
  const backstopSatisfied = row.evaluatedAt >= backstopAt;

  let action: DdrBacktestDecisionAction;
  let eligibilityReason: DdrBacktestEligibilityReason;
  let shouldSeal = false;
  let resolvedOutcomeKind: DdrBacktestOutcomeKind | null = null;
  let eligibleAt = backstopAt;

  if (existingPublicPredictionId != null) {
    action = "already_sealed";
    eligibilityReason = "existing_public_prediction";
  } else if (backstopSatisfied || earlyLockSatisfied) {
    eligibilityReason = backstopSatisfied ? "backstop_72h" : "readiness_early_lock";
    eligibleAt = backstopSatisfied ? backstopAt : row.evaluatedAt;
    if (healthStatus !== "healthy") {
      action = "lock_deferred";
    } else {
      shouldSeal = true;
      resolvedOutcomeKind = outcomeKind;
      action = outcomeKind === "no_call" ? "lock_no_call" : "lock_prediction";
    }
  } else {
    action = "pending_lock";
    eligibilityReason = "readiness_not_met";
  }

  const withoutHash = {
    incidentKey: row.incidentKey,
    eventId: row.eventId,
    action,
    eligibilityReason,
    shouldSeal,
    outcomeKind: resolvedOutcomeKind,
    eligibleAt,
    readiness: {
      score: row.readinessScore,
      threshold: DDR_LOCK_READINESS_THRESHOLD,
      earlyLockSatisfied,
      backstopAt,
      evaluatedAt: row.evaluatedAt,
    },
    existingPublicPredictionId,
  };
  return {
    ...withoutHash,
    decisionHash: decisionHash(withoutHash),
  };
}

export function buildDdrLockPolicyBacktest(input: {
  rows: DdrLockPolicyBacktestRow[];
  generatedAt?: string;
}): DdrLockPolicyBacktestResult {
  const rows = input.rows.map((row) => {
    const decision = evaluateDdrLockPolicy(row);
    const passed = row.expectedAction == null || row.expectedAction === decision.action;
    return {
      input: row,
      decision,
      passed,
      failure: passed ? null : `expected ${row.expectedAction}, got ${decision.action}`,
    };
  });
  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    summary: {
      total: rows.length,
      passed: rows.filter((row) => row.passed).length,
      failed: rows.filter((row) => !row.passed).length,
      earlyLockCount: rows.filter((row) => row.decision.eligibilityReason === "readiness_early_lock").length,
      backstopPredictionCount: rows.filter(
        (row) => row.decision.eligibilityReason === "backstop_72h" && row.decision.action === "lock_prediction",
      ).length,
      backstopNoCallCount: rows.filter(
        (row) => row.decision.eligibilityReason === "backstop_72h" && row.decision.action === "lock_no_call",
      ).length,
      pendingCount: rows.filter((row) => row.decision.action === "pending_lock").length,
      deferredCount: rows.filter((row) => row.decision.action === "lock_deferred").length,
      alreadySealedCount: rows.filter((row) => row.decision.action === "already_sealed").length,
    },
    rows,
  };
}

export function builtinAcceptanceRows(): DdrLockPolicyBacktestRow[] {
  const startedAt = 1_800_000_000;
  return [
    {
      incidentKey: "ddr2:early-ready",
      eventId: 1,
      startedAt,
      evaluatedAt: startedAt + 12 * 3600,
      readinessScore: 0.750001,
      outcomeKind: "prediction",
      expectedAction: "lock_prediction",
    },
    {
      incidentKey: "ddr2:boundary-not-ready",
      eventId: 2,
      startedAt,
      evaluatedAt: startedAt + 12 * 3600,
      readinessScore: 0.75,
      outcomeKind: "prediction",
      expectedAction: "pending_lock",
    },
    {
      incidentKey: "ddr2:below-threshold-pending",
      eventId: 3,
      startedAt,
      evaluatedAt: startedAt + DDR_LOCK_BACKSTOP_DELAY_SEC - 1,
      readinessScore: 0.61,
      outcomeKind: "prediction",
      expectedAction: "pending_lock",
    },
    {
      incidentKey: "ddr2:backstop-prediction",
      eventId: 4,
      startedAt,
      evaluatedAt: startedAt + DDR_LOCK_BACKSTOP_DELAY_SEC,
      readinessScore: 0.61,
      outcomeKind: "prediction",
      expectedAction: "lock_prediction",
    },
    {
      incidentKey: "ddr2:backstop-no-call",
      eventId: 5,
      startedAt,
      evaluatedAt: startedAt + DDR_LOCK_BACKSTOP_DELAY_SEC,
      readinessScore: null,
      outcomeKind: "no_call",
      expectedAction: "lock_no_call",
    },
    {
      incidentKey: "ddr2:health-deferral",
      eventId: 6,
      startedAt,
      evaluatedAt: startedAt + 12 * 3600,
      readinessScore: 0.91,
      healthStatus: "degraded",
      outcomeKind: "prediction",
      expectedAction: "lock_deferred",
    },
    {
      incidentKey: "ddr2:old-policy-visible",
      eventId: 7,
      startedAt,
      evaluatedAt: startedAt + DDR_LOCK_BACKSTOP_DELAY_SEC,
      readinessScore: 0.92,
      existingPublicPredictionId: 77,
      outcomeKind: "prediction",
      expectedAction: "already_sealed",
    },
  ];
}

function usage(): string {
  return "Usage: tsx scripts/maintenance/backtest-depeg-resolver-lock-policy.ts [--fixture rows.json] [--json] [--report out]";
}

export function parseArgs(argv: string[]): CliOptions {
  return parseCoverageAuditCliArgs(argv, {
    createOptions: (): CliOptions => ({
      fixturePath: null,
      reportPath: null,
      format: "markdown",
      generatedAt: null,
    }),
    includeMarkdown: false,
    includeGeneratedAt: true,
    allowMissingGeneratedAt: true,
    allowMissingReportPath: true,
    usage,
    helpBehavior: "throw",
    options: [
      {
        flag: "--fixture",
        kind: "value",
        allowMissingValue: true,
        apply: (options, value) => { options.fixturePath = value ?? null; },
      },
    ],
    validate: (options) => {
      if (options.fixturePath === "") throw new Error("--fixture requires a path");
      if (options.reportPath === "") throw new Error("--report requires a path");
    },
  });
}

function loadRows(cwd: string, fixturePath: string | null): DdrLockPolicyBacktestRow[] {
  if (!fixturePath) return builtinAcceptanceRows();
  const path = resolve(cwd, fixturePath);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const rows = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.rows : null;
  if (!Array.isArray(rows)) throw new Error("fixture must be an array or an object with rows");
  return rows.map(validateRow);
}

export function renderDdrLockPolicyBacktestMarkdown(result: DdrLockPolicyBacktestResult): string {
  const lines = [
    "# DDR Lock Policy Backtest",
    "",
    `Generated: ${result.generatedAt}`,
    "",
    `- Rows: ${result.summary.total}`,
    `- Passed: ${result.summary.passed}`,
    `- Failed: ${result.summary.failed}`,
    `- Early readiness locks: ${result.summary.earlyLockCount}`,
    `- Backstop predictions: ${result.summary.backstopPredictionCount}`,
    `- Backstop no-calls: ${result.summary.backstopNoCallCount}`,
    `- Pending: ${result.summary.pendingCount}`,
    `- Deferrals: ${result.summary.deferredCount}`,
    `- Already sealed: ${result.summary.alreadySealedCount}`,
    "",
    "incidentKey | action | reason | readiness | hash | result",
    "--- | --- | --- | ---: | --- | ---",
  ];
  for (const row of result.rows) {
    lines.push(
      [
        row.input.incidentKey,
        row.decision.action,
        row.decision.eligibilityReason,
        row.decision.readiness.score ?? "null",
        row.decision.decisionHash.slice(0, 12),
        row.passed ? "pass" : row.failure,
      ].join(" | "),
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function runCli(argv = process.argv.slice(2), cwd = process.cwd()): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof Error && error.message === "help") {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    throw error;
  }

  return runCoverageAuditCli(argv, {
    parse: () => options,
    cwd,
    build: (parsedOptions) => buildDdrLockPolicyBacktest({
      rows: loadRows(cwd, parsedOptions.fixturePath),
      generatedAt: parsedOptions.generatedAt ?? undefined,
    }),
    renderMarkdown: renderDdrLockPolicyBacktestMarkdown,
    evaluate: (result) => result.summary.failed === 0 ? [] : ["backtest failed"],
  });
}

runAsMain(import.meta.url, runCli);
