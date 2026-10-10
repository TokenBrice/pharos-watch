/**
 * freeze.* projectors. Source: `blacklist_events` (explicit transition table).
 *
 *   - freeze.blocked    : event_type = 'blacklist'
 *   - freeze.unblocked  : event_type = 'unblacklist'
 *   - freeze.destroyed  : event_type = 'destroy'
 */
import { formatCompactUsdShortLowerK } from "@shared/lib/format";
import { resolveChainId } from "@shared/types/chain-identity";
import {
  buildTapeEventId,
  severityForFreezeBlocked,
  severityForFreezeDestroyed,
} from "../tape-event-helpers";
import { CONTRACT_CONFIGS, getBlacklistConfigByKey } from "../blacklist-contracts";
import { deleteCache, getCache, setCache } from "../db-cache";
import { batchExecute, buildInClause, D1_SAFE_IN_CLAUSE_BIND_LIMIT } from "../d1-primitives";
import { parseJsonObject } from "../json-parse";
import { logWorkerEvent } from "../structured-log";
import type { BlacklistPersistedRow } from "../blacklist/shared";
import type { TapeEventInsert } from "../tape-event-types";
import {
  DEFAULT_BATCH_LIMIT,
  finalizeProjectorBatch,
  fetchRowsWithTieExpansion,
  resolveProjectorOptions,
  sourceReconciliationSince,
  type ProjectorOptions,
  type ProjectorResult,
} from "./types";

type BlacklistSourceRow = Pick<BlacklistPersistedRow,
  | "id"
  | "stablecoin"
  | "chain_id"
  | "chain_name"
  | "event_type"
  | "amount_usd_at_event"
  | "timestamp"
  | "config_key"
> & {
  methodology_version: string | null;
  rowid: number;
};

const BLACKLIST_VARIANTS = [
  { variant: "blocked",     eventType: "blacklist",   slug: "freeze.blocked",     transition: "opened"    },
  { variant: "unblocked",   eventType: "unblacklist", slug: "freeze.unblocked",   transition: "resolved"  },
  { variant: "destroyed",   eventType: "destroy",     slug: "freeze.destroyed",   transition: "opened"    },
] as const;

type BlacklistVariant = (typeof BLACKLIST_VARIANTS)[number];

// 0266 lowercases these registry display names. Derive the compatibility
// mapping from the same contract/CHAIN_META authority as the old writer,
// rather than maintaining a second chain-name list.
const LEGACY_FREEZE_CHAINS: Record<string, string> = Object.fromEntries(CONTRACT_CONFIGS
  .filter(({ chain }) => chain.chainName !== chain.chainId && chain.chainName.toLowerCase() === chain.chainId)
  .map(({ chain }) => [chain.chainName, chain.chainId]));

interface FreezeChainRepairRow {
  id: number;
  ts: number;
  chain: string | null;
  source_table: string;
}

async function repairFreezeChains(db: D1Database, type: BlacklistVariant["slug"]): Promise<void> {
  const key = `tape-projector:freeze-chain-repair:${type}`;
  const cached = await getCache(db, key);
  const cursor = parseJsonObject(cached?.value, "freeze chain repair cursor");
  const hasCursor = cursor != null && Number.isSafeInteger(cursor.ts) && Number.isSafeInteger(cursor.id);
  // Bound reads, not just writes: filtering legacy names before LIMIT would
  // repeatedly scan the entire clean archive. Cycle over the type/time index
  // so old-writer inserts behind this cursor are revisited after the wrap.
  const rows = (await db.prepare(
    `SELECT id, ts, chain, source_table FROM tape_events INDEXED BY idx_tape_type_ts
     WHERE type = ?${hasCursor ? " AND (ts, id) < (?, ?)" : ""}
     ORDER BY ts DESC, id DESC LIMIT ?`,
  ).bind(type, ...(hasCursor ? [cursor.ts, cursor.id] : []), DEFAULT_BATCH_LIMIT)
    .all<FreezeChainRepairRow>()).results ?? [];
  const idsByChain = new Map<string, number[]>();
  for (const row of rows) {
    if (row.source_table !== "blacklist_events" || row.chain == null ||
      !Object.prototype.hasOwnProperty.call(LEGACY_FREEZE_CHAINS, row.chain)) continue;
    const ids = idsByChain.get(row.chain) ?? [];
    ids.push(row.id);
    idsByChain.set(row.chain, ids);
  }
  const statements: D1PreparedStatement[] = [];
  for (const [name, ids] of idsByChain) {
    for (let i = 0; i < ids.length; i += D1_SAFE_IN_CLAUSE_BIND_LIMIT) {
      const clause = buildInClause(ids.slice(i, i + D1_SAFE_IN_CLAUSE_BIND_LIMIT));
      // Only chain changes: never replace the identity/payload or bump the
      // insertion-id Telegram cursor. Guard against already repaired rows.
      statements.push(db.prepare(
        `UPDATE tape_events SET chain = ?
         WHERE id IN (${clause.sql}) AND chain = ?
           AND source_table = 'blacklist_events' AND type = ?`,
      ).bind(LEGACY_FREEZE_CHAINS[name], ...clause.binds, name, type));
    }
  }
  const repaired = await batchExecute(db, statements);
  const last = rows[rows.length - 1];
  const continuing = rows.length === DEFAULT_BATCH_LIMIT && last != null;
  // Save progress only after successful updates. A failed write replays the
  // same idempotent page, while reaching the end starts the next sweep.
  if (continuing) await setCache(db, key, JSON.stringify({ ts: last.ts, id: last.id }));
  else if (cached) await deleteCache(db, key);
  logWorkerEvent({
    scope: "lib",
    level: "info",
    event: "freeze-chain-repair",
    job: "project-tape",
    message: "Reconciled freeze Tape chain identities",
    metadata: { type, scanned: rows.length, repaired, continuing },
  });
}

async function projectFreezeVariant(
  db: D1Database,
  spec: BlacklistVariant,
  options: ProjectorOptions | undefined,
): Promise<ProjectorResult> {
  const cursorKey = spec.slug;
  const { since, until, limit } = await resolveProjectorOptions(db, cursorKey, options);
  // Run even when every source identity was already projected, and outside
  // source-time bounds: migration overlap/rollback rows can be any age.
  if (options?.dryRun !== true) {
    try {
      await repairFreezeChains(db, spec.slug);
    } catch (error) {
      // Compatibility maintenance must not block fresh freeze projections.
      // Failed pages retain their cursor and are retried on a later run.
      logWorkerEvent({
        scope: "lib",
        level: "error",
        event: "freeze-chain-repair-failed",
        job: "project-tape",
        message: "Freeze Tape chain repair failed; continuing source projection",
        error,
        metadata: { type: spec.slug, reason: "freeze-chain-repair-failed" },
      });
    }
  }

  const rows = await fetchRowsWithTieExpansion<BlacklistSourceRow>(db, {
    selectSql: `SELECT id, stablecoin, chain_id, chain_name, event_type, amount_usd_at_event,
                      timestamp, methodology_version, config_key, rowid as rowid`,
    fromSql: "blacklist_events INDEXED BY idx_blacklist_events_public_event_page",
    timeColumn: "timestamp",
    // Reconcile delayed identities in a bounded event-time window; explicit
    // admin bounds can recover historical rows outside the scheduled window.
    trailingWhereSql: ` AND event_type = ? AND suppression_reason IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM tape_events INDEXED BY idx_tape_source_key
        WHERE source_table = 'blacklist_events'
          AND source_row_id = blacklist_events.id AND transition = ?
      )`,
    trailingBinds: [spec.eventType, spec.transition],
    orderBySql: "timestamp ASC, rowid ASC",
    since: sourceReconciliationSince(options),
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
      chain: resolveChainId(row.chain_id) ?? resolveChainId(row.chain_name),
      title,
      summary,
      payload: {
        stablecoin: row.stablecoin,
        chainId: row.chain_id,
        chainName: row.chain_name,
        amountUsdAtEvent: row.amount_usd_at_event,
        ...(row.amount_usd_at_event == null && spec.variant === "blocked" ? { amountUnknown: true } : {}),
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

  return finalizeProjectorBatch(db, { events, maxCursor, cursorKey, options });
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
