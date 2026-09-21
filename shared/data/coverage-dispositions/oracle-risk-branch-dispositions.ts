/**
 * Reviewed branch-level dispositions for the CDP oracle-risk coverage audit.
 *
 * A branch/field pair listed here is **reviewed-inoperable**: researched,
 * evidenced, and deliberately unrecorded in the coin data. The audit stops
 * treating it as a missing-evidence finding and instead reports it under its
 * own heading — reviewed-inoperable is never folded into the "complete
 * branches" count, so the report still shows the gap, it just shows it as a
 * decision rather than as backlog.
 *
 * The register is currently empty. Its only four rows (MAI's dead-oracle
 * branches, 72.9% of recorded vault debt) migrated to the schema on
 * 2026-09-21: `OracleRiskBranch.liquidationState: "uncallable"` now carries
 * the reviewed impossibility directly, `liquidationDelaySec` stays reserved
 * for callable branches, and `src/lib/stablecoin-detail-oracle-client.ts`
 * renders the reviewed state. New rows belong here only while a reviewed
 * answer genuinely has no home in the schema.
 *
 * Nothing here changes coin data, the public schema, scoring, or any rendered
 * surface. Rows are validated against live coin data on every audit run: a row
 * pointing at a coin, branch, or field that no longer matches — including a
 * field that has since been populated — is a blocking finding, so this file
 * cannot silently outlive the situation it describes.
 */

/** Branch evidence fields a reviewed disposition may cover. */
const ORACLE_RISK_BRANCH_DISPOSITION_FIELDS = ["liquidationDelaySec"] as const;
export type OracleRiskBranchDispositionField = (typeof ORACLE_RISK_BRANCH_DISPOSITION_FIELDS)[number];

const ORACLE_RISK_BRANCH_DISPOSITIONS = ["reviewed-inoperable"] as const;
export type OracleRiskBranchDisposition = (typeof ORACLE_RISK_BRANCH_DISPOSITIONS)[number];

const ORACLE_RISK_BRANCH_DISPOSITION_REASON_CODES = ["liquidation-uncallable-dead-oracle"] as const;
export type OracleRiskBranchDispositionReasonCode = (typeof ORACLE_RISK_BRANCH_DISPOSITION_REASON_CODES)[number];

export interface ReviewedOracleRiskBranchDisposition {
  /** Stablecoin id the branch belongs to. */
  id: string;
  /** `OracleRiskBranch.id` on that coin's profile. */
  branchId: string;
  /** The evidence field this disposition answers in place of the schema. */
  field: OracleRiskBranchDispositionField;
  disposition: OracleRiskBranchDisposition;
  reasonCode: OracleRiskBranchDispositionReasonCode;
  /** Why the schema cannot express the reviewed answer. */
  schemaLimitation: string;
  /** What was actually observed on chain, in one sentence. */
  finding: string;
  /** Block heights (or ranges) the finding was pinned to. */
  observedBlocks: readonly string[];
  evidenceUrls: readonly string[];
  reviewer: string;
  /** Date the evidence was read, never the date this file was edited. */
  reviewedDate: string;
}

export const REVIEWED_ORACLE_RISK_BRANCH_DISPOSITIONS: readonly ReviewedOracleRiskBranchDisposition[] = [];
