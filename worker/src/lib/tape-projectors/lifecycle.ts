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

import { buildTapeEventId, parseDateStringToEpochSec, truncateSummary } from "../tape-event-helpers";
import type { TapeEventInsert } from "../tape-event-types";
import { projectStaticCatalogEntries, type ProjectorOptions, type ProjectorResult } from "./types";

function buildEvent(coin: StablecoinMeta): TapeEventInsert {
  const tsSec = parseDateStringToEpochSec(coin.frozenAt);
  const tsMs = tsSec * 1000;
  const transition = "opened";
  const type = "lifecycle.tracked.frozen";
  const sourceRowId = coin.id;
  const epitaph = coin.obituary?.epitaph?.trim();
  const summary = epitaph && epitaph.length > 0
    ? truncateSummary(epitaph)
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
  return projectStaticCatalogEntries(db, {
    eventType: "lifecycle.tracked.frozen",
    entries: FROZEN_STABLECOINS,
    sourceRowId: (coin) => coin.id,
    buildEvent,
  }, options);
}
