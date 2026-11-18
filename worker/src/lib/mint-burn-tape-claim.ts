/** Large-flow Tape claim eligibility, shared by the projector, store write guard and retention. */
import { MINT_BURN_CONFIGS } from "./mint-burn-contracts";
import { mintBurnConfigKey } from "./mint-burn-contract-identity";
import { needsCurrentMintBurnReceiptClassification } from "./mint-burn-published-gauge";
import { mintBurnHourRevisionSql, mintBurnScanFingerprint } from "./mint-burn-pipeline/scan-coverage";
import { mintBurnSupplyProofAcceptedSql } from "./mint-burn-supply-proofs";

const MINT_BURN_TAPE_NOTICE_USD = 10_000_000;
const NOTICE_USD = MINT_BURN_TAPE_NOTICE_USD;

/** Counted event rows for revised pairs require finalized proof of the event's whole hour. */
export function mintBurnReceiptClassifiedEventSql(alias: string): string {
  const hour = `(${alias}.timestamp - ${alias}.timestamp % 3600)`;
  // Registry-authored identities. The coverage writer merges contiguous block ranges.
  const revised = MINT_BURN_CONFIGS.filter((config) => needsCurrentMintBurnReceiptClassification(config.stablecoinId));
  if (!revised.length) return "1";
  const identities = revised.map((config) =>
    `('${config.stablecoinId}', '${config.chain.chainId}', '${mintBurnConfigKey(config)}', '${mintBurnScanFingerprint(config)}')`,
  ).join(", ");
  return `NOT EXISTS (
    SELECT 1 FROM (VALUES ${identities}) AS revised
    WHERE revised.column1 = ${alias}.stablecoin_id AND revised.column2 = ${alias}.chain_id
      AND (EXISTS (SELECT 1 FROM mint_burn_dirty_hours AS dirty
        WHERE dirty.stablecoin_id = ${alias}.stablecoin_id AND dirty.chain_id = ${alias}.chain_id AND dirty.hour_ts = ${hour})
        OR NOT EXISTS (SELECT 1 FROM mint_burn_writer_epoch_hours stamp
          WHERE stamp.stablecoin_id = revised.column1 AND stamp.chain_id = revised.column2
            AND stamp.hour_ts = ${hour} AND ${mintBurnHourRevisionSql("stamp")})
        OR NOT EXISTS (SELECT 1 FROM mint_burn_scan_coverage AS proof
          WHERE revised.column3 = proof.config_key AND revised.column4 = proof.config_fingerprint
            AND proof.chain_id = revised.column2 AND proof.finality_tag = 'finalized'
            AND proof.finalized_block >= proof.to_block AND proof.accepted_at >= proof.to_timestamp
            AND proof.from_timestamp <= ${hour} AND proof.to_timestamp >= ${hour} + 3600
            AND ${alias}.block_number BETWEEN proof.from_block AND proof.to_block))
  )`;
}

function mintBurnTapeCountedSql(alias: string): string {
  return `${alias}.amount_usd IS NOT NULL
    AND ${alias}.amount_usd >= ${NOTICE_USD}
    AND ${alias}.below_display_threshold = 0
    AND ${mintBurnSupplyProofAcceptedSql(alias)}
    AND (${alias}.flow_type IS NULL OR ${alias}.flow_type NOT IN ('bridge_transfer', 'protocol_internal'))
    AND ((${alias}.direction = 'mint' AND ${alias}.burn_type IS NOT 'review_required')
      OR (${alias}.direction = 'burn' AND ${alias}.burn_type = 'effective_burn'))
    AND ${alias}.direction IN ('mint', 'burn')`;
}

/** Keep the literal threshold visible to the partial index. Missing proof leaves classification undecided. */
export function mintBurnTapeEligibleSql(alias: string): string {
  return `${alias}.amount_usd >= ${NOTICE_USD}
    AND CASE WHEN ${mintBurnReceiptClassifiedEventSql(alias)} THEN (${mintBurnTapeCountedSql(alias)}) END`;
}

/**
 * An existing unsuppressed claim (`tape`) no longer matches its source (`src`):
 * the amount/flow/burn fields differ (NULL-safe) or the source is ineligible.
 */
export function mintBurnTapeClaimStaleSql(tape: string, src: string): string {
  return `(${mintBurnReceiptClassifiedEventSql(src)} AND ${mintBurnTapeClaimSourceMismatchSql(tape, src)})`;
}

/** Retention needs the original source while a claim awaits classification proof. */
export function mintBurnTapeClaimSourceMismatchSql(tape: string, src: string): string {
  // An unparsable stored payload compares as stale instead of raising
  // "malformed JSON" and halting the whole class (the freeze projector's guard).
  const payloadField = (path: string) =>
    `CASE WHEN json_valid(${tape}.payload_json) THEN json_extract(${tape}.payload_json, '${path}') END`;
  return `(${payloadField("$.amountUsd")} IS NOT ${src}.amount_usd
    OR ${payloadField("$.flowType")} IS NOT ${src}.flow_type
    OR ${payloadField("$.burnType")} IS NOT ${src}.burn_type
    OR (${mintBurnTapeCountedSql(src)}) IS NOT TRUE)`;
}