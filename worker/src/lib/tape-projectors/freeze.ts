/**
 * freeze.* projectors. Source: `blacklist_events` (explicit transition table).
 *
 *   - freeze.blocked    : event_type = 'blacklist'
 *   - freeze.unblocked  : event_type = 'unblacklist'
 *   - freeze.destroyed  : event_type = 'destroy'
 */
import { formatCompactUsdShortLowerK } from "@shared/lib/format";
import {
  buildTapeEventId,
  severityForFreezeBlocked,
  severityForFreezeDestroyed,
} from "../tape-event-helpers";
import {
  insertTapeEvents,
  setProjectorWatermark,
} from "../tape-event-store";
import { getBlacklistConfigByKey } from "../blacklist-contracts";
import type { TapeEventInsert } from "../tape-event-types";
import {
  fetchRowsWithTieExpansion,
  resolveProjectorOptions,
  type ProjectorOptions,
  type ProjectorResult,
} from "./types";

interface BlacklistSourceRow {
  id: string;
  stablecoin: string;
  chain_id: string;
  chain_name: string;
  event_type: string;          // "blacklist" | "unblacklist" | "destroy"
  amount_usd_at_event: number | null;
  timestamp: number;           // epoch seconds
  methodology_version: string | null;
  config_key: string | null;
  rowid: number;
}

const BLACKLIST_VARIANTS = [
  { variant: "blocked",     eventType: "blacklist",   slug: "freeze.blocked",     transition: "opened"    },
  { variant: "unblocked",   eventType: "unblacklist", slug: "freeze.unblocked",   transition: "resolved"  },
  { variant: "destroyed",   eventType: "destroy",     slug: "freeze.destroyed",   transition: "opened"    },
] as const;

type BlacklistVariant = (typeof BLACKLIST_VARIANTS)[number];

async function projectFreezeVariant(
  db: D1Database,
  spec: BlacklistVariant,
  options: ProjectorOptions | undefined,
): Promise<ProjectorResult> {
  const cursorKey = spec.slug;
  const { since, until, limit, dryRun } = await resolveProjectorOptions(db, cursorKey, options);

  const rows = await fetchRowsWithTieExpansion<BlacklistSourceRow>(db, {
    selectSql: `SELECT id, stablecoin, chain_id, chain_name, event_type, amount_usd_at_event,
                      timestamp, methodology_version, config_key, rowid as rowid`,
    fromSql: "blacklist_events",
    timeColumn: "timestamp",
    trailingWhereSql: " AND event_type = ? AND suppression_reason IS NULL",
    trailingBinds: [spec.eventType],
    orderBySql: "timestamp ASC, rowid ASC",
    since,
    until,
    limit,
    getTime: (row) => row.timestamp,
  });
  if (rows.length === 0) return { projected: 0, advanced: null };

  const events: TapeEventInsert[] = [];
  let maxCursor = since;
  for (const row of rows) {
    const tsMs = row.timestamp * 1000;
    let severity: TapeEventInsert["severity"];
    if (spec.variant === "blocked") severity = severityForFreezeBlocked(row.amount_usd_at_event);
    else if (spec.variant === "destroyed") severity = severityForFreezeDestroyed(row.amount_usd_at_event);
    else severity = "info";

    const amountStr = row.amount_usd_at_event != null && row.amount_usd_at_event > 0
      ? formatCompactUsdShortLowerK(row.amount_usd_at_event)
      : null;
    let title: string;
    let summary: string;
    if (spec.variant === "destroyed") {
      title = amountStr
        ? `${row.stablecoin} ${amountStr} destroyed · ${row.chain_name}`
        : `${row.stablecoin} funds destroyed · ${row.chain_name}`;
      summary = amountStr
        ? `Issuer destroyed ${amountStr} of ${row.stablecoin} on ${row.chain_name}.`
        : `Issuer destroyed ${row.stablecoin} balance on ${row.chain_name}.`;
    } else if (spec.variant === "unblocked") {
      title = `${row.stablecoin} address unfrozen · ${row.chain_name}`;
      summary = `Issuer removed a ${row.stablecoin} address from the blacklist on ${row.chain_name}.`;
    } else {
      title = amountStr
        ? `${row.stablecoin} freeze ${amountStr} · ${row.chain_name}`
        : `${row.stablecoin} address frozen · ${row.chain_name}`;
      summary = amountStr
        ? `Issuer froze ${amountStr} of ${row.stablecoin} on ${row.chain_name}.`
        : `Issuer froze a ${row.stablecoin} address on ${row.chain_name}.`;
    }

    events.push({
      eventId: buildTapeEventId({
        tsMs,
        type: spec.slug,
        sourceTable: "blacklist_events",
        sourceRowId: row.id,
        transition: spec.transition,
      }),
      type: spec.slug,
      severity,
      ts: tsMs,
      endsAt: null,
      // New projections carry the canonical registry id from the verified
      // contract config. Historical rows lacking config_key retain their
      // original symbol-only projection and are intentionally not guessed.
      coinId: row.config_key ? getBlacklistConfigByKey(row.config_key)?.stablecoinId ?? null : null,
      issuerId: null,
      pegCurrency: null,
      chain: row.chain_name,
      title,
      summary,
      payload: {
        stablecoin: row.stablecoin,
        chainId: row.chain_id,
        chainName: row.chain_name,
        amountUsdAtEvent: row.amount_usd_at_event,
        sourceEventId: row.id,
        stablecoinId: row.config_key ? getBlacklistConfigByKey(row.config_key)?.stablecoinId ?? null : null,
      },
      sourceTable: "blacklist_events",
      sourceRowId: row.id,
      transition: spec.transition,
      sourceUrl: "/freezewatch/",
      methodologyVersion: row.methodology_version ?? null,
    });
    if (row.timestamp > maxCursor) maxCursor = row.timestamp;
  }

  if (!dryRun) {
    await insertTapeEvents(db, events);
    if (options?.since == null && options?.until == null) {
      await setProjectorWatermark(db, cursorKey, maxCursor);
    }
  }
  return { projected: events.length, advanced: dryRun ? null : maxCursor };
}

export function projectFreezeBlocked(db: D1Database, options?: ProjectorOptions): Promise<ProjectorResult> {
  return projectFreezeVariant(db, BLACKLIST_VARIANTS[0], options);
}

export function projectFreezeUnblocked(db: D1Database, options?: ProjectorOptions): Promise<ProjectorResult> {
  return projectFreezeVariant(db, BLACKLIST_VARIANTS[1], options);
}

export function projectFreezeDestroyed(db: D1Database, options?: ProjectorOptions): Promise<ProjectorResult> {
  return projectFreezeVariant(db, BLACKLIST_VARIANTS[2], options);
}
