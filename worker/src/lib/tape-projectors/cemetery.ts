/**
 * cemetery.entry.added projector.
 *
 * Source: `CEMETERY_ENTRIES` from `shared/lib/cemetery-merged.ts` (the canonical
 * merged accessor — combines `DEAD_STABLECOINS` with frozen stablecoins). Each
 * entry is keyed by canonical id; the projector emits exactly one event the
 * first time an id is seen and never re-emits.
 *
 * Timestamp comes from the entry's `deathDate`, which is "YYYY-MM-DD" or
 * "YYYY-MM" precision. When the day is missing we default to day 1 of the
 * month at 00:00:00 UTC.
 */
import { CEMETERY_ENTRIES, type CemeteryEntry } from "@shared/lib/cemetery-merged";

import { buildTapeEventId } from "../tape-event-helpers";
import { insertTapeEvents } from "../tape-event-store";
import type { TapeEventInsert } from "../tape-event-types";
import type { ProjectorOptions, ProjectorResult } from "./types";

function parseDeathDate(deathDate: string): number {
  const segments = deathDate.split("-");
  const year = Number(segments[0]);
  const month = Number(segments[1] ?? "1");
  const day = Number(segments[2] ?? "1");
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return Math.floor(Date.now() / 1000);
  }
  const utc = Date.UTC(year, Math.max(0, month - 1), Math.max(1, day));
  return Math.floor(utc / 1000);
}

async function loadObservedIds(db: D1Database): Promise<Set<string>> {
  const result = await db
    .prepare(`SELECT source_row_id FROM tape_events WHERE type = ?`)
    .bind("cemetery.entry.added")
    .all<{ source_row_id: string }>();
  const seen = new Set<string>();
  for (const row of result.results ?? []) seen.add(row.source_row_id);
  return seen;
}

function buildEvent(entry: CemeteryEntry): TapeEventInsert {
  const tsSec = parseDeathDate(entry.deathDate);
  const tsMs = tsSec * 1000;
  const transition = "opened";
  const type = "cemetery.entry.added";

  const peakLabel = entry.peakMcap != null && entry.peakMcap > 0
    ? formatUsdShort(entry.peakMcap)
    : null;
  const title = peakLabel
    ? `${entry.symbol} entered cemetery (peak ${peakLabel})`
    : `${entry.symbol} entered cemetery`;
  const summaryBase = entry.epitaph?.trim() || entry.causeOfDeath;
  const summary = summaryBase.length > 180 ? `${summaryBase.slice(0, 177)}…` : summaryBase;

  return {
    eventId: buildTapeEventId({
      tsMs,
      type,
      sourceTable: "cemetery",
      sourceRowId: entry.id,
      transition,
    }),
    type,
    severity: "notice",
    ts: tsMs,
    endsAt: null,
    coinId: entry.id,
    issuerId: null,
    pegCurrency: entry.pegCurrency,
    chain: null,
    title,
    summary,
    payload: {
      symbol: entry.symbol,
      name: entry.name,
      causeOfDeath: entry.causeOfDeath,
      deathDate: entry.deathDate,
      peakMcap: entry.peakMcap,
      sourceUrl: entry.sourceUrl,
      sourceLabel: entry.sourceLabel,
    },
    sourceTable: "cemetery",
    sourceRowId: entry.id,
    transition,
    sourceUrl: "/cemetery/",
    methodologyVersion: null,
  };
}

function formatUsdShort(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${Math.round(value / 1_000)}k`;
  return `$${Math.round(value)}`;
}

export async function projectCemeteryEntries(
  db: D1Database,
  options?: ProjectorOptions,
): Promise<ProjectorResult> {
  const dryRun = options?.dryRun === true;
  const observed = await loadObservedIds(db);
  const events: TapeEventInsert[] = [];
  for (const entry of CEMETERY_ENTRIES) {
    if (observed.has(entry.id)) continue;
    events.push(buildEvent(entry));
  }
  if (events.length === 0) return { projected: 0, advanced: null };
  if (!dryRun) await insertTapeEvents(db, events);
  return { projected: events.length, advanced: null };
}
