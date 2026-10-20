import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type { MintBurnContractConfig } from "../mint-burn-contracts";
import { mintBurnConfigKey } from "./sync-state";

export interface MintBurnScanCoverage {
  configKey: string;
  configFingerprint: string;
  chainId: string;
  fromBlock: number;
  toBlock: number;
  fromTimestamp: number;
  toTimestamp: number;
  finalizedBlock: number;
  acceptedAt: number;
}

/** Version the source/decoder contract here when changing scan semantics. */
export function mintBurnScanFingerprint(config: MintBurnContractConfig): string {
  const { chain, symbol: _symbol, enabled: _enabled, tier: _tier, ...source } = config;
  return sha256Hex(stableJsonStringifyV1({
    domain: "mint-burn-finalized-scan-v1", chainId: chain.chainId, source,
  }));
}

/** Called only after exhaustive topics, row persistence and hourly materialization succeed.
 * SQL reads/compacts inside the cursor transaction, never from a stale pre-batch snapshot.
 * Existing segments are maximally merged; an incoming interval can touch several of them.
 */
export function mintBurnScanCoverageStatements(db: D1Database, proof: MintBurnScanCoverage): D1PreparedStatement[] {
  if (![proof.fromBlock, proof.toBlock, proof.fromTimestamp, proof.toTimestamp, proof.finalizedBlock, proof.acceptedAt]
    .every(Number.isSafeInteger) || proof.fromBlock < 0 || proof.toBlock < proof.fromBlock
    || proof.fromTimestamp <= 0 || proof.toTimestamp < proof.fromTimestamp
    || proof.finalizedBlock < proof.toBlock || proof.acceptedAt < proof.toTimestamp) {
    throw new Error("Invalid mint/burn scan coverage boundaries");
  }
  return [
    db.prepare(`
      /* pharos:mint-burn-scan-coverage:merge */
      INSERT INTO mint_burn_scan_coverage
        (config_key, config_fingerprint, chain_id, from_block, to_block, from_timestamp,
         to_timestamp, finality_tag, finalized_block, accepted_at)
      SELECT ?, ?, ?, MIN(from_block), MAX(to_block), MIN(from_timestamp), MAX(to_timestamp),
             'finalized', MAX(finalized_block), MAX(accepted_at)
      FROM (
        SELECT from_block, to_block, from_timestamp, to_timestamp, finalized_block, accepted_at
        FROM mint_burn_scan_coverage
        WHERE config_key = ? AND config_fingerprint = ? AND chain_id = ?
          AND from_block <= ? AND to_block >= ?
        UNION ALL SELECT ?, ?, ?, ?, ?, ?
      ) WHERE true
      ON CONFLICT(config_key, config_fingerprint, from_block) DO UPDATE SET
        to_block = excluded.to_block, from_timestamp = excluded.from_timestamp,
        to_timestamp = excluded.to_timestamp, finalized_block = excluded.finalized_block,
        accepted_at = excluded.accepted_at
    `).bind(proof.configKey, proof.configFingerprint, proof.chainId,
      proof.configKey, proof.configFingerprint, proof.chainId, proof.toBlock + 1, proof.fromBlock - 1,
      proof.fromBlock, proof.toBlock, proof.fromTimestamp, proof.toTimestamp, proof.finalizedBlock, proof.acceptedAt),
    // Delete only segments subsumed by the just-merged interval. Other fingerprints/gaps survive.
    db.prepare(`
      /* pharos:mint-burn-scan-coverage:compact */
      DELETE FROM mint_burn_scan_coverage
      WHERE config_key = ? AND config_fingerprint = ? AND chain_id = ?
        AND from_block > (
          SELECT MIN(from_block) FROM mint_burn_scan_coverage
          WHERE config_key = ? AND config_fingerprint = ? AND chain_id = ?
            AND from_block <= ? AND to_block >= ?
        ) AND from_block <= ? AND to_block >= ?
    `).bind(proof.configKey, proof.configFingerprint, proof.chainId,
      proof.configKey, proof.configFingerprint, proof.chainId, proof.toBlock + 1, proof.fromBlock - 1,
      proof.toBlock + 1, proof.fromBlock - 1),
  ];
}

/** Closed UTC windows require continuous block AND time evidence for every required config.
 * No public reader uses this until the separate nullable-window activation.
 */
export async function hasMintBurnScanCoverage(
  db: D1Database, configs: readonly MintBurnContractConfig[], fromTimestamp: number, toTimestamp: number,
): Promise<boolean> {
  if (configs.length === 0 || !Number.isSafeInteger(fromTimestamp) || !Number.isSafeInteger(toTimestamp)
    || fromTimestamp <= 0 || fromTimestamp >= toTimestamp || fromTimestamp % 86_400 !== 0 || toTimestamp % 86_400 !== 0) return false;
  for (const config of configs) {
    const rows = await db.prepare(`
      SELECT from_block, to_block, from_timestamp, to_timestamp FROM mint_burn_scan_coverage
      WHERE config_key = ? AND config_fingerprint = ? AND chain_id = ? AND finality_tag = 'finalized'
        AND to_timestamp >= ? AND from_timestamp <= ?
      ORDER BY from_block
    `).bind(mintBurnConfigKey(config), mintBurnScanFingerprint(config), config.chain.chainId, fromTimestamp, toTimestamp)
      .all<{ from_block: number; to_block: number; from_timestamp: number; to_timestamp: number }>();
    let frontier: { block: number; timestamp: number } | null = null;
    let covered = false;
    for (const row of rows.results) {
      if (frontier == null || row.from_block > frontier.block + 1) {
        frontier = row.from_timestamp <= fromTimestamp ? { block: row.to_block, timestamp: row.to_timestamp } : null;
      } else {
        frontier.block = Math.max(frontier.block, row.to_block);
        frontier.timestamp = Math.max(frontier.timestamp, row.to_timestamp);
      }
      if (frontier != null && frontier.timestamp >= toTimestamp) { covered = true; break; }
    }
    if (!covered) return false;
  }
  return true;
}
