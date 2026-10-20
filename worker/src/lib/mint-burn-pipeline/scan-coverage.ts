import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type { MintBurnContractConfig } from "../mint-burn-contracts";
import { mintBurnConfigKey } from "./sync-state";
import legacyFingerprints from "./legacy-cutover-fingerprints.json";

/** Last closed hour before T1 deployed at 12:03Z; remove after 2027-01-18T12:00Z
 * plus the public freshness budget (the longest public window is 90 days).
 * This is weaker, explicitly labelled legacy assurance, NOT a v2 ledger proof.
 */
export const MINT_BURN_LEGACY_CUTOVER = Date.parse("2026-10-20T12:00:00Z") / 1000;
const legacyIdentities: Readonly<Record<string, true>> = Object.fromEntries(
  legacyFingerprints.map((fingerprint) => [fingerprint, true as const]),
);

export interface MintBurnLegacySpan {
  start: number;
  end: number;
}

export interface MintBurnLegacyRow {
  config_key: string;
  last_block: number;
  timestamp: number | null;
  first_hour_ts: number | null;
}

export function prepareMintBurnLegacyEvidence(
  db: D1Database, configs: readonly MintBurnContractConfig[],
): D1PreparedStatement {
  return db.prepare(`
    SELECT /* pharos:mint-burn-legacy-evidence */
      s.config_key, s.last_block, t.timestamp,
      (SELECT MIN(h.hour_ts) FROM mint_burn_hourly h
       WHERE h.chain_id = json_extract(i.value, '$[1]')
         AND h.stablecoin_id = json_extract(i.value, '$[2]') AND h.hour_ts < ?) AS first_hour_ts
    FROM json_each(?) i
    JOIN mint_burn_sync_state s ON s.config_key = json_extract(i.value, '$[0]')
    LEFT JOIN block_timestamp_cache t ON t.chain_id = json_extract(i.value, '$[1]')
      AND t.block_number = s.last_block
  `).bind(MINT_BURN_LEGACY_CUTOVER, JSON.stringify(configs.map((config) =>
    [mintBurnConfigKey(config), config.chain.chainId, config.stablecoinId])));
}

/** Anchor the old cursor/event span to actual scan time, never to the request clock.
 * A new source/fingerprint or a first scan after cutover cannot acquire legacy history.
 */
export function buildMintBurnLegacySpans(
  configs: readonly MintBurnContractConfig[], rows: readonly MintBurnLegacyRow[],
  segments: ReadonlyMap<string, readonly MintBurnScanSegment[]>,
  blockTime: (chainId: string) => number | null,
): Map<string, MintBurnLegacySpan> {
  const byKey = new Map(rows.map((row) => [row.config_key, row]));
  const spans = new Map<string, MintBurnLegacySpan>();
  const pairCounts = new Map<string, number>();
  for (const config of configs) {
    const pair = `${config.stablecoinId}|${config.chain.chainId}`;
    pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
  }
  for (const config of configs) {
    if (!legacyIdentities[mintBurnScanFingerprint(config)]) continue;
    const key = mintBurnConfigKey(config);
    const row = byKey.get(key);
    if (!row || row.last_block < config.startBlock) continue;
    const boundary = (segments.get(key) ?? []).find((segment) =>
      segment.dirty_hour_ts == null && segment.from_timestamp < MINT_BURN_LEGACY_CUTOVER
      && segment.to_block <= row.last_block);
    const timestamp = boundary?.from_timestamp ?? row.timestamp;
    const block = boundary?.from_block ?? row.last_block;
    if (timestamp == null || timestamp > MINT_BURN_LEGACY_CUTOVER) continue;
    const secondsPerBlock = blockTime(config.chain.chainId);
    const cursorStart = secondsPerBlock == null ? timestamp
      : timestamp - Math.max(0, block - config.startBlock) * secondsPerBlock;
    // Hourly buckets have no contract attribution. A sibling contract's old event
    // must not extend this config's cursor span (notably BUIDL's two share classes).
    const firstHour = pairCounts.get(`${config.stablecoinId}|${config.chain.chainId}`) === 1
      ? row.first_hour_ts : null;
    const start = Math.min(cursorStart, firstHour ?? timestamp);
    const end = Math.min(MINT_BURN_LEGACY_CUTOVER, boundary?.to_timestamp ?? timestamp);
    if (start < end) spans.set(key, { start, end });
  }
  return spans;
}

/** Split only at the immutable cutover; debt vetoes both assurance regimes. */
export function mintBurnWindowAdmits(
  configs: readonly MintBurnContractConfig[], segments: ReadonlyMap<string, readonly MintBurnScanSegment[]>,
  legacy: ReadonlyMap<string, MintBurnLegacySpan>, from: number, to: number,
): boolean {
  if (from >= MINT_BURN_LEGACY_CUTOVER) return mintBurnScanCoverageAdmits(configs, segments, from, to);
  if (configs.length === 0 || from <= 0 || from >= to || from % 3600 !== 0 || to % 3600 !== 0) return false;
  const legacyEnd = Math.min(to, MINT_BURN_LEGACY_CUTOVER);
  for (const config of configs) {
    const key = mintBurnConfigKey(config);
    if ((segments.get(key) ?? []).some((row) => row.dirty_hour_ts != null
      && row.dirty_hour_ts < to && row.dirty_hour_ts + 3600 > from)) return false;
    // Prefer full v2 evidence whenever it exists.
    if (mintBurnScanCoverageAdmits([config], segments, from, legacyEnd)) continue;
    const span = legacy.get(key);
    if (!span || span.start > from || span.end < legacyEnd) return false;
  }
  return to <= MINT_BURN_LEGACY_CUTOVER
    || mintBurnScanCoverageAdmits(configs, segments, MINT_BURN_LEGACY_CUTOVER, to);
}

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
    domain: "mint-burn-finalized-scan-v2", chainId: chain.chainId, source,
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

export interface MintBurnScanSegment {
  config_key: string;
  from_block: number;
  to_block: number;
  from_timestamp: number;
  to_timestamp: number;
  /** A debt row is evidence against admission, never a scan segment. */
  dirty_hour_ts?: number | null;
}

/** Include proof and materialization debt in the same snapshot as the certified data. */
export function prepareMintBurnScanCoverage(
  db: D1Database, configs: readonly MintBurnContractConfig[], fromTimestamp: number, toTimestamp: number,
): D1PreparedStatement {
  const identities = configs.map((config) =>
    [mintBurnConfigKey(config), mintBurnScanFingerprint(config), config.chain.chainId, config.stablecoinId]);
  const identitiesJson = JSON.stringify(identities);
  return db.prepare(`
    SELECT /* pharos:mint-burn-scan-coverage:read */
      config_key, from_block, to_block, from_timestamp, to_timestamp, NULL AS dirty_hour_ts
    FROM mint_burn_scan_coverage
    WHERE (config_key, config_fingerprint, chain_id) IN (
      SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]')
      FROM json_each(?)
    ) AND finality_tag = 'finalized' AND finalized_block >= to_block
      AND accepted_at >= to_timestamp AND to_timestamp >= ? AND from_timestamp <= ?
    UNION ALL
    SELECT json_extract(i.value, '$[0]') AS config_key, 0, 0, d.hour_ts, d.hour_ts, d.hour_ts AS dirty_hour_ts
    FROM json_each(?) i JOIN mint_burn_dirty_hours d
      ON d.stablecoin_id = json_extract(i.value, '$[3]') AND d.chain_id = json_extract(i.value, '$[2]')
    WHERE d.hour_ts >= ? AND d.hour_ts < ?
    ORDER BY config_key, from_block
  `).bind(identitiesJson, fromTimestamp, toTimestamp, identitiesJson, fromTimestamp, toTimestamp);
}

export function decodeMintBurnScanCoverage(
  result: D1Result<MintBurnScanSegment>,
): Map<string, MintBurnScanSegment[]> {
  const segments = new Map<string, MintBurnScanSegment[]>();
  for (const row of result.results) {
    const existing = segments.get(row.config_key) ?? [];
    existing.push(row);
    segments.set(row.config_key, existing);
  }
  return segments;
}

export async function readMintBurnScanCoverage(
  db: D1Database, configs: readonly MintBurnContractConfig[], fromTimestamp: number, toTimestamp: number,
): Promise<Map<string, MintBurnScanSegment[]>> {
  return decodeMintBurnScanCoverage(
    await prepareMintBurnScanCoverage(db, configs, fromTimestamp, toTimestamp).all<MintBurnScanSegment>(),
  );
}

/** Closed UTC hours require continuous block AND time evidence for every config. */
export function mintBurnScanCoverageAdmits(
  configs: readonly MintBurnContractConfig[], segments: ReadonlyMap<string, readonly MintBurnScanSegment[]>,
  fromTimestamp: number, toTimestamp: number,
): boolean {
  if (configs.length === 0 || !Number.isSafeInteger(fromTimestamp) || !Number.isSafeInteger(toTimestamp)
    || fromTimestamp <= 0 || fromTimestamp >= toTimestamp || fromTimestamp % 3600 !== 0 || toTimestamp % 3600 !== 0) return false;
  for (const config of configs) {
    const rows = segments.get(mintBurnConfigKey(config)) ?? [];
    if (rows.some((row) => row.dirty_hour_ts != null
      && row.dirty_hour_ts < toTimestamp && row.dirty_hour_ts + 3600 > fromTimestamp)) return false;
    let frontier: { block: number; timestamp: number } | null = null;
    let covered = false;
    for (const row of rows) {
      if (row.dirty_hour_ts != null) continue;
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

export async function hasMintBurnScanCoverage(
  db: D1Database, configs: readonly MintBurnContractConfig[], fromTimestamp: number, toTimestamp: number,
): Promise<boolean> {
  return mintBurnScanCoverageAdmits(configs,
    await readMintBurnScanCoverage(db, configs, fromTimestamp, toTimestamp), fromTimestamp, toTimestamp);
}
