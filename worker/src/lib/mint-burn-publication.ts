import type { MintBurnPublication } from "@shared/types/mint-burn";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { MintBurnContractConfig } from "./mint-burn-contracts";
import { mintBurnConfigKey } from "./mint-burn-pipeline/sync-state";
import { mintBurnScanCoverageAdmits, mintBurnScanFingerprint, type MintBurnScanSegment } from "./mint-burn-pipeline/scan-coverage";
import grandfatheredFingerprints from "./mint-burn-pipeline/legacy-cutover-fingerprints.json";
import { FLOW_CACHE_PREFIX } from "./mint-burn-flow-cache-keys";
import { batchExecute, executeAtomicBatch } from "./db";

/** netFlow90dUsd is the longest published aggregate. */
export const MINT_BURN_ADMISSION_BASELINE_SEC = 90 * DAY_SECONDS;
// Immutable pre-admission roster, not a claim that legacy history is durable-v2.
const grandfathered = new Set(grandfatheredFingerprints);

export function isGrandfatheredMintBurnConfig(config: MintBurnContractConfig): boolean {
  return grandfathered.has(mintBurnScanFingerprint(config));
}

export function mintBurnDisabledReason(
  config: MintBurnContractConfig, disabledIds: ReadonlySet<string>, disabledSymbols: ReadonlySet<string>,
): string | null {
  if (config.enabled === false) return "config-disabled";
  if (disabledSymbols.has(config.symbol.toUpperCase())) return "symbol-disabled";
  if (disabledIds.has(config.stablecoinId.toLowerCase()) || disabledIds.has(mintBurnConfigKey(config).toLowerCase())) {
    return "id-disabled";
  }
  return null;
}

export interface MintBurnAdmissionRow {
  config_key: string;
  config_fingerprint: string;
  admitted_at: number;
  baseline_from: number;
  baseline_to: number;
}

export function prepareMintBurnAdmissions(db: D1Database) {
  return db.prepare("SELECT config_key, config_fingerprint, admitted_at, baseline_from, baseline_to FROM mint_burn_admission");
}

export function prepareMintBurnPublicationPolicy(db: D1Database) {
  return db.prepare("SELECT disabled_keys FROM mint_burn_publication_policy WHERE id = 1");
}

export function decodeMintBurnDisabledKeys(policy: string): Set<string> {
  const keys: unknown = JSON.parse(policy);
  if (!Array.isArray(keys) || !keys.every((key) => typeof key === "string")) {
    throw new Error("Invalid mint/burn publication policy");
  }
  return new Set(keys);
}

/** The scheduled runtime is the authority for the env switch; readers share its durable policy. */
export async function syncMintBurnPublicationPolicy(db: D1Database, keys: Iterable<string>, now: number): Promise<void> {
  const policy = JSON.stringify([...new Set(keys)].sort());
  await executeAtomicBatch(db, [
    db.prepare(`DELETE FROM cache WHERE key >= ? AND key < ?
      AND COALESCE((SELECT disabled_keys FROM mint_burn_publication_policy WHERE id = 1), '[]') != ?`)
      .bind(`${FLOW_CACHE_PREFIX}:`, `${FLOW_CACHE_PREFIX}:\uffff`, policy),
    db.prepare(`INSERT INTO mint_burn_publication_policy (id, disabled_keys, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET disabled_keys = excluded.disabled_keys, updated_at = excluded.updated_at
      WHERE mint_burn_publication_policy.disabled_keys != excluded.disabled_keys`).bind(policy, now),
  ]);
}

export function mintBurnPreviouslyAdmitted(
  config: MintBurnContractConfig, rows: readonly MintBurnAdmissionRow[],
): MintBurnAdmissionRow | "grandfathered" | null {
  const fingerprint = mintBurnScanFingerprint(config);
  return rows.find((row) => row.config_key === mintBurnConfigKey(config) && row.config_fingerprint === fingerprint)
    ?? (grandfathered.has(fingerprint) ? "grandfathered" : null);
}

export function mintBurnPublicationDisabled(
  config: MintBurnContractConfig, configs: readonly MintBurnContractConfig[],
  rows: readonly MintBurnAdmissionRow[], disabledKeys: ReadonlySet<string>,
): "operator-disabled" | "shared-bucket-disabled" | null {
  if (config.enabled === false || disabledKeys.has(mintBurnConfigKey(config))) return "operator-disabled";
  // shortcut: legacy hours have no contract attribution; split storage before individual sibling rollback.
  return configs.some((sibling) => sibling.stablecoinId === config.stablecoinId
    && sibling.chain.chainId === config.chain.chainId && mintBurnPreviouslyAdmitted(sibling, rows)
    && (sibling.enabled === false || disabledKeys.has(mintBurnConfigKey(sibling))))
    ? "shared-bucket-disabled" : null;
}

export function resolveMintBurnPublication(
  configs: readonly MintBurnContractConfig[], rows: readonly MintBurnAdmissionRow[],
  disabledKeys: ReadonlySet<string>, segments: ReadonlyMap<string, readonly MintBurnScanSegment[]>,
  now: number, targetEnd: number, freshnessBudgetSec: number,
) {
  const admittedConfigs: MintBurnContractConfig[] = [];
  const newAdmissions: MintBurnAdmissionRow[] = [];
  const publication: MintBurnPublication = {
    evaluatedAt: now, requiredBaselineSec: MINT_BURN_ADMISSION_BASELINE_SEC, freshnessBudgetSec, legs: [],
  };
  for (const config of configs) {
    const key = mintBurnConfigKey(config);
    const fingerprint = mintBurnScanFingerprint(config);
    const prior = mintBurnPreviouslyAdmitted(config, rows);
    const proof = (segments.get(key) ?? []).filter((row) => row.dirty_hour_ts == null);
    const frontier = proof.length ? Math.max(...proof.map((row) => row.to_timestamp)) : null;
    const frontierAgeSec = frontier == null ? null : Math.max(0, now - frontier);
    const from = targetEnd - MINT_BURN_ADMISSION_BASELINE_SEC;
    const baselineComplete = mintBurnScanCoverageAdmits([config], segments, from, targetEnd);
    const disabledReason = mintBurnPublicationDisabled(config, configs, rows, disabledKeys);
    const unsupportedSibling = !prior && configs.some((sibling) => mintBurnConfigKey(sibling) !== key
      && sibling.stablecoinId === config.stablecoinId && sibling.chain.chainId === config.chain.chainId);
    const disabled = disabledReason != null;
    const reason = disabledReason ?? (unsupportedSibling ? "unsupported-shared-bucket"
      : prior === "grandfathered" ? "legacy-grandfathered"
      : prior ? null
      : frontier == null ? "proof-unavailable"
      : frontierAgeSec! > freshnessBudgetSec ? "frontier-stale"
      : !baselineComplete ? "baseline-incomplete" : null);
    const admitted = !disabled && (prior != null || reason == null);
    // Ledger segments are compacted by contiguous blocks. Progress is the observed tail, not event age.
    const tail = proof.find((row) => row.to_timestamp === frontier);
    publication.legs.push({
      configKey: key, configFingerprint: fingerprint, stablecoinId: config.stablecoinId, chainId: config.chain.chainId,
      status: disabled ? "disabled" : admitted ? "admitted" : "pending-admission", reason,
      admittedAt: prior && prior !== "grandfathered" ? prior.admitted_at : admitted && !prior ? now : null,
      baselineFrom: prior && prior !== "grandfathered" ? prior.baseline_from : tail?.from_timestamp ?? null,
      baselineTo: prior && prior !== "grandfathered" ? prior.baseline_to : frontier,
      coveredSeconds: tail ? Math.max(0, tail.to_timestamp - tail.from_timestamp) : null,
      frontierAgeSec,
    });
    if (!admitted) continue;
    admittedConfigs.push(config);
    if (!prior) newAdmissions.push({ config_key: key, config_fingerprint: fingerprint, admitted_at: now,
      baseline_from: from, baseline_to: targetEnd });
  }
  return { configs: admittedConfigs, publication, newAdmissions };
}

export async function persistMintBurnAdmissions(db: D1Database, rows: readonly MintBurnAdmissionRow[]) {
  if (rows.length === 0) return;
  await batchExecute(db, rows.map((row) => db.prepare(`INSERT OR IGNORE INTO mint_burn_admission
    (config_key, config_fingerprint, admitted_at, baseline_from, baseline_to) VALUES (?, ?, ?, ?, ?)`)
    .bind(row.config_key, row.config_fingerprint, row.admitted_at, row.baseline_from, row.baseline_to)));
}
