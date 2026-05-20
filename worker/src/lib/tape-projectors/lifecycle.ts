/**
 * lifecycle.tracked.frozen projector.
 *
 * Source: `FROZEN_STABLECOINS` from `shared/lib/stablecoins` (the canonical
 * accessor consumed by `cemetery-merged.ts`). Each frozen entry exposes a
 * `frozenAt` date ("YYYY-MM-DD"); we emit one event per id on first
 * observation.
 */
import { FROZEN_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { StablecoinMeta } from "@shared/types";

import { buildTapeEventId } from "../tape-event-helpers";
import { insertTapeEvents } from "../tape-event-store";
import type { TapeEventInsert } from "../tape-event-types";
import type { ProjectorOptions, ProjectorResult } from "./types";

function parseFrozenAt(value: string | undefined): number {
  if (!value) return Math.floor(Date.now() / 1000);
  const segments = value.split("-");
  const year = Number(segments[0]);
  const month = Number(segments[1] ?? "1");
  const day = Number(segments[2] ?? "1");
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return Math.floor(Date.now() / 1000);
  }
  return Math.floor(Date.UTC(year, Math.max(0, month - 1), Math.max(1, day)) / 1000);
}

async function loadObservedIds(db: D1Database): Promise<Set<string>> {
  const result = await db
    .prepare(`SELECT source_row_id FROM tape_events WHERE type = ?`)
    .bind("lifecycle.tracked.frozen")
    .all<{ source_row_id: string }>();
  const seen = new Set<string>();
  for (const row of result.results ?? []) seen.add(row.source_row_id);
  return seen;
}

function buildEvent(coin: StablecoinMeta): TapeEventInsert {
  const tsSec = parseFrozenAt(coin.frozenAt);
  const tsMs = tsSec * 1000;
  const transition = "opened";
  const type = "lifecycle.tracked.frozen";
  const sourceRowId = coin.id;
  const epitaph = coin.obituary?.epitaph?.trim();
  const summary = epitaph && epitaph.length > 0
    ? (epitaph.length > 180 ? `${epitaph.slice(0, 177)}…` : epitaph)
    : `${coin.symbol} entered the frozen archive lifecycle phase.`;

  return {
    eventId: buildTapeEventId({
      tsMs,
      type,
      sourceTable: "stablecoins:frozen",
      sourceRowId,
      transition,
    }),
    type,
    severity: "notice",
    ts: tsMs,
    endsAt: null,
    coinId: coin.id,
    issuerId: null,
    pegCurrency: coin.flags.pegCurrency,
    chain: null,
    title: `${coin.symbol} frozen`,
    summary,
    payload: {
      symbol: coin.symbol,
      name: coin.name,
      frozenAt: coin.frozenAt ?? null,
      causeOfDeath: coin.obituary?.causeOfDeath ?? null,
      sourceUrl: coin.obituary?.sourceUrl ?? null,
      sourceLabel: coin.obituary?.sourceLabel ?? null,
    },
    sourceTable: "stablecoins:frozen",
    sourceRowId,
    transition,
    sourceUrl: `/stablecoin/${encodeURIComponent(coin.id)}/`,
    methodologyVersion: null,
  };
}

export async function projectLifecycleFrozen(
  db: D1Database,
  options?: ProjectorOptions,
): Promise<ProjectorResult> {
  const dryRun = options?.dryRun === true;
  const observed = await loadObservedIds(db);
  const events: TapeEventInsert[] = [];
  for (const coin of FROZEN_STABLECOINS) {
    if (observed.has(coin.id)) continue;
    events.push(buildEvent(coin));
  }
  if (events.length === 0) return { projected: 0, advanced: null };
  if (!dryRun) await insertTapeEvents(db, events);
  return { projected: events.length, advanced: null };
}
