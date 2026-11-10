import { getCache, getCaches } from "../../lib/db-cache";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { getMintBurnRangeProofEligibility, mintBurnConservationFingerprint } from "../../lib/mint-burn-conservation";
import type { MintBurnContractConfig } from "../../lib/mint-burn-contracts";
import { mintBurnConfigKey } from "../../lib/mint-burn-pipeline/sync-state";
import { mintBurnScanCoverageStatements, type MintBurnScanCoverage } from "../../lib/mint-burn-pipeline/scan-coverage";
import { COVERAGE_REPAIR_MAX_BLOCKS, type MintBurnCoverageGap } from "./repair-coverage";
import { MINT_BURN_EVENT_RETENTION_SEC } from "./retention";

interface RetainedCoverageRow {
  config_key: string;
  from_block: number;
  to_block: number;
  from_timestamp: number;
  retained_from_block: number | null;
}

interface SupplyProofRepairCursor {
  fingerprint: string;
  lastBlock: number | null;
  maxBlocks?: number;
}

export function mintBurnSupplyProofRepairCursorKey(configKey: string): string {
  return `mint-burn-range-proof-repair:v1:${configKey}`;
}

function decodeCursor(value: string | undefined): SupplyProofRepairCursor | null {
  if (value === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || !("fingerprint" in parsed) ||
        !("lastBlock" in parsed) || typeof parsed.fingerprint !== "string" ||
        (parsed.lastBlock !== null && (typeof parsed.lastBlock !== "number" ||
          !Number.isSafeInteger(parsed.lastBlock) || parsed.lastBlock < 0))) return null;
    const maxBlocks = "maxBlocks" in parsed && typeof parsed.maxBlocks === "number" &&
      Number.isSafeInteger(parsed.maxBlocks) && parsed.maxBlocks >= 1 && parsed.maxBlocks <= COVERAGE_REPAIR_MAX_BLOCKS
      ? parsed.maxBlocks : undefined;
    return { fingerprint: parsed.fingerprint, lastBlock: parsed.lastBlock, ...(maxBlocks != null ? { maxBlocks } : {}) };
  } catch {
    return null;
  }
}

export async function loadMintBurnSupplyProofRepairCursor(
  db: D1Database, config: MintBurnContractConfig,
): Promise<SupplyProofRepairCursor> {
  const fingerprint = mintBurnConservationFingerprint(config);
  const cursor = decodeCursor((await getCache(db, mintBurnSupplyProofRepairCursorKey(mintBurnConfigKey(config))))?.value);
  return cursor?.fingerprint === fingerprint ? cursor : { fingerprint, lastBlock: null };
}

/** Revisit every retained range once per law revision, independently of live ingestion.
 * The floor is a complete retained hour; older surviving unresolved rows cannot
 * establish that their already-pruned siblings still exist.
 */
export async function loadMintBurnSupplyProofRepairRanges(
  db: D1Database, configs: readonly MintBurnContractConfig[], liveCursors: ReadonlyMap<string, number>, now: number,
): Promise<MintBurnCoverageGap[]> {
  const eligible = configs.filter((config) => getMintBurnRangeProofEligibility(config).supported);
  if (eligible.length === 0) return [];
  const cutoff = Math.ceil((now - MINT_BURN_EVENT_RETENTION_SEC) / 3600) * 3600;
  const [coverage, progress] = await Promise.all([
    db.prepare(`
      WITH retained AS (
        SELECT chain_id, MIN(block_number) AS from_block FROM block_timestamp_cache
        WHERE timestamp >= ? GROUP BY chain_id
      )
      SELECT /* pharos:mint-burn-supply-proof-repair */ c.config_key, c.from_block, c.to_block,
        c.from_timestamp, r.from_block AS retained_from_block
      FROM mint_burn_scan_coverage c
      JOIN json_each(?) i ON c.config_key = json_extract(i.value, '$[0]')
        AND c.chain_id = json_extract(i.value, '$[1]')
      LEFT JOIN retained r ON r.chain_id = c.chain_id
      WHERE c.to_timestamp >= ?
      ORDER BY c.config_key, c.from_block
    `).bind(cutoff, JSON.stringify(eligible.map((config) => [mintBurnConfigKey(config), config.chain.chainId])), cutoff)
      .all<RetainedCoverageRow>(),
    getCaches(db, eligible.map((config) => mintBurnSupplyProofRepairCursorKey(mintBurnConfigKey(config)))),
  ]);
  const byKey = new Map<string, RetainedCoverageRow[]>();
  for (const row of coverage.results) {
    const rows = byKey.get(row.config_key) ?? [];
    rows.push(row);
    byKey.set(row.config_key, rows);
  }
  const ranges: MintBurnCoverageGap[] = [];
  for (const config of eligible) {
    const key = mintBurnConfigKey(config);
    const segments = byKey.get(key);
    const live = liveCursors.get(key);
    if (!segments?.length || live == null) continue;
    const first = segments[0]!;
    const retained = first.retained_from_block ?? (first.from_timestamp >= cutoff ? first.from_block : null);
    if (retained == null) continue;
    const cursor = decodeCursor(progress.get(mintBurnSupplyProofRepairCursorKey(key))?.value);
    const fromBlock = Math.max(config.startBlock, first.from_block, retained,
      cursor?.fingerprint === mintBurnConservationFingerprint(config) && cursor.lastBlock != null ? cursor.lastBlock + 1 : 0);
    // Stop at ledger gaps. Coverage repair must fill them before this independent
    // cursor can pass; otherwise a later filled hole would never be revisited.
    let coveredTo: number | null = null;
    for (const segment of segments) {
      if (segment.to_block < fromBlock) continue;
      if (segment.from_block > (coveredTo ?? fromBlock) + (coveredTo === null ? 0 : 1)) break;
      coveredTo = Math.max(coveredTo ?? fromBlock, segment.to_block);
    }
    if (coveredTo == null || fromBlock > live) continue;
    ranges.push({ config, fromBlock, toBlock: Math.min(coveredTo, live, fromBlock + COVERAGE_REPAIR_MAX_BLOCKS - 1) });
  }
  return ranges;
}

/** Called only after whole-hour materialization; never writes the live cursor. */
export async function commitMintBurnSupplyProofRepair(
  db: D1Database, config: MintBurnContractConfig, proof: MintBurnScanCoverage,
): Promise<void> {
  const key = mintBurnConfigKey(config);
  if (proof.configKey !== key) throw new Error("Supply-proof repair config mismatch");
  const cursor: SupplyProofRepairCursor = { ...await loadMintBurnSupplyProofRepairCursor(db, config), lastBlock: proof.toBlock };
  await runWithOverloadRetry(() => db.batch([
    ...mintBurnScanCoverageStatements(db, proof),
    db.prepare(`INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .bind(mintBurnSupplyProofRepairCursorKey(key), JSON.stringify(cursor), proof.acceptedAt),
  ]));
}
