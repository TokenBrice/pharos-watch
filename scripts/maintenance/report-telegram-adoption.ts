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
const CAPTURE_EDGE_GRACE_SEC = 10 * 60;
const PLANNING_WRITE_SHARE_THRESHOLD = 0.2;
const PLANNING_LATENCY_THRESHOLD_MS = 10 * 60 * 1000;
const FIVE_MINUTE_LANE: Record<string, true> = {
  "dispatch-telegram-alerts": true,
  "telegram-personalized-recap-planner": true,
  "telegram-degradation-watchdog": true,
  "telegram-disambiguation-cleanup": true,
  "telegram-pulse-snapshot": true,
};

type DecisionState = "measured" | "undecided";

type UndecidedReason =
  | "capture-window-incomplete"
  | "write-share-numerator-missing"
  | "write-share-denominator-missing"
  | "no-real-source-events"
  | "no-valid-real-event-samples"
  | "write-share-denominator-invalid";

export interface TelegramAdoptionReport {
  generatedAt: string;
  window: {
    startSec: number;
    endSec: number;
    captureDays: number;
    coverageStartSec: number | null;
    coverageEndSec: number | null;
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
    noWorkRunShare: number | null;
    planningRowsWritten: number | null;
    fiveMinuteLaneD1Writes: number | null;
    planningWriteShare: number | null;
    realSourceEvents: number;
    enqueuedSourceEvents: number;
    planningToFirstEnqueueMs: { p50: number | null; p95: number | null };
  };
  decision: {
    state: DecisionState;
    reason: UndecidedReason | null;
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
};

type SourceEventLatencyRow = {
  source_event_id?: string | null;
  detected_at?: number | string | null;
  first_enqueued_at?: number | string | null;
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
  const sourceEventLatencyRows = client.query<SourceEventLatencyRow>(
    `SELECT event.source_event_id AS source_event_id,
            event.detected_at AS detected_at,
            MIN(target.enqueued_at) AS first_enqueued_at
       FROM telegram_alert_source_events event
       LEFT JOIN telegram_alert_job_targets target
         ON target.source_event_id = event.source_event_id
        AND target.enqueued_at IS NOT NULL
      WHERE event.detected_at >= ${captureStartSec}
      GROUP BY event.source_event_id, event.detected_at
      ORDER BY event.detected_at ASC`,
  );

  const dispatchRows = cronRows.filter((row) => row.job === "dispatch-telegram-alerts");
  const laneRows = cronRows.filter(
    (row) => FIVE_MINUTE_LANE[row.job ?? ""] === true || row.job === "dispatch-telegram-alerts",
  );
  const laneStarts = laneRows
    .map((row) => numberValue(row.slot_started_at ?? row.started_at))
    .filter((value): value is number => value != null);
  const dispatchStarts = dispatchRows
    .map((row) => numberValue(row.slot_started_at ?? row.started_at))
    .filter((value): value is number => value != null);
  const coverageStartSec = laneStarts.length > 0 ? Math.min(...laneStarts) : null;
  const coverageEndSec = laneStarts.length > 0 ? Math.max(...laneStarts) : null;
  const dispatchCoverageStartSec = dispatchStarts.length > 0 ? Math.min(...dispatchStarts) : null;
  const dispatchCoverageEndSec = dispatchStarts.length > 0 ? Math.max(...dispatchStarts) : null;
  const captureComplete = coverageStartSec != null
    && coverageEndSec != null
    && dispatchCoverageStartSec != null
    && dispatchCoverageEndSec != null
    && coverageStartSec <= captureStartSec + CAPTURE_EDGE_GRACE_SEC
    && coverageEndSec >= nowSec - CAPTURE_EDGE_GRACE_SEC
    && dispatchCoverageStartSec <= captureStartSec + CAPTURE_EDGE_GRACE_SEC
    && dispatchCoverageEndSec >= nowSec - CAPTURE_EDGE_GRACE_SEC;

  const planningWriteValues = dispatchRows.map((row) => numberValue(dispatchMetadata(row).planningRowsWritten));
  const planningWritesComplete = dispatchRows.length > 0
    && planningWriteValues.every((value): value is number => value != null && value >= 0);
  const planningRowsWritten = planningWritesComplete
    ? planningWriteValues.reduce((total, value) => total + value, 0)
    : null;

  const laneWriteValues = laneRows.map((row) => numberValue(dispatchMetadata(row).d1RowsWritten));
  const laneWritesComplete = laneRows.length > 0
    && laneWriteValues.every((value): value is number => value != null && value >= 0);
  const fiveMinuteLaneD1Writes = laneWritesComplete
    ? laneWriteValues.reduce((total, value) => total + value, 0)
    : null;
  const planningWriteShare = planningRowsWritten != null && fiveMinuteLaneD1Writes != null
    && fiveMinuteLaneD1Writes > 0
    ? Math.min(1, planningRowsWritten / fiveMinuteLaneD1Writes)
    : null;
  const writeShareDenominatorValid = laneWritesComplete
    && fiveMinuteLaneD1Writes != null
    && fiveMinuteLaneD1Writes > 0
    && planningWritesComplete
    && planningRowsWritten != null
    && planningRowsWritten <= fiveMinuteLaneD1Writes;

  const noWorkRuns = dispatchRows.filter((row) => dispatchMetadata(row).noWorkRun === true).length;
  const enqueueLatenciesMs = sourceEventLatencyRows
    .map((row) => {
      const detectedAt = numberValue(row.detected_at);
      const firstEnqueuedAt = numberValue(row.first_enqueued_at);
      return detectedAt != null && firstEnqueuedAt != null && firstEnqueuedAt >= detectedAt
        ? (firstEnqueuedAt - detectedAt) * 1000
        : null;
    })
    .filter((value): value is number => value != null);
  const enqueuedSourceEvents = enqueueLatenciesMs.length;
  const planningToFirstEnqueueMs = {
    p50: percentile(enqueueLatenciesMs, 0.5),
    p95: percentile(enqueueLatenciesMs, 0.95),
  };
  const reason: UndecidedReason | null = !captureComplete
    ? "capture-window-incomplete"
    : !planningWritesComplete
      ? "write-share-numerator-missing"
      : !laneWritesComplete
        ? "write-share-denominator-missing"
        : !writeShareDenominatorValid
          ? "write-share-denominator-invalid"
          : sourceEventLatencyRows.length === 0
            ? "no-real-source-events"
            : enqueuedSourceEvents === 0
              ? "no-valid-real-event-samples"
              : null;

  const lifecycleActive = latestLifecycleValue(lifecycleRows);
  const dailyActive = lifecycleActive ?? nonnegative(subscriberRow.active_watchers_7d);
  const usageAlerts = usageAlertsSent(usageRows);
  const alertsSent30d = deliveryRows.length > 0 ? deliveryRows.length : usageAlerts;
  const alertsSent7d = deliveryRows.length > 0
    ? deliveryCount(deliveryRows, activeWatcherStartSec)
    : usageAlertsSent(usageRows.filter((row) => row.day != null && row.day >= utcDay(activeWatcherStartSec)));
  const proceed41 = reason == null
    && (
      (planningWriteShare != null && planningWriteShare > PLANNING_WRITE_SHARE_THRESHOLD)
      || (planningToFirstEnqueueMs.p95 != null && planningToFirstEnqueueMs.p95 > PLANNING_LATENCY_THRESHOLD_MS)
    );

  return {
    generatedAt: new Date(nowSec * 1000).toISOString(),
    window: {
      startSec: captureStartSec,
      endSec: nowSec,
      captureDays: CAPTURE_DAYS,
      coverageStartSec,
      coverageEndSec,
    },
    adoption: {
      subscriberCount: nonnegative(subscriberRow.subscriber_count),
      activeWatchers7d: lifecycleActive ?? nonnegative(subscriberRow.active_watchers_7d),
      dailyActive,
      alertsSent7d,
      alertsSent30d,
    },
    planning: {
      dispatchInvocations: dispatchRows.length,
      noWorkRunShare: dispatchRows.length > 0 ? noWorkRuns / dispatchRows.length : null,
      planningRowsWritten,
      fiveMinuteLaneD1Writes,
      planningWriteShare,
      realSourceEvents: sourceEventLatencyRows.length,
      enqueuedSourceEvents,
      planningToFirstEnqueueMs,
    },
    decision: {
      state: reason == null ? "measured" : "undecided",
      reason,
      proceed41,
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
  const status = report.decision.state === "measured"
    ? "measured"
    : `undecided (${report.decision.reason ?? "incomplete"})`;
  const decisionDetail = report.decision.state === "measured"
    ? "measured against the owner thresholds: planning share > 20% of five-minute-lane D1 writes or p95 planning→first-enqueue latency > 10 minutes; 4.2/4.3 remain undecided pending separate table-value evidence"
    : `undecided: ${report.decision.reason ?? "incomplete capture"}; no 4.1 decision until the evidence is complete; 4.2/4.3 remain undecided pending separate table-value evidence`;
  return [
    START_MARKER,
    "<!-- This block is generated by scripts/maintenance/report-telegram-adoption.ts from remote D1. -->",
    "<!-- Do not edit by hand. Run `node --import tsx scripts/maintenance/report-telegram-adoption.ts` after the capture window. -->",
    "### Telegram adoption and planning cost",
    `Status: **${status}** (14-day five-minute dispatch capture; generated ${report.generatedAt}).`,
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Subscribers | ${displayNumber(report.adoption.subscriberCount)} |`,
    `| Active watchers (7d) | ${displayNumber(report.adoption.activeWatchers7d)} |`,
    `| Daily active watchers | ${displayNumber(report.adoption.dailyActive)} |`,
    `| Alerts sent (7d / 30d) | ${displayNumber(report.adoption.alertsSent7d)} / ${displayNumber(report.adoption.alertsSent30d)} |`,
    `| Dispatch invocations | ${displayNumber(report.planning.dispatchInvocations)} |`,
    `| Zero-work dispatch share | ${displayPercent(report.planning.noWorkRunShare)} |`,
    `| Planning pipeline D1 rows written | ${displayNumber(report.planning.planningRowsWritten)} |`,
    `| Five-minute-lane D1 rows written | ${displayNumber(report.planning.fiveMinuteLaneD1Writes)} |`,
    `| Planning share of five-minute-lane D1 writes | ${displayPercent(report.planning.planningWriteShare)} |`,
    `| Real source events (enqueued) | ${displayNumber(report.planning.realSourceEvents)} / ${displayNumber(report.planning.enqueuedSourceEvents)} |`,
    `| Planning→first-enqueue latency (p50 / p95) | ${displayNumber(report.planning.planningToFirstEnqueueMs.p50)} ms / ${displayNumber(report.planning.planningToFirstEnqueueMs.p95)} ms |`,
    "",
    `Decision ` + "`decision.proceed41`" + `: **${String(report.decision.proceed41)}** (${decisionDetail}).`,
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
