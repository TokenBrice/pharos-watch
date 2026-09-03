#!/usr/bin/env node
/**
 * Reads Telegram adoption and five-minute dispatch telemetry from remote D1,
 * updates the generated adoption block in docs/telegram-alerts.md, and prints
 * the report as JSON.
 *
 * The report is intentionally read-only. Run it after the 14-day capture window
 * described in the generated documentation block.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createD1Client, sqlString, type D1Client } from "../lib/remote-d1";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const DOC_PATH = resolve(ROOT, "docs/telegram-alerts.md");
const GENERATED_KEY = "telegram-adoption";
const START_MARKER = `<!-- GENERATED-START: ${GENERATED_KEY} -->`;
const END_MARKER = `<!-- GENERATED-END: ${GENERATED_KEY} -->`;
const DAY_SEC = 24 * 60 * 60;
const CAPTURE_DAYS = 14;
const ADOPTION_DAYS = 30;
const ACTIVE_WATCHER_DAYS = 7;
const FIVE_MINUTE_LANE: Record<string, true> = {
  "dispatch-telegram-alerts": true,
  "telegram-personalized-recap-planner": true,
  "telegram-degradation-watchdog": true,
  "telegram-disambiguation-cleanup": true,
  "telegram-pulse-snapshot": true,
};

export interface TelegramAdoptionReport {
  generatedAt: string;
  window: {
    startSec: number;
    endSec: number;
    captureDays: number;
  };
  adoption: {
    subscriberCount: number;
    activeWatchers7d: number;
    dailyActive: number;
    alertsSent7d: number;
    alertsSent30d: number;
  };
  planning: {
    dispatchInvocations: number;
    planningMs: { p50: number | null; p95: number | null };
    noWorkRunShare: number | null;
    planningStatements: number;
    fiveMinuteLaneD1Statements: number | null;
    planningStatementFraction: number | null;
  };
  decision: {
    proceed41: boolean;
  };
}

type SubscriberCountRow = {
  subscriber_count?: number | string | null;
  active_watchers_7d?: number | string | null;
};

type LifecycleRow = {
  day?: string | null;
  active_watchers?: number | string | null;
};

type UsageRow = {
  day?: string | null;
  event_type?: string | null;
  outcome?: string | null;
  count?: number | string | null;
};

type DeliveryRow = {
  final_delivery_at?: number | string | null;
};

type CronRunRow = {
  job?: string | null;
  started_at?: number | string | null;
  slot_started_at?: number | string | null;
  duration_ms?: number | string | null;
  item_count?: number | string | null;
  metadata?: string | Record<string, unknown> | null;
  d1_statements?: number | string | null;
};

function numberValue(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function nonnegative(value: unknown): number {
  return Math.max(0, numberValue(value) ?? 0);
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function utcDay(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower] ?? null;
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (index - lower);
}

function latestLifecycleValue(rows: LifecycleRow[]): number | null {
  const values = rows
    .filter((row) => typeof row.day === "string")
    .sort((left, right) => String(left.day).localeCompare(String(right.day)))
    .map((row) => numberValue(row.active_watchers))
    .filter((value): value is number => value != null);
  return values.at(-1) ?? null;
}


function usageAlertsSent(rows: UsageRow[]): number {
  const alertEvents: Record<string, true> = {
    alert_sent: true,
    alert_delivery: true,
    delivery: true,
  };
  return rows.reduce((total, row) => {
    if (!alertEvents[row.event_type ?? ""] || row.outcome === "failure") return total;
    return total + nonnegative(row.count);
  }, 0);
}

function deliveryCount(rows: DeliveryRow[], cutoffSec: number): number {
  return rows.filter((row) => nonnegative(row.final_delivery_at) >= cutoffSec).length;
}

function d1StatementCount(row: CronRunRow): number | null {
  const metadata = parseMetadata(row.metadata);
  const candidates = [
    row.d1_statements,
    metadata.d1Statements,
    metadata.d1StatementCount,
    metadata.fiveMinuteLaneD1Statements,
    metadata.statementCount,
    (metadata.d1 as Record<string, unknown> | undefined)?.statements,
  ];
  for (const candidate of candidates) {
    const value = numberValue(candidate);
    if (value != null) return Math.max(0, value);
  }
  return null;
}

function dispatchMetadata(row: CronRunRow): Record<string, unknown> {
  return parseMetadata(row.metadata);
}

function replaceGeneratedBlock(document: string, block: string): string {
  const start = document.indexOf(START_MARKER);
  const end = document.indexOf(END_MARKER);
  if (start < 0 || end < start) {
    throw new Error(`Missing ${GENERATED_KEY} generated markers in docs/telegram-alerts.md`);
  }
  const endAfterMarker = end + END_MARKER.length;
  return `${document.slice(0, start)}${block}${document.slice(endAfterMarker)}`;
}

export function collectTelegramAdoptionReport(client: D1Client, nowSec: number): TelegramAdoptionReport {
  const captureStartSec = nowSec - CAPTURE_DAYS * DAY_SEC;
  const activeWatcherStartSec = nowSec - ACTIVE_WATCHER_DAYS * DAY_SEC;
  const adoptionStartSec = nowSec - ADOPTION_DAYS * DAY_SEC;
  const subscriberRow = client.query<SubscriberCountRow>(
    `SELECT COUNT(*) AS subscriber_count,
            SUM(CASE WHEN last_active_at >= ${activeWatcherStartSec} THEN 1 ELSE 0 END) AS active_watchers_7d
       FROM telegram_subscribers`,
  )[0] ?? {};
  const lifecycleRows = client.query<LifecycleRow>(
    `SELECT day, active_watchers
       FROM telegram_watcher_lifecycle_daily
      WHERE day >= ${sqlString(utcDay(activeWatcherStartSec))}
      ORDER BY day ASC`,
  );
  const usageRows = client.query<UsageRow>(
    `SELECT day, event_type, outcome, count
       FROM telegram_usage_daily
      WHERE day >= ${sqlString(utcDay(adoptionStartSec))}
      ORDER BY day ASC`,
  );
  const deliveryRows = client.query<DeliveryRow>(
    `SELECT final_delivery_at
       FROM telegram_alert_job_targets
      WHERE final_delivery_state = 'accepted'
        AND final_delivery_at >= ${adoptionStartSec}`,
  );
  const cronRows = client.query<CronRunRow>(
    `SELECT job, started_at, slot_started_at, duration_ms, item_count, metadata
       FROM cron_runs
      WHERE (producer_path = 'fiveMinuteTelegramAlerts' OR job = 'dispatch-telegram-alerts')
        AND COALESCE(slot_started_at, started_at) >= ${captureStartSec}
      ORDER BY COALESCE(slot_started_at, started_at) ASC`,
  );

  const dispatchRows = cronRows.filter((row) => row.job === "dispatch-telegram-alerts");
  const planningMs = dispatchRows
    .map((row) => {
      const metadata = dispatchMetadata(row);
      return (numberValue(metadata.sourceEventsProcessed) ?? 0) > 0
        ? numberValue(metadata.planningMs)
        : null;
    })
    .filter((value): value is number => value != null && value >= 0);
  const planningStatements = dispatchRows.reduce(
    (total, row) => total + nonnegative(dispatchMetadata(row).planningStatements),
    0,
  );
  const noWorkRuns = dispatchRows.filter((row) => dispatchMetadata(row).noWorkRun === true).length;
  const laneD1Counts = cronRows
    .filter((row) => FIVE_MINUTE_LANE[row.job ?? ""] === true || row.job === "dispatch-telegram-alerts")
    .map(d1StatementCount)
    .filter((value): value is number => value != null);
  const fiveMinuteLaneD1Statements = laneD1Counts.length > 0
    ? laneD1Counts.reduce((total, value) => total + value, 0)
    : null;
  const p50 = percentile(planningMs, 0.5);
  const p95 = percentile(planningMs, 0.95);
  const planningStatementFraction = fiveMinuteLaneD1Statements && fiveMinuteLaneD1Statements > 0
    ? Math.min(1, planningStatements / fiveMinuteLaneD1Statements)
    : null;
  const lifecycleActive = latestLifecycleValue(lifecycleRows);
  const dailyActive = lifecycleActive ?? nonnegative(subscriberRow.active_watchers_7d);
  const usageAlerts = usageAlertsSent(usageRows);
  const alertsSent30d = deliveryRows.length > 0 ? deliveryRows.length : usageAlerts;
  const alertsSent7d = deliveryRows.length > 0
    ? deliveryCount(deliveryRows, activeWatcherStartSec)
    : usageAlertsSent(usageRows.filter((row) => row.day != null && row.day >= utcDay(activeWatcherStartSec)));

  return {
    generatedAt: new Date(nowSec * 1000).toISOString(),
    window: { startSec: captureStartSec, endSec: nowSec, captureDays: CAPTURE_DAYS },
    adoption: {
      subscriberCount: nonnegative(subscriberRow.subscriber_count),
      activeWatchers7d: lifecycleActive ?? nonnegative(subscriberRow.active_watchers_7d),
      dailyActive,
      alertsSent7d,
      alertsSent30d,
    },
    planning: {
      dispatchInvocations: dispatchRows.length,
      planningMs: { p50, p95 },
      noWorkRunShare: dispatchRows.length > 0 ? noWorkRuns / dispatchRows.length : null,
      planningStatements,
      fiveMinuteLaneD1Statements,
      planningStatementFraction,
    },
    decision: {
      proceed41: (planningStatementFraction != null && planningStatementFraction > 0.2)
        || (p95 != null && p95 > 10 * 60 * 1000),
    },
  };
}

function displayNumber(value: number | null): string {
  return value == null ? "not measured" : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function displayPercent(value: number | null): string {
  return value == null ? "not measured" : `${(value * 100).toFixed(1)}%`;
}

export function renderTelegramAdoptionBlock(report: TelegramAdoptionReport): string {
  const measured = report.planning.dispatchInvocations > 0;
  return [
    START_MARKER,
    "<!-- This block is generated by scripts/maintenance/report-telegram-adoption.ts from remote D1. -->",
    "<!-- Do not edit by hand. Run `node --import tsx scripts/maintenance/report-telegram-adoption.ts` after the capture window. -->",
    "### Telegram adoption and planning cost",
    `Status: **${measured ? "measured" : "not yet measured"}** (14-day five-minute dispatch capture; generated ${report.generatedAt}).`,
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Subscribers | ${displayNumber(report.adoption.subscriberCount)} |`,
    `| Active watchers (7d) | ${displayNumber(report.adoption.activeWatchers7d)} |`,
    `| Daily active watchers | ${displayNumber(report.adoption.dailyActive)} |`,
    `| Alerts sent (7d / 30d) | ${displayNumber(report.adoption.alertsSent7d)} / ${displayNumber(report.adoption.alertsSent30d)} |`,
    `| Dispatch invocations | ${displayNumber(report.planning.dispatchInvocations)} |`,
    `| Planning wall time (p50 / p95) | ${displayNumber(report.planning.planningMs.p50)} ms / ${displayNumber(report.planning.planningMs.p95)} ms |`,
    `| Zero-work dispatch share | ${displayPercent(report.planning.noWorkRunShare)} |`,
    `| Planning D1 statements | ${displayNumber(report.planning.planningStatements)} |`,
    `| Planning share of five-minute-lane D1 statements | ${displayPercent(report.planning.planningStatementFraction)} |`,
    "",
    `Decision ` + "`decision.proceed41`" + `: **${String(report.decision.proceed41)}** (proceed with 4.1 when planning share exceeds 20% or p95 exceeds 10 minutes).`,
    END_MARKER,
  ].join("\n");
}

export function updateTelegramAdoptionDocumentation(report: TelegramAdoptionReport): void {
  const document = readFileSync(DOC_PATH, "utf8");
  const block = renderTelegramAdoptionBlock(report);
  const updated = replaceGeneratedBlock(document, block);
  if (updated !== document) writeFileSync(DOC_PATH, updated);
}

export function main(): void {
  const client = createD1Client("stablecoin-db");
  const report = collectTelegramAdoptionReport(client, Math.floor(Date.now() / 1000));
  updateTelegramAdoptionDocumentation(report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
