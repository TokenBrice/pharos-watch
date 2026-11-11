import { throwIfAborted } from "../abort";
import { executeAtomicBatch } from "../db";
import { buildInClause, D1_SAFE_IN_CLAUSE_BIND_LIMIT } from "../d1-primitives";
import type { MintBurnPersistenceOptions } from "./persistence";
import type { MintBurnRow } from "./types";
import { MINT_BURN_EVENT_RETENTION_SEC } from "./mint-burn-retention-config";

/** Shared authorization for hourly totals, event lists and Tape claims. */
export function mintBurnSupplyProofAcceptedSql(alias = "mint_burn_events"): string {
  return `(${alias}.supply_proof_id IS NULL OR EXISTS (SELECT 1 FROM mint_burn_supply_proofs proof
    WHERE proof.proof_id = ${alias}.supply_proof_id AND proof.status = 'proven' AND proof.lifecycle = 'accepted'))`;
}

export interface MintBurnSupplyProofEvidence {
  proofId: string;
  configKey: string;
  configFingerprint: string;
  lawRevision: string;
  chainId: string;
  stablecoinId: string;
  tokenAddress: string;
  decimals: number;
  fromBlock: number;
  toBlock: number;
  openingBlock: number;
  closingBlock: number;
  openingHash?: string;
  closingHash?: string;
  openingTimestamp?: number;
  closingTimestamp?: number;
  guardValues?: { from: Readonly<Record<string, string>>; to: Readonly<Record<string, string>> };
  openingSupplyRaw?: string;
  closingSupplyRaw?: string;
  mintRaw?: string;
  zeroRaw?: string;
  deltaRaw?: string;
  residualRaw?: string;
  eventSetDigest?: string;
  mintEvidence: "source-only" | "require-empty";
  status: "proven" | "residual" | "unavailable";
  reason?: string;
  checkedAt: number;
  members: Array<{ id: string; direction: "mint" | "burn"; amountRaw: string; blockNumber: number; blockHash: string }>;
}

export async function persistMintBurnSupplyProof(
  db: D1Database,
  proof: MintBurnSupplyProofEvidence,
  options: MintBurnPersistenceOptions = {},
): Promise<void> {
  throwIfAborted(options.signal);
  // Uncertainty is carried by the real event rows, including dust. Quiet scans
  // and failed witnesses authorize no members and need no proof-table row.
  if (proof.status !== "proven" || proof.members.length === 0) return;
  await db.prepare(`INSERT OR IGNORE INTO mint_burn_supply_proof_configs (config_key, config_fingerprint)
    VALUES (?, ?)`).bind(proof.configKey, proof.configFingerprint).run();
  const evidence = JSON.stringify(proof);
  await db.prepare(`INSERT OR IGNORE INTO mint_burn_supply_proofs
    (proof_id, config_key, config_fingerprint, from_block, to_block, status, reason, evidence_json, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(proof.proofId, proof.configKey, proof.configFingerprint, proof.fromBlock, proof.toBlock,
      proof.status, proof.reason ?? null, evidence, proof.checkedAt).run();
  throwIfAborted(options.signal);
  const stored = await db.prepare("SELECT evidence_json FROM mint_burn_supply_proofs WHERE proof_id = ?")
    .bind(proof.proofId).first<{ evidence_json: string }>();
  if (stored?.evidence_json !== evidence) throw new Error("supply-proof-immutable-evidence-mismatch");
}

export async function acceptMintBurnSupplyProof(
  db: D1Database,
  proof: MintBurnSupplyProofEvidence,
  rows: MintBurnRow[],
  options: MintBurnPersistenceOptions = {},
): Promise<boolean> {
  if (proof.status !== "proven") return false;
  throwIfAborted(options.signal);
  if (proof.members.length === 0) return rows.length === 0;
  const members = new Map(proof.members.map((member) => [member.id, member]));
  for (const row of rows) {
    const member = members.get(row.id);
    if (!member || row.supply_proof_id !== proof.proofId || row.amount_raw !== member.amountRaw ||
      row.direction !== member.direction || row.block_number !== member.blockNumber ||
      row.stablecoin_id !== proof.stablecoinId || row.chain_id !== proof.chainId) {
      throw new Error("supply-proof-member-mismatch");
    }
  }
  if (!await verifyMintBurnSupplyProofRows(db, rows, options.signal)) return false;
  // The accepted state is the authorization. Pending chunks can only materialize
  // unresolved counts; the final authorization enqueues every referenced hour.
  const results = await executeAtomicBatch(db, [
    db.prepare(`UPDATE mint_burn_supply_proofs SET lifecycle = 'accepted'
      WHERE proof_id = ? AND evidence_json = ? AND status = 'proven' AND lifecycle = 'pending'
        AND EXISTS (SELECT 1 FROM mint_burn_supply_proof_configs config
          WHERE config.config_key = mint_burn_supply_proofs.config_key
            AND config.config_fingerprint = mint_burn_supply_proofs.config_fingerprint)`)
      .bind(proof.proofId, JSON.stringify(proof)),
    db.prepare(`INSERT OR REPLACE INTO mint_burn_dirty_hours (stablecoin_id, chain_id, hour_ts)
      SELECT stablecoin_id, chain_id, (timestamp / 3600) * 3600 FROM mint_burn_events
      WHERE supply_proof_id = ? AND EXISTS (SELECT 1 FROM mint_burn_supply_proofs
        WHERE proof_id = ? AND lifecycle = 'accepted' AND status = 'proven')
      GROUP BY stablecoin_id, chain_id, (timestamp / 3600) * 3600`)
      .bind(proof.proofId, proof.proofId),
  ], { signal: options.signal, returnResults: true });
  if (Number(results[0]?.meta?.changes) > 0) return true;
  const stored = await db.prepare(`SELECT proof.lifecycle, proof.evidence_json FROM mint_burn_supply_proofs proof
    JOIN mint_burn_supply_proof_configs config ON config.config_key = proof.config_key
      AND config.config_fingerprint = proof.config_fingerprint WHERE proof.proof_id = ?`)
    .bind(proof.proofId).first<{ lifecycle: string; evidence_json: string }>();
  return stored?.lifecycle === "accepted" && stored.evidence_json === JSON.stringify(proof);
}

async function invalidateSupplyProofs(
  db: D1Database,
  configKey: string,
  fromBlock: number,
  toBlock: number,
  reason: string,
  checkedAt: number,
  options: MintBurnPersistenceOptions,
  nextFingerprint?: string,
): Promise<number> {
  throwIfAborted(options.signal);
  const retainedHour = Math.ceil((Math.floor(Date.now() / 1000) - MINT_BURN_EVENT_RETENTION_SEC) / 3600) * 3600;
  const proofIds = `SELECT proof_id FROM mint_burn_supply_proofs
    WHERE lifecycle != 'invalidated' AND config_key = ? AND from_block <= ? AND to_block >= ?`;
  const binds = [configKey, toBlock, fromBlock];
  const mutations = [
    db.prepare(`INSERT OR REPLACE INTO mint_burn_dirty_hours (stablecoin_id, chain_id, hour_ts)
      SELECT stablecoin_id, chain_id, (timestamp / 3600) * 3600 FROM mint_burn_events
      WHERE supply_proof_id IN (${proofIds}) AND timestamp >= ?
      GROUP BY stablecoin_id, chain_id, (timestamp / 3600) * 3600`).bind(...binds, retainedHour),
    db.prepare(`UPDATE mint_burn_events SET burn_type = 'review_required', burn_review_reason = ?
      WHERE supply_proof_id IN (${proofIds}) AND timestamp >= ?`).bind(reason, ...binds, retainedHour),
    // Coverage is the durable historical gate even after proofs and raw siblings expire.
    db.prepare(`UPDATE mint_burn_scan_coverage
      SET config_fingerprint = config_fingerprint || ':supply-proof-invalidated:' || ? || ':' || rowid
      WHERE config_key = ? AND from_block <= ? AND to_block >= ?
        AND instr(config_fingerprint, ':supply-proof-invalidated:') = 0`)
      .bind(checkedAt, ...binds),
    db.prepare(`UPDATE mint_burn_supply_proofs
      SET lifecycle = 'invalidated', invalidated_at = ?, invalidation_reason = ?
      WHERE lifecycle != 'invalidated' AND config_key = ? AND from_block <= ? AND to_block >= ?`)
      .bind(checkedAt, reason, ...binds),
  ];
  if (nextFingerprint != null) mutations.push(db.prepare(`INSERT INTO mint_burn_supply_proof_configs
    (config_key, config_fingerprint) VALUES (?, ?)
    ON CONFLICT(config_key) DO UPDATE SET config_fingerprint = excluded.config_fingerprint`)
    .bind(configKey, nextFingerprint));
  const results = await executeAtomicBatch(db, mutations, { signal: options.signal, returnResults: true });
  // A changed identity also invalidates cached responses when every source row is gone.
  return Math.max(nextFingerprint == null ? 0 : 1, ...results.slice(0, 4).map((result) => Number(result.meta.changes)));
}

export async function invalidateMintBurnSupplyProofs(
  db: D1Database,
  configKey: string,
  currentFingerprint: string,
  options: MintBurnPersistenceOptions = {},
): Promise<number> {
  throwIfAborted(options.signal);
  const stored = await db.prepare(`SELECT config_fingerprint FROM mint_burn_supply_proof_configs WHERE config_key = ?`)
    .bind(configKey).first<{ config_fingerprint: string }>();
  if (!stored) {
    await db.prepare(`INSERT OR IGNORE INTO mint_burn_supply_proof_configs (config_key, config_fingerprint)
      VALUES (?, ?)`).bind(configKey, currentFingerprint).run();
    return 0;
  }
  return stored.config_fingerprint === currentFingerprint ? 0
    : invalidateSupplyProofs(db, configKey, 1, Number.MAX_SAFE_INTEGER, "range-supply-proof-config-changed",
      Math.floor(Date.now() / 1000), options, currentFingerprint);
}

/** Compare the full reviewed family against durable identities, not expiring proof rows. */
export async function invalidateChangedMintBurnSupplyProofConfigs(
  db: D1Database,
  currentFingerprints: ReadonlyMap<string, string>,
  options: MintBurnPersistenceOptions = {},
): Promise<number> {
  throwIfAborted(options.signal);
  const stored = await db.prepare(`SELECT config_key, config_fingerprint FROM mint_burn_supply_proof_configs`)
    .all<{ config_key: string; config_fingerprint: string }>();
  let invalidated = 0;
  for (const row of stored.results) {
    const fingerprint = currentFingerprints.get(row.config_key) ?? "removed";
    if (row.config_fingerprint === fingerprint) continue;
    invalidated += await invalidateSupplyProofs(db, row.config_key, 1, Number.MAX_SAFE_INTEGER,
      fingerprint === "removed" ? "range-supply-proof-config-removed" : "range-supply-proof-config-changed",
      Math.floor(Date.now() / 1000), options, fingerprint);
  }
  const existing = new Set(stored.results.map((row) => row.config_key));
  for (const [key, fingerprint] of currentFingerprints) {
    if (existing.has(key)) continue;
    throwIfAborted(options.signal);
    await db.prepare(`INSERT OR IGNORE INTO mint_burn_supply_proof_configs (config_key, config_fingerprint)
      VALUES (?, ?)`).bind(key, fingerprint).run();
  }
  return invalidated;
}

export function invalidateMintBurnSupplyProofRange(
  db: D1Database,
  configKey: string,
  fromBlock: number,
  toBlock: number,
  reason: string,
  checkedAt: number,
  options: MintBurnPersistenceOptions = {},
): Promise<number> {
  return invalidateSupplyProofs(db, configKey, fromBlock, toBlock, reason, checkedAt, options);
}

/** A complete canonical replay also checks proof members that disappeared in a reorg. */
export async function invalidateConflictingMintBurnSupplyProofs(
  db: D1Database,
  proof: MintBurnSupplyProofEvidence,
  options: MintBurnPersistenceOptions = {},
): Promise<{ invalidated: number; conflict: boolean; reason?: string }> {
  throwIfAborted(options.signal);
  // Retry clocks are not new witnesses; group identical immutable evidence.
  const stored = await db.prepare(`SELECT MIN(evidence_json) AS evidence_json, from_block
    FROM mint_burn_supply_proofs
    WHERE config_key = ? AND status = 'proven' AND lifecycle IN ('pending', 'accepted')
      AND from_block <= ? AND to_block >= ?
    GROUP BY config_fingerprint, from_block, to_block,
      json_extract(CASE WHEN json_valid(evidence_json) THEN evidence_json ELSE '{}' END, '$.openingHash'), json_extract(CASE WHEN json_valid(evidence_json) THEN evidence_json ELSE '{}' END, '$.closingHash'),
      json_extract(CASE WHEN json_valid(evidence_json) THEN evidence_json ELSE '{}' END, '$.eventSetDigest')
    ORDER BY from_block, evidence_json LIMIT 101`)
    .bind(proof.configKey, proof.toBlock + 1, proof.fromBlock - 1)
    .all<{ evidence_json: string; from_block: number }>();
  throwIfAborted(options.signal);
  if (stored.results.length > 100) {
    return { invalidated: 0, conflict: false, reason: "supply-proof-conflict-check-limit" };
  }
  const currentMembers = new Map(proof.members.map((member) => [member.id, member]));
  const boundaryHashes = new Map<number, string>();
  if (proof.openingHash) boundaryHashes.set(proof.openingBlock, proof.openingHash.toLowerCase());
  if (proof.closingHash) boundaryHashes.set(proof.closingBlock, proof.closingHash.toLowerCase());
  let earliestConflict = Infinity;
  let reason = "range-supply-proof-canonical-conflict";
  for (const row of stored.results) {
    let previous: MintBurnSupplyProofEvidence;
    try {
      previous = JSON.parse(row.evidence_json) as MintBurnSupplyProofEvidence;
      if (!Array.isArray(previous.members)) throw new Error("invalid-members");
    } catch {
      earliestConflict = Math.min(earliestConflict, row.from_block - 1);
      reason = "supply-proof-stored-evidence-invalid";
      continue;
    }
    for (const [block, hash] of [[previous.openingBlock, previous.openingHash],
      [previous.closingBlock, previous.closingHash]] as const) {
      if (hash && boundaryHashes.has(block) && hash.toLowerCase() !== boundaryHashes.get(block)) {
        earliestConflict = Math.min(earliestConflict, block);
      }
    }
    for (const member of previous.members) {
      const current = currentMembers.get(member.id);
      if (current && (member.direction !== current.direction || member.amountRaw !== current.amountRaw ||
        member.blockNumber !== current.blockNumber || member.blockHash.toLowerCase() !== current.blockHash.toLowerCase())) {
        earliestConflict = Math.min(earliestConflict, member.blockNumber, current.blockNumber);
      } else if (!current && proof.eventSetDigest != null &&
        member.blockNumber >= proof.fromBlock && member.blockNumber <= proof.toBlock) {
        earliestConflict = Math.min(earliestConflict, member.blockNumber);
      }
    }
  }
  if (!Number.isFinite(earliestConflict)) return { invalidated: 0, conflict: false };
  const invalidated = await invalidateMintBurnSupplyProofRange(db, proof.configKey,
    Math.max(1, earliestConflict), Number.MAX_SAFE_INTEGER, reason, proof.checkedAt, options);
  return { invalidated, conflict: true, reason };
}

/** Verify raw/proof identity again before a pending proof becomes accepted. */
async function verifyMintBurnSupplyProofRows(
  db: D1Database,
  rows: MintBurnRow[],
  signal?: AbortSignal,
): Promise<boolean> {
  for (let offset = 0; offset < rows.length; offset += D1_SAFE_IN_CLAUSE_BIND_LIMIT) {
    throwIfAborted(signal);
    const expected = rows.slice(offset, offset + D1_SAFE_IN_CLAUSE_BIND_LIMIT);
    const clause = buildInClause(expected.map((row) => row.id));
    const result = await db.prepare(`SELECT id, supply_proof_id, amount_raw FROM mint_burn_events WHERE id IN (${clause.sql})`)
      .bind(...clause.binds).all<{ id: string; supply_proof_id: string | null; amount_raw: string | null }>();
    const actual = new Map((result.results ?? []).map((row) => [row.id, row]));
    if (actual.size !== expected.length || expected.some((row) => actual.get(row.id)?.supply_proof_id !== row.supply_proof_id ||
      actual.get(row.id)?.amount_raw !== row.amount_raw)) return false;
  }
  return true;
}
