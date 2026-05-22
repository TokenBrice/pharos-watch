import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DepegEvent } from "@shared/types/market";
import {
  MIN_DEPEG_PAGE_DEVIATION_BPS,
  hasDedicatedDepegEventPage,
  selectIndexableDepegEvents,
} from "./config";

/**
 * Event payload as written by scripts/maintenance/sync-depeg-events.ts.
 * Slug is the URN id (`<symbol-lowercase>-<YYYY-MM-DD>` with optional `-up`/`-down`).
 */
export interface DepegEventEntry extends DepegEvent {
  slug: string;
}

export { MIN_DEPEG_PAGE_DEVIATION_BPS };

function readDepegEventEntries(): readonly DepegEventEntry[] {
  const filePath = join(process.cwd(), "data/depeg-events.json");
  return JSON.parse(readFileSync(filePath, "utf8")) as DepegEventEntry[];
}

const ALL_ENTRIES = readDepegEventEntries();

export const DEPEG_EVENT_ENTRIES: readonly DepegEventEntry[] = ALL_ENTRIES.filter(hasDedicatedDepegEventPage);

export const INDEXABLE_DEPEG_EVENT_ENTRIES: readonly DepegEventEntry[] =
  selectIndexableDepegEvents(DEPEG_EVENT_ENTRIES);

export const INDEXABLE_DEPEG_EVENT_SLUGS: ReadonlySet<string> = new Set(
  INDEXABLE_DEPEG_EVENT_ENTRIES.map((event) => event.slug),
);

export const eventBySlug: ReadonlyMap<string, DepegEventEntry> = new Map(
  DEPEG_EVENT_ENTRIES.map((event) => [event.slug, event] as const),
);

/**
 * Incident numbers for confirmed event pages.
 *
 * Assigned in chronological order — the oldest confirmed event is Incident #1,
 * counting forward. Numbers are stable across rebuilds as long as a slug stays
 * confirmed; if an event is rejected later, numbers downstream shift by one,
 * which is acceptable because rejected events lose their permanent URL too.
 *
 * The chronological direction (ascending, not the sync-script's descending
 * order) is the canonical convention for serial publication numbering.
 */
export const INCIDENT_NUMBER_BY_SLUG: ReadonlyMap<string, number> = (() => {
  const ascending = [...DEPEG_EVENT_ENTRIES].sort((a, b) => {
    if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt;
    return a.slug.localeCompare(b.slug);
  });
  return new Map(ascending.map((event, index) => [event.slug, index + 1] as const));
})();

export function formatIncidentNumber(slug: string): string | null {
  const number = INCIDENT_NUMBER_BY_SLUG.get(slug);
  if (number == null) return null;
  return String(number).padStart(3, "0");
}
