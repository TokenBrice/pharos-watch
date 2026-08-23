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
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/mint-burn-flow";
import { formatCompactUsd } from "@shared/lib/format";
import type { TapeEventSeverity } from "@shared/types/tape-event";

const MINT_BURN_VERSION = MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL.replace(/^v/, "");

import { buildTapeEventId, deriveIssuerId } from "../tape-event-helpers";
import type { TapeEventInsert } from "../tape-event-types";
import {
  finalizeProjectorBatch,
  fetchRowsWithTieExpansion,
  resolveProjectorOptions,
  type ProjectorOptions,
  type ProjectorResult,
} from "./types";

const CURSOR_KEY = "mint_burn.large_flow";

// Notice threshold; tuned to emit at most a handful of events per day across
// tracked coins. ~$10M single-transaction flows are already newsworthy in
// the stablecoin context — daily aggregate flows are much larger but a
// single tx of this size signals a counterparty event worth surfacing.
const NOTICE_USD = 10_000_000;
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
  amount_usd: number;
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
): Promise<MintBurnSourceRow[]> {
  // Bridge transfers leak into mint/burn aggregates but represent token
  // teleportation, not economic mint/burn — exclude them. `review_required`
  // burns are still being classified; emit only confirmed burn types so the
  // tape doesn't surface ambiguous rows.
  return fetchRowsWithTieExpansion<MintBurnSourceRow>(db, {
    selectSql: `SELECT id, stablecoin_id, symbol, chain_id, direction, amount_usd,
                      counterparty, timestamp, flow_type, burn_type`,
    fromSql: "mint_burn_events",
    timeColumn: "timestamp",
    trailingWhereSql: `
                   AND amount_usd IS NOT NULL
                   AND amount_usd >= ?
                   AND (flow_type IS NULL OR flow_type != 'bridge_transfer')
                   AND (direction = 'mint' OR burn_type IS NULL OR burn_type != 'review_required')`,
    trailingBinds: [NOTICE_USD],
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
    methodologyVersion: MINT_BURN_VERSION,
  };
}

async function projectLargeFlows(
  db: D1Database,
  options: ProjectorOptions | undefined,
): Promise<ProjectorResult> {
  const { since, until, limit } = await resolveProjectorOptions(db, CURSOR_KEY, options);

  const rows = await fetchLargeFlows(db, since, until, limit);
  if (rows.length === 0) return { projected: 0, advanced: null };

  const events: TapeEventInsert[] = [];
  let maxCursor = since;
  for (const row of rows) {
    if (row.timestamp > maxCursor) maxCursor = row.timestamp;
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
