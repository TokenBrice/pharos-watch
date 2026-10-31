/** Large-flow Tape claim eligibility, shared by the projector, store write guard and retention. */

export const MINT_BURN_TAPE_NOTICE_USD = 10_000_000;
const NOTICE_USD = MINT_BURN_TAPE_NOTICE_USD;

/** Single-transaction eligibility, shared with the store write guard and retention. */
export function mintBurnTapeEligibleSql(alias: string): string {
  return `${alias}.amount_usd IS NOT NULL
    AND ${alias}.amount_usd >= ${NOTICE_USD}
    AND (${alias}.flow_type IS NULL OR ${alias}.flow_type NOT IN ('bridge_transfer', 'protocol_internal'))
    AND (${alias}.direction = 'mint' OR ${alias}.burn_type IS NULL OR ${alias}.burn_type != 'review_required')
    AND ${alias}.direction IN ('mint', 'burn')`;
}

/**
 * An existing unsuppressed claim (`tape`) no longer matches its source (`src`):
 * the amount/flow/burn fields differ (NULL-safe) or the source is ineligible.
 */
export function mintBurnTapeClaimStaleSql(tape: string, src: string): string {
  // An unparsable stored payload compares as stale instead of raising
  // "malformed JSON" and halting the whole class (the freeze projector's guard).
  const payloadField = (path: string) =>
    `CASE WHEN json_valid(${tape}.payload_json) THEN json_extract(${tape}.payload_json, '${path}') END`;
  return `(${payloadField("$.amountUsd")} IS NOT ${src}.amount_usd
    OR ${payloadField("$.flowType")} IS NOT ${src}.flow_type
    OR ${payloadField("$.burnType")} IS NOT ${src}.burn_type
    OR NOT (${mintBurnTapeEligibleSql(src)}))`;
}
