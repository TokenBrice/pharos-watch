/**
 * mint_burn.large_mint / mint_burn.large_burn projector.
 *
 * Source: `mint_burn_events` — each row is a discrete on-chain mint or burn
 * transaction (transition-shaped, like depeg/freeze sources). The projector
 * filters down to economically meaningful single-transaction flows
 * (`amount_usd` above a notice threshold and not a bridge transfer), then
 * emits one timeline event per qualifying row.
 *
 * The market-level Bank Run Gauge and FTQ classifiers compute at request
 * time (`worker/src/api/mint-burn-flows.ts`) and have no persistent history
 * table today, so gauge-band-changed events are left for a follow-up.
 */
import { ACTIVE_IDS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { getMethodologyVersionAt } from "@shared/lib/methodology-versions/registry";
import { formatCompactUsd } from "@shared/lib/format";
import { FLOW_CLAIM_RETRACTED_REASON } from "@shared/types/tape-event-constants";
import type { TapeEventSeverity } from "@shared/types/tape-event";

import { batchExecute } from "../d1-primitives";
import { MINT_BURN_CONFIGS } from "../mint-burn-contracts";
import { readMintBurnWindowContext } from "../mint-burn-flows-service";
import { MINT_BURN_TAPE_NOTICE_USD as NOTICE_USD, mintBurnTapeClaimStaleSql, mintBurnTapeEligibleSql } from "../mint-burn-tape-claim";
import { buildTapeEventId, deriveIssuerId } from "../tape-event-helpers";
import type { TapeEventInsert } from "../tape-event-types";
import {
  finalizeProjectorBatch,
  fetchRowsWithTieExpansion,
  resolveProjectorOptions,
  sourceReconciliationSince,
  type ProjectorOptions,
  type ProjectorResult,
} from "./types";

const CURSOR_KEY = "mint_burn.large_flow";

// Notice threshold; tuned to emit at most a handful of events per day across
// tracked coins. ~$10M single-transaction flows are already newsworthy in
// the stablecoin context — daily aggregate flows are much larger but a
// single tx of this size signals a counterparty event worth surfacing.
const WARNING_USD = 25_000_000;
const SEVERE_USD = 100_000_000;

function severityForFlow(amountUsd: number): TapeEventSeverity {
  if (amountUsd >= SEVERE_USD) return "severe";
  if (amountUsd >= WARNING_USD) return "warning";
  return "notice";
}

interface MintBurnSourceRow {
  id: string;
  stablecoin_id: string;
  symbol: string;
  chain_id: string;
  direction: string;
  amount_usd: number | null;
  counterparty: string | null;
  timestamp: number;
  flow_type: string | null;
  burn_type: string | null;
}

async function fetchLargeFlows(
  db: D1Database,
  since: number,
  until: number | null,
  limit: number,
  scopedPairsJson: string,
  admissionFloorsJson: string,
): Promise<MintBurnSourceRow[]> {
  // Bridge transfers and reviewed protocol-internal movements are not
  // economic mint/burn — exclude them. `review_required` burns are still
  // being classified; emit only confirmed burn types so the tape doesn't
  // surface ambiguous rows.
  return fetchRowsWithTieExpansion<MintBurnSourceRow>(db, {
    selectSql: `SELECT id, stablecoin_id, symbol, chain_id, direction, amount_usd,
                      counterparty, timestamp, flow_type, burn_type`,
    fromSql: "mint_burn_events INDEXED BY idx_mbe2_ts",
    timeColumn: "timestamp",
    trailingWhereSql: `
                   AND amount_usd IS NOT NULL
                   AND amount_usd >= ?
                   AND (stablecoin_id, chain_id) IN (
                     SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM json_each(?)
                     WHERE mint_burn_events.stablecoin_id = json_extract(value, '$[0]')
                       AND mint_burn_events.chain_id = json_extract(value, '$[1]')
                       AND mint_burn_events.timestamp < json_extract(value, '$[2]')
                   )
                   AND (flow_type IS NULL OR flow_type NOT IN ('bridge_transfer', 'protocol_internal'))
                   AND (direction = 'mint' OR burn_type IS NULL OR burn_type != 'review_required')
                   AND direction IN ('mint', 'burn')
                   AND NOT EXISTS (
                     SELECT 1 FROM tape_events INDEXED BY idx_tape_source_key
                     WHERE source_table = 'mint_burn_events'
                       AND source_row_id = mint_burn_events.id AND transition = 'updated'
                   )`,
    trailingBinds: [NOTICE_USD, scopedPairsJson, admissionFloorsJson],
    orderBySql: "timestamp ASC, id ASC",
    since,
    until,
    limit,
    getTime: (row) => row.timestamp,
  });
}

function chainLabel(chainId: string): string {
  // Render bare ids — chain meta lives on the client. The EventCard's
  // `[chain]` slot already uppercases short ids, so passing through is fine.
  return chainId;
}

function buildFlowEvent(row: MintBurnSourceRow): TapeEventInsert | null {
  if (row.direction !== "mint" && row.direction !== "burn") return null;
  if (row.amount_usd == null) return null;
  const tsMs = row.timestamp * 1000;
  const type = row.direction === "mint" ? "mint_burn.large_mint" : "mint_burn.large_burn";
  const severity = severityForFlow(row.amount_usd);
  const transition = "updated";
  const sourceRowId = row.id;
  const symbol = TRACKED_META_BY_ID.get(row.stablecoin_id)?.symbol ?? row.symbol;
  const compactUsd = formatCompactUsd(row.amount_usd);
  const verb = row.direction === "mint" ? "minted" : "burned";

  return {
    eventId: buildTapeEventId({
      tsMs,
      type,
      sourceTable: "mint_burn_events",
      sourceRowId,
      transition,
    }),
    type,
    severity,
    ts: tsMs,
    endsAt: null,
    coinId: row.stablecoin_id,
    issuerId: deriveIssuerId(row.stablecoin_id),
    pegCurrency: null,
    chain: row.chain_id,
    title: `${symbol} ${verb} ${compactUsd} · ${chainLabel(row.chain_id)}`,
    summary: `Single ${row.direction} transaction of ${compactUsd} ${symbol} on ${chainLabel(row.chain_id)}.`,
    payload: {
      direction: row.direction,
      amountUsd: row.amount_usd,
      counterparty: row.counterparty,
      flowType: row.flow_type,
      burnType: row.burn_type,
      symbol,
    },
    sourceTable: "mint_burn_events",
    sourceRowId,
    transition,
    sourceUrl: "/flows/",
    methodologyVersion: getMethodologyVersionAt("mint-burn-flow", row.timestamp),
  };
}

async function projectLargeFlows(
  db: D1Database,
  options: ProjectorOptions | undefined,
): Promise<ProjectorResult> {
  const { since, until, limit } = await resolveProjectorOptions(db, CURSOR_KEY, options);
  const scope = await readMintBurnWindowContext(db, Math.floor(Date.now() / 1000),
    MINT_BURN_CONFIGS.filter((config) => ACTIVE_IDS.has(config.stablecoinId)));
  const admittedPairs = new Set(scope.configs.map((config) => `${config.stablecoinId}|${config.chain.chainId}`));
  // Scheduled admission must not announce the pending leg's historical baseline.
  // Explicit operator bounds retain historical repair; grandfathered legs have no floor.
  const scopedPairsJson = JSON.stringify(scope.configs.map((config) => [config.stablecoinId, config.chain.chainId]));
  const admissionFloorsJson = JSON.stringify(options?.since != null ? [] : scope.publication.legs
    .filter((leg) => leg.status === "admitted" && leg.admittedAt != null)
    .map((leg) => [leg.stablecoinId, leg.chainId, leg.admittedAt]));

  // Eligibility can change in place after price healing or burn review. Reconcile
  // recent source identities independently of the watermark; older repairs use
  // explicit operator bounds instead of a full-history scan on every cron.
  const reconcileSince = sourceReconciliationSince(options);

  // Already-projected, unsuppressed claims whose source changed. Retract those
  // that became ineligible; republish eligible corrections in place. A pruned
  // source never matches the join, so a retention delete is never a retraction.
  const changedRows = (await db.prepare(
    `SELECT m.id, m.stablecoin_id, m.symbol, m.chain_id, m.direction, m.amount_usd,
            m.counterparty, m.timestamp, m.flow_type, m.burn_type,
            NOT (${mintBurnTapeEligibleSql("m")}) AS ineligible
       FROM mint_burn_events AS m INDEXED BY idx_mbe2_ts
       JOIN tape_events AS t INDEXED BY idx_tape_source_key
         ON t.source_table = 'mint_burn_events' AND t.source_row_id = m.id AND t.transition = 'updated'
      WHERE m.timestamp > ?${until == null ? "" : " AND m.timestamp <= ?"}
        AND t.suppressed_at IS NULL
        AND ${mintBurnTapeClaimStaleSql("t", "m")}
      ORDER BY m.timestamp ASC, m.id ASC LIMIT ?`,
  ).bind(reconcileSince, ...(until == null ? [] : [until]), limit)
    .all<MintBurnSourceRow & { ineligible: number }>()).results ?? [];
  const retracted = changedRows.filter((row) => row.ineligible === 1);
  if (!options?.dryRun && retracted.length > 0) {
    await batchExecute(db, retracted.map((row) => db.prepare(
      `UPDATE tape_events SET suppressed_at = ?, suppression_reason = ?
        WHERE source_table = 'mint_burn_events' AND source_row_id = ? AND transition = 'updated'
          AND suppressed_at IS NULL
          AND EXISTS (SELECT 1 FROM mint_burn_events AS s WHERE s.id = ?
                        AND NOT (${mintBurnTapeEligibleSql("s")}))`,
    ).bind(Math.floor(Date.now() / 1000), FLOW_CLAIM_RETRACTED_REASON, row.id, row.id)));
  }

  const freshRows = await fetchLargeFlows(db, reconcileSince, until, limit, scopedPairsJson, admissionFloorsJson);
  const rows = [...freshRows, ...changedRows.filter((row) => row.ineligible !== 1
    && admittedPairs.has(`${row.stablecoin_id}|${row.chain_id}`))];
  if (rows.length === 0) return { projected: 0, advanced: null };

  const events: TapeEventInsert[] = [];
  let maxCursor = since;
  // Only fresh rows advance the watermark; corrected rows were already consumed.
  for (const row of freshRows) if (row.timestamp > maxCursor) maxCursor = row.timestamp;
  for (const row of rows) {
    const event = buildFlowEvent(row);
    if (event) events.push(event);
  }

  return finalizeProjectorBatch(db, { events, maxCursor, cursorKey: CURSOR_KEY, options });
}

export function projectMintBurnLargeFlows(
  db: D1Database,
  options?: ProjectorOptions,
): Promise<ProjectorResult> {
  return projectLargeFlows(db, options);
}
