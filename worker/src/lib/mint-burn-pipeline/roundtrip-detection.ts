import { throwIfAborted } from "../abort";
import { MINT_BURN_CONFIGS, type MintBurnContractConfig } from "./mint-burn-contracts";
import { executeMintBurnMaintenanceMutations } from "./materialization-debt";
import { mintBurnConfigKey } from "./mint-burn-contract-identity";
import { mintBurnSupplyProofAcceptedSql } from "./mint-burn-supply-proofs";
import type { MintBurnAffectedHour, MintBurnRow } from "./types";

type RoundtripRow = Pick<MintBurnRow, "id" | "tx_hash" | "stablecoin_id" | "chain_id" | "direction"
  | "flow_type" | "burn_type" | "amount_raw" | "block_number" | "timestamp" | "supply_proof_id"> & { supply_proof_accepted?: number };
export type RoundtripIdentity = Pick<RoundtripRow, "tx_hash" | "stablecoin_id" | "chain_id">;
export interface RoundtripCursor extends RoundtripIdentity { timestamp: number }

function groupKey(row: RoundtripIdentity): string {
  return JSON.stringify([row.tx_hash, row.stablecoin_id, row.chain_id]);
}

/** This is the candidate authority for ingestion, maintenance and the operator job. */
function isAtomicRoundtripCandidate(row: Pick<RoundtripRow, "flow_type" | "direction" | "burn_type" | "supply_proof_id" | "supply_proof_accepted">): boolean {
  return (row.supply_proof_id == null || row.supply_proof_accepted === 1)
    && row.flow_type === "standard" && (row.burn_type === "effective_burn"
    || (row.direction === "mint" && row.burn_type == null));
}

function hasExactRawBalance(rows: readonly RoundtripRow[]): boolean {
  let mint = 0n;
  let burn = 0n;
  for (const row of rows) {
    if (row.amount_raw == null || !/^[0-9]+$/.test(row.amount_raw)) return false;
    const raw = BigInt(row.amount_raw);
    if (raw <= 0n) return false;
    if (row.direction === "mint") mint += raw;
    else burn += raw;
  }
  return mint > 0n && mint === burn;
}

function groupRows<T extends RoundtripIdentity>(rows: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    if (!row.tx_hash) continue;
    const key = groupKey(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

/** Only exactly cancelling, resolved standard legs can leave the accounting net. */
export function detectAtomicRoundtrips(rows: MintBurnRow[]): number {
  let flagged = 0;
  // A proof reference needs the persisted acceptance read below.
  for (const group of groupRows(rows.filter((row) => row.supply_proof_id == null && isAtomicRoundtripCandidate(row))).values()) {
    if (!hasExactRawBalance(group)) continue;
    for (const row of group) {
      row.flow_type = "atomic_roundtrip";
      flagged++;
    }
  }
  return flagged;
}

export interface RoundtripReconcileResult {
  changed: number;
  toRoundtrip: number;
  toStandard: number;
  affectedHours: Map<string, MintBurnAffectedHour>;
}

/** Load full persisted transaction populations, including other configs sharing the bucket. */
export async function reconcileAtomicRoundtripGroups(
  db: D1Database,
  identities: readonly RoundtripIdentity[],
  options: { signal?: AbortSignal; knownCompleteConfigKey?: string; configs?: readonly MintBurnContractConfig[]; returnAffectedHours?: boolean } = {},
): Promise<RoundtripReconcileResult> {
  const result: RoundtripReconcileResult = { changed: 0, toRoundtrip: 0, toStandard: 0, affectedHours: new Map() };
  if (identities.length === 0) return result;
  throwIfAborted(options.signal);
  const keys = [...groupRows(identities).values()].map(([row]) => [row.tx_hash, row.stablecoin_id, row.chain_id]);
  const { results: rows } = await db.prepare(`SELECT e.id, e.tx_hash, e.stablecoin_id, e.chain_id,
      e.direction, e.flow_type, e.burn_type, e.amount_raw, e.block_number, e.timestamp, e.supply_proof_id,
      CASE WHEN ${mintBurnSupplyProofAcceptedSql("e")} THEN 1 ELSE 0 END AS supply_proof_accepted
    FROM mint_burn_events e JOIN json_each(?) k
      ON e.tx_hash = json_extract(k.value, '$[0]')
      AND e.stablecoin_id = json_extract(k.value, '$[1]') AND e.chain_id = json_extract(k.value, '$[2]')`)
    .bind(JSON.stringify(keys)).all<RoundtripRow>();
  throwIfAborted(options.signal);
  const configs = options.configs ?? MINT_BURN_CONFIGS;
  const relevantConfigs = configs.filter((config) => rows.some((row) => config.stablecoinId === row.stablecoin_id
    && config.chain.chainId === row.chain_id && config.startBlock <= row.block_number));
  const requiredKeys = relevantConfigs.map(mintBurnConfigKey).filter((key) => key !== options.knownCompleteConfigKey);
  const frontiers = requiredKeys.length === 0 ? [] : (await db.prepare(`SELECT config_key, last_block
    FROM mint_burn_sync_state WHERE config_key IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(requiredKeys)).all<{ config_key: string; last_block: number }>()).results;
  const lastBlocks = new Map(frontiers.map((row) => [row.config_key, row.last_block]));

  const mutations: Parameters<typeof executeMintBurnMaintenanceMutations>[1] = [];
  const counts: Array<{ forward: number; reverse: number }> = [];
  for (const group of groupRows(rows).values()) {
    throwIfAborted(options.signal);
    const identity = group[0];
    const block = Math.max(...group.map((row) => row.block_number));
    const siblings = relevantConfigs.filter((config) => config.stablecoinId === identity.stablecoin_id
      && config.chain.chainId === identity.chain_id && config.startBlock <= block);
    // Raw units of distinct share classes cannot be added at different scales.
    if (new Set(siblings.map((config) => config.decimals)).size > 1 || siblings.some((config) =>
      mintBurnConfigKey(config) !== options.knownCompleteConfigKey && (lastBlocks.get(mintBurnConfigKey(config)) ?? -1) < block)) continue;
    const provisional = group.map((row) => row.flow_type === "atomic_roundtrip" ? { ...row, flow_type: "standard" as const } : row);
    const candidates = provisional.filter(isAtomicRoundtripCandidate);
    const existing = group.filter((row) => row.flow_type === "atomic_roundtrip");
    // A legacy REAL cannot prove raw equality, nor justify changing its old tags.
    if ([...candidates, ...existing].some((row) => row.amount_raw == null || !/^[0-9]+$/.test(row.amount_raw))) continue;
    const exact = hasExactRawBalance(candidates);
    // Retain the one-sided replay guard even if the opposite source row is absent.
    const completeSides = new Set(group.map((row) => row.direction)).size > 1;
    const candidateIds = new Set(candidates.map((row) => row.id));
    const forward = exact ? group.filter((row) => row.flow_type === "standard" && candidateIds.has(row.id)).map((row) => row.id) : [];
    const reverse = completeSides ? existing.filter((row) => !exact || !candidateIds.has(row.id)).map((row) => row.id) : [];
    if (forward.length === 0 && reverse.length === 0) continue;
    const snapshot = JSON.stringify(group.map((row) => [row.id, row.flow_type, row.burn_type, row.amount_raw,
      row.supply_proof_id ?? null, row.supply_proof_accepted]));
    // Fence the complete population as well as each row: a concurrent sibling insert
    // or classifier revision must not validate a stale BigInt comparison.
    const unchangedSql = `(SELECT COUNT(*) FROM mint_burn_events WHERE tx_hash = ? AND stablecoin_id = ? AND chain_id = ?) = ?
      AND NOT EXISTS (SELECT 1 FROM mint_burn_events e WHERE e.tx_hash = ? AND e.stablecoin_id = ? AND e.chain_id = ?
        AND NOT EXISTS (SELECT 1 FROM json_each(?) s WHERE e.id = json_extract(s.value, '$[0]')
          AND e.flow_type IS json_extract(s.value, '$[1]') AND e.burn_type IS json_extract(s.value, '$[2]')
          AND e.amount_raw IS json_extract(s.value, '$[3]') AND e.supply_proof_id IS json_extract(s.value, '$[4]')
          AND (CASE WHEN ${mintBurnSupplyProofAcceptedSql("e")} THEN 1 ELSE 0 END) IS json_extract(s.value, '$[5]')))`;
    const keyBinds = [identity.tx_hash, identity.stablecoin_id, identity.chain_id];
    const unchangedBinds = [...keyBinds, group.length, ...keyBinds, snapshot];
    const selectedIds = JSON.stringify([...forward, ...reverse]);
    counts.push({ forward: forward.length, reverse: reverse.length });
    mutations.push({
      enqueue: db.prepare(`INSERT OR REPLACE INTO mint_burn_dirty_hours (stablecoin_id, chain_id, hour_ts)
        SELECT DISTINCT stablecoin_id, chain_id, (timestamp / 3600) * 3600 FROM mint_burn_events
        WHERE id IN (SELECT value FROM json_each(?)) AND ${unchangedSql}
        ${options.returnAffectedHours === false ? "" : "RETURNING stablecoin_id, chain_id, hour_ts"}`).bind(selectedIds, ...unchangedBinds),
      update: db.prepare(`UPDATE mint_burn_events SET flow_type = CASE
          WHEN id IN (SELECT value FROM json_each(?)) THEN 'atomic_roundtrip' ELSE 'standard' END
        WHERE id IN (SELECT value FROM json_each(?)) AND ${unchangedSql}`)
        .bind(JSON.stringify(forward), selectedIds, ...unchangedBinds),
    });
  }
  const { changed, changesByMutation, affectedHours } = await executeMintBurnMaintenanceMutations(db, mutations, options);
  result.changed = changed;
  result.affectedHours = affectedHours;
  for (let index = 0; index < counts.length; index++) {
    if (changesByMutation[index] === 0) continue;
    result.toRoundtrip += counts[index].forward;
    result.toStandard += counts[index].reverse;
  }
  return result;
}

/** Keyset discovery advances over nonmatching groups too; all exactness stays in BigInt. */
export async function discoverRoundtripGroups(
  db: D1Database,
  since: number,
  limit: number,
  options: { cursor?: RoundtripCursor | null; stablecoinId?: string | null; signal?: AbortSignal } = {},
): Promise<RoundtripCursor[]> {
  throwIfAborted(options.signal);
  const cursor = options.cursor;
  return (await db.prepare(`SELECT tx_hash, stablecoin_id, chain_id, MIN(timestamp) AS timestamp
    FROM mint_burn_events
    WHERE flow_type IN ('standard', 'atomic_roundtrip')
      ${options.stablecoinId ? "AND stablecoin_id = ?" : ""}
    AND timestamp >= ?
    GROUP BY tx_hash, stablecoin_id, chain_id
    HAVING (COUNT(DISTINCT direction) > 1 OR SUM(CASE WHEN flow_type = 'atomic_roundtrip' THEN 1 ELSE 0 END) > 0)
      ${cursor ? "AND (MIN(timestamp), stablecoin_id, tx_hash, chain_id) > (?, ?, ?, ?)" : ""}
    ORDER BY MIN(timestamp), stablecoin_id, tx_hash, chain_id LIMIT ?`)
    .bind(...(options.stablecoinId ? [options.stablecoinId] : []), since,
      ...(cursor ? [cursor.timestamp, cursor.stablecoin_id, cursor.tx_hash, cursor.chain_id] : []), limit)
    .all<RoundtripCursor>()).results;
}

/** Invalid checkpoint state restarts discovery; it never changes a classification. */
export function parseRoundtripCursor(raw: string): RoundtripCursor | null {
  try {
    const value = JSON.parse(raw) as Partial<RoundtripCursor> | null;
    return value && Number.isSafeInteger(value.timestamp) && value.timestamp! >= 0
      && typeof value.tx_hash === "string" && typeof value.stablecoin_id === "string" && typeof value.chain_id === "string"
      ? value as RoundtripCursor : null;
  } catch {
    return null;
  }
}
