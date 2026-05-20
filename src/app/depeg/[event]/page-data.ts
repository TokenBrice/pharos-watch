import type { DepegEvent } from "@shared/types/market";
import depegEvents from "../../../../data/depeg-events.json";
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

const ALL_ENTRIES = depegEvents as readonly DepegEventEntry[];

export const DEPEG_EVENT_ENTRIES: readonly DepegEventEntry[] = ALL_ENTRIES.filter(hasDedicatedDepegEventPage);

export const INDEXABLE_DEPEG_EVENT_ENTRIES: readonly DepegEventEntry[] =
  selectIndexableDepegEvents(DEPEG_EVENT_ENTRIES);

export const INDEXABLE_DEPEG_EVENT_SLUGS: ReadonlySet<string> = new Set(
  INDEXABLE_DEPEG_EVENT_ENTRIES.map((event) => event.slug),
);

export const eventBySlug: ReadonlyMap<string, DepegEventEntry> = new Map(
  DEPEG_EVENT_ENTRIES.map((event) => [event.slug, event] as const),
);
