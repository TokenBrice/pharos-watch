import type { MintBurnPublication } from "@shared/types/mint-burn";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { MintBurnContractConfig } from "./mint-burn-contracts";
import { mintBurnConfigKey } from "./mint-burn-pipeline/sync-state";
import { mintBurnScanCoverageAdmits, mintBurnScanFingerprint, type MintBurnScanSegment } from "./mint-burn-pipeline/scan-coverage";
import grandfatheredConfigKeys from "./mint-burn-pipeline/grandfathered-config-keys.json";
import { FLOW_CACHE_PREFIX } from "./mint-burn-flow-cache-keys";
import { batchExecute, executeAtomicBatch } from "./db";

/** netFlow90dUsd is the longest published aggregate. */
export const MINT_BURN_ADMISSION_BASELINE_SEC = 90 * DAY_SECONDS;
// Immutable pre-admission roster, not a claim that legacy history is durable-v2.
const grandfathered = new Set(grandfatheredConfigKeys);

export function isGrandfatheredMintBurnConfig(config: MintBurnContractConfig): boolean {
  return grandfathered.has(mintBurnConfigKey(config));
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
  return db.prepare("SELECT disabled_keys, paused_keys FROM mint_burn_publication_policy WHERE id = 1");
}

export function decodeMintBurnDisabledKeys(policy: string): Set<string> {
  const keys: unknown = JSON.parse(policy);
  if (!Array.isArray(keys) || !keys.every((key) => typeof key === "string")) {
    throw new Error("Invalid mint/burn publication policy");
  }
  return new Set(keys);
}

/** The scheduled runtime is the authority for the env switch; readers share its durable policy. */
export async function syncMintBurnPublicationPolicy(
  db: D1Database, keys: Iterable<string>, now: number, activeKeys?: Iterable<string>,
): Promise<void> {
  const disabled = new Set(keys);
  const policy = JSON.stringify([...disabled].sort());
  const active = activeKeys == null ? null : new Set([...activeKeys].filter((key) => !disabled.has(key)));
  const activeJson = active == null ? null : JSON.stringify([...active]);
  // Grandfathered keys have no admission row, so a key that leaves the active roster
  // is paused explicitly and re-enters through the same reactivation catch-up.
  const inactiveGrandfathered = active == null ? []
    : [...grandfathered].filter((key) => !active.has(key));
  const paused = JSON.stringify([...disabled]);
  const pauseCandidatesSql = `SELECT value AS config_key FROM json_each(?)
    UNION SELECT config_key FROM mint_burn_admission
      WHERE ? IS NOT NULL AND config_key NOT IN (SELECT value FROM json_each(?))
    UNION SELECT value FROM json_each(?)`;
  await executeAtomicBatch(db, [
    db.prepare(`DELETE FROM cache WHERE key >= ? AND key < ?
      AND COALESCE((SELECT disabled_keys FROM mint_burn_publication_policy WHERE id = 1), '[]') != ?`)
      .bind(`${FLOW_CACHE_PREFIX}:`, `${FLOW_CACHE_PREFIX}:\uffff`, policy),
    // A pause for a key that is gone from the active, admission and grandfathered
    // rosters can never be cleared by a scan, so drop it instead of withholding
    // retained history.
    db.prepare(`INSERT INTO mint_burn_publication_policy (id, disabled_keys, paused_keys, updated_at)
      VALUES (1, ?, (SELECT json_group_array(config_key) FROM (${pauseCandidatesSql})), ?)
      ON CONFLICT(id) DO UPDATE SET disabled_keys = excluded.disabled_keys, updated_at = excluded.updated_at,
        paused_keys = (SELECT json_group_array(value) FROM (
          SELECT value FROM json_each(mint_burn_publication_policy.paused_keys) AS prior
          WHERE ? IS NULL
            OR prior.value IN (SELECT value FROM json_each(?))
            OR prior.value IN (SELECT value FROM json_each(?))
          UNION SELECT value FROM json_each(excluded.paused_keys)
        ))`).bind(policy, paused, activeJson, activeJson, JSON.stringify(inactiveGrandfathered),
          now, activeJson, activeJson, policy),
  ]);
}

export function mintBurnPreviouslyAdmitted(
  config: MintBurnContractConfig, rows: readonly MintBurnAdmissionRow[],
): MintBurnAdmissionRow | "grandfathered" | null {
  const key = mintBurnConfigKey(config);
  return rows.find((row) => row.config_key === key) ?? (grandfathered.has(key) ? "grandfathered" : null);
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

/**
 * R8/ADR-35: an admitted leg whose accepted frontier exceeds the shared publication
 * freshness budget leaves the common watermark instead of freezing every coin. The
 * caller pauses the returned keys; only the existing reactivation catch-up resumes them.
 */
export function selectMintBurnStalledFrontiers(
  configs: readonly MintBurnContractConfig[],
  segments: ReadonlyMap<string, readonly MintBurnScanSegment[]>,
  legacy: ReadonlyMap<string, { end: number }>,
  now: number, freshnessBudgetSec: number,
): MintBurnContractConfig[] {
  return configs.filter((config) => {
    const key = mintBurnConfigKey(config);
    const proof = (segments.get(key) ?? []).filter((row) => row.dirty_hour_ts == null);
    const frontier = Math.max(legacy.get(key)?.end ?? 0, ...proof.map((row) => row.to_timestamp));
    // Hour-aligned like the watermark, so a leg is quarantined exactly when it alone would stale it.
    return frontier > 0 && now - Math.floor(frontier / 3600) * 3600 > freshnessBudgetSec;
  });
}

export function resolveMintBurnPublication(
  configs: readonly MintBurnContractConfig[], rows: readonly MintBurnAdmissionRow[],
  disabledKeys: ReadonlySet<string>, segments: ReadonlyMap<string, readonly MintBurnScanSegment[]>,
  now: number, targetEnd: number, freshnessBudgetSec: number,
  pausedKeys: ReadonlySet<string> = new Set(),
) {
  const admittedConfigs: MintBurnContractConfig[] = [];
  const newAdmissions: MintBurnAdmissionRow[] = [];
  const publication: MintBurnPublication = {
    evaluatedAt: now, requiredBaselineSec: MINT_BURN_ADMISSION_BASELINE_SEC, freshnessBudgetSec, legs: [],
  };
  const pairOf = (config: MintBurnContractConfig) => `${config.stablecoinId}|${config.chain.chainId}`;
  const reactivationPendingPairs = new Set(configs.filter((config) => {
    const key = mintBurnConfigKey(config);
    if (!pausedKeys.has(key) || !mintBurnPreviouslyAdmitted(config, rows)) return false;
    const proof = (segments.get(key) ?? []).filter((row) => row.dirty_hour_ts == null);
    const frontier = Math.max(0, ...proof.map((row) => row.to_timestamp));
    return frontier === 0 || now - frontier > freshnessBudgetSec
      || !mintBurnScanCoverageAdmits([config], segments, targetEnd - 3600, targetEnd);
  }).map(pairOf));
  const resumedKeys: string[] = [];
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
    const reactivating = reactivationPendingPairs.has(pairOf(config));
    const reason = disabledReason ?? (unsupportedSibling ? "unsupported-shared-bucket"
      : reactivating ? "reactivation-pending"
      : prior === "grandfathered" ? "legacy-grandfathered"
      : prior ? null
      : frontier == null ? "proof-unavailable"
      : frontierAgeSec! > freshnessBudgetSec ? "frontier-stale"
      : !baselineComplete ? "baseline-incomplete" : null);
    const admitted = !disabled && !reactivating && (prior != null || reason == null);
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
    if (prior && pausedKeys.has(key)) resumedKeys.push(key);
    if (!prior) newAdmissions.push({ config_key: key, config_fingerprint: fingerprint, admitted_at: now,
      baseline_from: from, baseline_to: targetEnd });
  }
  return { configs: admittedConfigs, publication, newAdmissions, resumedKeys };
}

/** Public responses retain exact scope and pending evidence without the admitted diagnostic roster. */
export function compactMintBurnPublication(publication: MintBurnPublication): MintBurnPublication {
  const admitted = publication.legs.filter((leg) => leg.status === "admitted");
  return {
    evaluatedAt: publication.evaluatedAt,
    requiredBaselineSec: publication.requiredBaselineSec,
    freshnessBudgetSec: publication.freshnessBudgetSec,
    legsScope: "non-admitted",
    legCount: publication.legs.length,
    admittedCount: admitted.length,
    pendingAdmissionCount: publication.legs.filter((leg) => leg.status === "pending-admission").length,
    disabledCount: publication.legs.filter((leg) => leg.status === "disabled").length,
    admittedPairs: [...new Map(admitted.map((leg) => [JSON.stringify([leg.stablecoinId, leg.chainId]),
      [leg.stablecoinId, leg.chainId] as [string, string]])).values()],
    legs: publication.legs.filter((leg) => leg.status !== "admitted"),
  };
}

export async function persistMintBurnResumptions(db: D1Database, keys: readonly string[], policy: string) {
  if (keys.length === 0) return;
  await executeAtomicBatch(db, [db.prepare(`UPDATE mint_burn_publication_policy SET paused_keys = (
    SELECT json_group_array(value) FROM json_each(paused_keys)
    WHERE value NOT IN (SELECT value FROM json_each(?))
  ) WHERE id = 1 AND disabled_keys = ?`).bind(JSON.stringify(keys), policy)]);
}

/** A stalled admitted key joins the durable pause so proof alone cannot re-admit it. */
export async function persistMintBurnQuarantines(db: D1Database, keys: readonly string[], policy: string) {
  if (keys.length === 0) return;
  await executeAtomicBatch(db, [db.prepare(`UPDATE mint_burn_publication_policy SET paused_keys = (
    SELECT json_group_array(value) FROM (
      SELECT value FROM json_each(paused_keys)
      UNION SELECT value FROM json_each(?)
    )
  ) WHERE id = 1 AND disabled_keys = ?`).bind(JSON.stringify(keys), policy)]);
}

export async function persistMintBurnAdmissions(db: D1Database, rows: readonly MintBurnAdmissionRow[]) {
  if (rows.length === 0) return;
  await batchExecute(db, rows.map((row) => db.prepare(`INSERT OR IGNORE INTO mint_burn_admission
    (config_key, config_fingerprint, admitted_at, baseline_from, baseline_to) VALUES (?, ?, ?, ?, ?)`)
    .bind(row.config_key, row.config_fingerprint, row.admitted_at, row.baseline_from, row.baseline_to)));
}
