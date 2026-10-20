#!/usr/bin/env node
/**
 * Reads Telegram adoption telemetry from remote D1, updates the generated
 * adoption block in docs/runbooks/telegram-adoption-report.md, and prints the report as JSON.
 *
 * Build-category tool: remote reads and local generated-document writes only;
 * it does not mutate production.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createD1Client, sqlString, type D1Client } from "../lib/remote-d1";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const DOC_PATH = resolve(ROOT, "docs/runbooks/telegram-adoption-report.md");
const GENERATED_KEY = "telegram-adoption";
const START_MARKER = `<!-- GENERATED-START: ${GENERATED_KEY} -->`;
const END_MARKER = `<!-- GENERATED-END: ${GENERATED_KEY} -->`;
const DAY_SEC = 24 * 60 * 60;
const ADOPTION_DAYS = 30;
const ACTIVE_WATCHER_DAYS = 7;

export interface TelegramAdoptionReport {
  generatedAt: string;
  adoption: {
    subscriberCount: number;
    activeWatchers7d: number;
    configuredWatchersDaily: number | null;
    configuredWatchersSnapshotAt: string | null;
    alertsSent7d: number | null;
    alertsSent7dUnavailableReason: "delivery-window-coverage-unproven" | null;
    alertsSent30d: number | null;
    alertsSent30dUnavailableReason: "source-retention-shorter-than-window" | null;
    retainedAlertsSent7d: number;
    retainedAlertsSent30d: number;
  };
}


type SubscriberCountRow = {
  subscriber_count?: number | string | null;
  active_watchers_7d?: number | string | null;
};

type LifecycleRow = {
  day?: string | null;
  snapshot_at?: number | string | null;
  active_watchers?: number | string | null;
};

type DeliveryRow = {
  final_delivery_at?: number | string | null;
};


function numberValue(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function nonnegative(value: unknown): number {
  return Math.max(0, numberValue(value) ?? 0);
}


function utcDay(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}


function latestLifecycleSnapshot(rows: LifecycleRow[]): { count: number; observedAt: string | null } | null {
  const snapshots = rows
    .filter((row) => typeof row.day === "string" && numberValue(row.active_watchers) != null)
    .sort((left, right) => String(left.day).localeCompare(String(right.day)));
  const latest = snapshots[snapshots.length - 1];
  if (!latest) return null;
  const snapshotAt = numberValue(latest.snapshot_at);
  return {
    count: Math.max(0, numberValue(latest.active_watchers)!),
    observedAt: snapshotAt != null && snapshotAt > 0 ? new Date(snapshotAt * 1000).toISOString() : null,
  };
}



function deliveryCount(rows: DeliveryRow[], cutoffSec: number, nowSec: number): number {
  return rows.filter((row) => {
    const deliveredAt = numberValue(row.final_delivery_at);
    return deliveredAt != null && deliveredAt >= cutoffSec && deliveredAt <= nowSec;
  }).length;
}



function replaceGeneratedBlock(document: string, block: string): string {
  const start = document.indexOf(START_MARKER);
  const end = document.indexOf(END_MARKER);
  if (start < 0 || end < start) {
    throw new Error(`Missing ${GENERATED_KEY} generated markers in docs/runbooks/telegram-adoption-report.md`);
  }
  const endAfterMarker = end + END_MARKER.length;
  return `${document.slice(0, start)}${block}${document.slice(endAfterMarker)}`;
}

export function collectTelegramAdoptionReport(client: D1Client, nowSec: number): TelegramAdoptionReport {
  const activeWatcherStartSec = nowSec - ACTIVE_WATCHER_DAYS * DAY_SEC;
  const adoptionStartSec = nowSec - ADOPTION_DAYS * DAY_SEC;
  const subscriberRow = client.query<SubscriberCountRow>(
    `SELECT COUNT(*) AS subscriber_count,
            SUM(CASE WHEN last_active_at >= ${activeWatcherStartSec} THEN 1 ELSE 0 END) AS active_watchers_7d
       FROM telegram_subscribers`,
  )[0] ?? {};
  const lifecycleRows = client.query<LifecycleRow>(
    `SELECT day, snapshot_at, active_watchers
       FROM telegram_watcher_lifecycle_daily
      WHERE day >= ${sqlString(utcDay(activeWatcherStartSec))}
      ORDER BY day ASC`,
  );
  const deliveryRows = client.query<DeliveryRow>(
    `SELECT final_delivery_at
       FROM telegram_alert_job_targets
      WHERE final_delivery_state = 'accepted'
        AND final_delivery_at >= ${adoptionStartSec}
        AND final_delivery_at <= ${nowSec}`,
  );

  const lifecycleSnapshot = latestLifecycleSnapshot(lifecycleRows);

  return {
    generatedAt: new Date(nowSec * 1000).toISOString(),
    adoption: {
      subscriberCount: nonnegative(subscriberRow.subscriber_count),
      activeWatchers7d: nonnegative(subscriberRow.active_watchers_7d),
      configuredWatchersDaily: lifecycleSnapshot?.count ?? null,
      configuredWatchersSnapshotAt: lifecycleSnapshot?.observedAt ?? null,
      // Replay pruning uses source.completed_at; audit pruning uses target.created_at.
      // Neither proves coverage of a final_delivery_at window, even for an empty read.
      alertsSent7d: null,
      alertsSent7dUnavailableReason: "delivery-window-coverage-unproven",
      alertsSent30d: null,
      alertsSent30dUnavailableReason: "source-retention-shorter-than-window",
      retainedAlertsSent7d: deliveryCount(deliveryRows, activeWatcherStartSec, nowSec),
      retainedAlertsSent30d: deliveryCount(deliveryRows, adoptionStartSec, nowSec),
    },
  };
}

function displayNumber(value: number | null): string {
  return value == null ? "not measured" : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}


export function renderTelegramAdoptionBlock(report: TelegramAdoptionReport): string {
  return [
    START_MARKER,
    "<!-- This block in docs/runbooks/telegram-adoption-report.md is generated by scripts/maintenance/report-telegram-adoption.ts from remote D1. -->",
    "<!-- Do not edit by hand. Run `node --import tsx scripts/maintenance/report-telegram-adoption.ts` to refresh. -->",
    "### Telegram adoption",
    `Observed ${report.generatedAt}; unavailable values are shown as not measured.`,
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Subscribers | ${displayNumber(report.adoption.subscriberCount)} |`,
    `| Active watchers (7d) | ${displayNumber(report.adoption.activeWatchers7d)} |`,
    `| Configured watchers (daily snapshot) | ${displayNumber(report.adoption.configuredWatchersDaily)} |`,
    `| Configured watchers snapshot observed at | ${report.adoption.configuredWatchersSnapshotAt ?? "not measured"} |`,
    `| Alerts sent (7d / 30d) | ${displayNumber(report.adoption.alertsSent7d)} / ${displayNumber(report.adoption.alertsSent30d)} |`,
    `| Alerts sent (7d) unavailable reason | ${report.adoption.alertsSent7dUnavailableReason ?? "none"} |`,
    `| Alerts sent (30d) unavailable reason | ${report.adoption.alertsSent30dUnavailableReason ?? "none"} |`,
    `| Retained accepted targets only (7d / 30d; not complete delivery totals) | ${displayNumber(report.adoption.retainedAlertsSent7d)} / ${displayNumber(report.adoption.retainedAlertsSent30d)} |`,
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
