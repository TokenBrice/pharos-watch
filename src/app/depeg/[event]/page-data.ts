import type { DepegEvent } from "@shared/types/market";
import depegEvents from "@data/depeg-events.json";

/**
 * Event payload as written by scripts/maintenance/sync-depeg-events.ts.
 * Slug is the URN id (`<symbol-lowercase>-<YYYY-MM-DD>` with optional `-up`/`-down`).
 */
export interface DepegEventEntry extends DepegEvent {
  slug: string;
}

export const DEPEG_EVENT_ENTRIES = depegEvents as readonly DepegEventEntry[];

export const eventBySlug: ReadonlyMap<string, DepegEventEntry> = new Map(
  DEPEG_EVENT_ENTRIES.map((event) => [event.slug, event] as const),
);
