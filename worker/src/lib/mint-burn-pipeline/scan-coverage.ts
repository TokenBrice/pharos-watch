import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type { MintBurnContractConfig } from "../mint-burn-contracts";
import { mintBurnConfigKey } from "../mint-burn-contract-identity";
import { needsCurrentMintBurnReceiptClassification } from "../mint-burn-published-gauge";
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
  materializedStablecoinId?: string;
  materialization?: { revision: string; hours: number[] };
}

const fingerprintCache = new WeakMap<MintBurnContractConfig, { source: string; fingerprint: string }>();

/** Version the source/decoder contract here when changing scan semantics. */
export function mintBurnScanFingerprint(config: MintBurnContractConfig): string {
  const { chain, symbol: _symbol, enabled: _enabled, tier: _tier, ...source } = config;
  const serialized = stableJsonStringifyV1({
    domain: "mint-burn-finalized-scan-v2", chainId: chain.chainId, source,
  });
  const cached = fingerprintCache.get(config);
  if (cached?.source === serialized) return cached.fingerprint;
  const fingerprint = sha256Hex(serialized);
  fingerprintCache.set(config, { source: serialized, fingerprint });
  return fingerprint;
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

export const MINT_BURN_WRITER_EPOCH = "holder-accounting-v2";

export function isMintBurnWriterEpochSchemaMissing(error: unknown): boolean {
  return error instanceof Error && /no such table: (?:main\.)?mint_burn_writer_epoch_(?:coverage|hours)\b/i.test(error.message);
}

/** A separate ledger keeps ordinary scan proof readable by rollback Workers. */
export async function commitMintBurnMaterializedCoverage(
  db: D1Database,
  proof: MintBurnScanCoverage,
  before: D1PreparedStatement[],
  after: D1PreparedStatement[] = [],
): Promise<void> {
  const scan = mintBurnScanCoverageStatements(db, proof);
  const legacy = [...before, ...scan, ...after];
  const coinId = proof.materializedStablecoinId;
  if (coinId == null) { await db.batch(legacy); return; }
  const match = `config_key = ? AND config_fingerprint = ? AND chain_id = ? AND writer_epoch = ?
    AND from_block <= ? AND to_block >= ?`;
  const identity = [proof.configKey, proof.configFingerprint, proof.chainId, MINT_BURN_WRITER_EPOCH,
    proof.toBlock + 1, proof.fromBlock - 1];
  // A previous Worker may rewrite a bucket after the new materialization batch settles its debt.
  const unsettled = `EXISTS (SELECT 1 FROM mint_burn_dirty_hours
    WHERE stablecoin_id = ? AND chain_id = ? AND hour_ts >= ? AND hour_ts < ?)
    OR EXISTS (SELECT 1 FROM json_each(?) expected
      LEFT JOIN mint_burn_writer_epoch_hours h
        ON h.stablecoin_id = ? AND h.chain_id = ? AND h.hour_ts = expected.value
      WHERE h.revision IS NULL OR h.revision IS NOT ?)`;
  const guardBinds = [coinId, proof.chainId, proof.fromTimestamp - proof.fromTimestamp % 3600, proof.toTimestamp,
    JSON.stringify(proof.materialization?.hours ?? []), coinId, proof.chainId,
    proof.materialization?.revision ?? null];
  // SAFETY: All SQL fragments are source-owned; dynamic values use bindings.
  const epoch = db.prepare(`/* pharos:mint-burn-writer-epoch:merge */
    INSERT INTO mint_burn_writer_epoch_coverage
      (config_key, config_fingerprint, chain_id, stablecoin_id, writer_epoch, from_block, to_block, from_timestamp, to_timestamp)
    SELECT ?, ?, ?, ?, ?, MIN(from_block), MAX(to_block), MIN(from_timestamp), MAX(to_timestamp)
    FROM (SELECT from_block, to_block, from_timestamp, to_timestamp
      FROM mint_burn_writer_epoch_coverage WHERE ${match}
      UNION ALL SELECT ?, ?, ?, ?)
    HAVING NOT (${unsettled})
    ON CONFLICT(config_key, config_fingerprint, writer_epoch, from_block) DO UPDATE SET
      to_block = excluded.to_block, from_timestamp = excluded.from_timestamp, to_timestamp = excluded.to_timestamp`)
    .bind(proof.configKey, proof.configFingerprint, proof.chainId, coinId, MINT_BURN_WRITER_EPOCH, ...identity,
      proof.fromBlock, proof.toBlock, proof.fromTimestamp, proof.toTimestamp, ...guardBinds);
  const compact = db.prepare(`/* pharos:mint-burn-writer-epoch:compact */
    DELETE FROM mint_burn_writer_epoch_coverage WHERE ${match}
      AND from_block > (SELECT MIN(from_block) FROM mint_burn_writer_epoch_coverage WHERE ${match})
      AND NOT (${unsettled})`).bind(...identity, ...identity, ...guardBinds);
  const materialization = proof.materialization;
  const certifyHours = materialization?.hours.length ? [db.prepare(`/* pharos:mint-burn-writer-epoch:certify-hours */
    UPDATE mint_burn_writer_epoch_hours
    SET writer_epoch = ? WHERE stablecoin_id = ? AND chain_id = ? AND revision = ?
      AND hour_ts IN (SELECT value FROM json_each(?)) AND NOT (${unsettled})`)
    .bind(MINT_BURN_WRITER_EPOCH, coinId, proof.chainId, materialization.revision,
      JSON.stringify(materialization.hours), ...guardBinds)] : [];
  try {
    await db.batch([...before, ...scan, epoch, compact, ...certifyHours, ...after]);
  } catch (error) {
    // D1 rolls back the whole batch against a pre-migration database.
    if (!isMintBurnWriterEpochSchemaMissing(error)) throw error;
    await db.batch(legacy);
  }
}

export function prepareMintBurnWriterEpochCoverage(
  db: D1Database, configs: readonly MintBurnContractConfig[], start: number, end: number,
): D1PreparedStatement {
  const identities = JSON.stringify(configs.map((config) =>
    [mintBurnConfigKey(config), mintBurnScanFingerprint(config), config.chain.chainId, config.stablecoinId]));
  return db.prepare(`WITH scope AS (
      SELECT json_extract(value, '$[0]') AS config_key, json_extract(value, '$[1]') AS config_fingerprint,
        json_extract(value, '$[2]') AS chain_id, json_extract(value, '$[3]') AS stablecoin_id FROM json_each(?)
    )
    SELECT /* pharos:dews:mint-burn-writer-epoch */ c.config_key, c.from_block, c.to_block,
      c.from_timestamp, c.to_timestamp, c.writer_epoch, NULL AS dirty_hour_ts
    FROM scope JOIN mint_burn_writer_epoch_coverage c USING (config_key, config_fingerprint, chain_id, stablecoin_id)
    WHERE c.to_timestamp > ? AND c.from_timestamp < ?
    UNION ALL
    SELECT scope.config_key, 0, 0, h.hour_ts, h.hour_ts + 3600, NULL, h.hour_ts
    FROM scope JOIN mint_burn_writer_epoch_hours h USING (stablecoin_id, chain_id)
    WHERE h.hour_ts < ? AND h.hour_ts > ? - 3600
      AND (h.writer_epoch IS NULL OR EXISTS (
        SELECT 1 FROM mint_burn_writer_epoch_coverage c
        WHERE c.config_key = scope.config_key AND c.config_fingerprint = scope.config_fingerprint
          AND c.chain_id = h.chain_id AND c.writer_epoch != h.writer_epoch
          AND c.from_timestamp < h.hour_ts + 3600 AND c.to_timestamp > h.hour_ts))
    ORDER BY 1, 2`).bind(identities, start, end, end, start);
}

export interface MintBurnScanSegment {
  config_key: string;
  from_block: number;
  to_block: number;
  from_timestamp: number;
  to_timestamp: number;
  /** A debt row is evidence against admission, never a scan segment. */
  dirty_hour_ts?: number | null;
  /** Raw-read provenance only; older fingerprints cannot certify current coverage. */
  current_fingerprint?: number;
}

/** Materialized hours with revised receipt semantics must survive the legacy-writer invalidation triggers. */
export function mintBurnHourRevisionSql(alias: string): string {
  return `${alias}.writer_epoch = '${MINT_BURN_WRITER_EPOCH}' AND length(trim(${alias}.revision)) > 0`;
}

/** Include proof and materialization debt in the same snapshot as the certified data. */
export function prepareMintBurnScanCoverage(
  db: D1Database, configs: readonly MintBurnContractConfig[], fromTimestamp: number, toTimestamp: number,
): D1PreparedStatement {
  const identities = configs.map((config) =>
    [mintBurnConfigKey(config), mintBurnScanFingerprint(config), config.chain.chainId, config.stablecoinId]);
  const identitiesJson = JSON.stringify(identities);
  const revised = identities.filter(([, , , id]) => needsCurrentMintBurnReceiptClassification(id));
  // Include missing stamps on pre-migration materializations and tombstones left by deleted hours.
  const invalidRevisions = revised.length ? `UNION ALL
    SELECT json_extract(i.value, '$[0]'), 0, 0, h.hour_ts, h.hour_ts, h.hour_ts, 1
    FROM json_each(?) i JOIN mint_burn_hourly h
      ON h.stablecoin_id = json_extract(i.value, '$[3]') AND h.chain_id = json_extract(i.value, '$[2]')
    LEFT JOIN mint_burn_writer_epoch_hours stamp USING (stablecoin_id, chain_id, hour_ts)
    WHERE h.hour_ts >= ? AND h.hour_ts < ? AND stamp.hour_ts IS NULL
    UNION ALL
    SELECT json_extract(i.value, '$[0]'), 0, 0, stamp.hour_ts, stamp.hour_ts, stamp.hour_ts, 1
    FROM json_each(?) i JOIN mint_burn_writer_epoch_hours stamp
      ON stamp.stablecoin_id = json_extract(i.value, '$[3]') AND stamp.chain_id = json_extract(i.value, '$[2]')
    WHERE stamp.hour_ts >= ? AND stamp.hour_ts < ? AND (${mintBurnHourRevisionSql("stamp")}) IS NOT TRUE` : "";
  const revisionBinds = revised.length ? [JSON.stringify(revised), fromTimestamp, toTimestamp,
    JSON.stringify(revised), fromTimestamp, toTimestamp] : [];
  return db.prepare(`
    SELECT /* pharos:mint-burn-scan-coverage:read */
      c.config_key, c.from_block, c.to_block, c.from_timestamp, c.to_timestamp, NULL AS dirty_hour_ts,
      c.config_fingerprint = json_extract(i.value, '$[1]') AS current_fingerprint
    FROM json_each(?) i JOIN mint_burn_scan_coverage c
      ON c.config_key = json_extract(i.value, '$[0]') AND c.chain_id = json_extract(i.value, '$[2]')
    WHERE finality_tag = 'finalized' AND finalized_block >= to_block
      AND accepted_at >= to_timestamp AND to_timestamp >= ? AND from_timestamp <= ?
    UNION ALL
    SELECT json_extract(i.value, '$[0]') AS config_key, 0, 0, d.hour_ts, d.hour_ts, d.hour_ts AS dirty_hour_ts, 1
    FROM json_each(?) i JOIN mint_burn_dirty_hours d
      ON d.stablecoin_id = json_extract(i.value, '$[3]') AND d.chain_id = json_extract(i.value, '$[2]')
    WHERE d.hour_ts >= ? AND d.hour_ts < ?
    ${invalidRevisions}
    ORDER BY config_key, from_block
  `).bind(identitiesJson, fromTimestamp, toTimestamp, identitiesJson, fromTimestamp, toTimestamp, ...revisionBinds);
}

export function decodeMintBurnScanCoverage(
  result: D1Result<MintBurnScanSegment>,
): Map<string, MintBurnScanSegment[]> {
  const segments = new Map<string, MintBurnScanSegment[]>();
  for (const row of result.results) {
    if (row.current_fingerprint === 0) continue;
    const { current_fingerprint: _currentFingerprint, ...segment } = row;
    const existing = segments.get(segment.config_key) ?? [];
    existing.push(segment);
    segments.set(segment.config_key, existing);
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
