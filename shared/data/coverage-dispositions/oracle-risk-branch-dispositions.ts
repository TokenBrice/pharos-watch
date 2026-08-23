/**
 * Reviewed branch-level dispositions for the CDP oracle-risk coverage audit.
 *
 * `OracleRiskBranch.liquidationDelaySec` is
 * `z.number().finite().int().nonnegative().optional()` — it can say *N seconds*
 * and it can say *no delay parameter*, but it cannot say *liquidation is not
 * callable at all*. `src/lib/stablecoin-detail-oracle-client.ts` fixes `0` as a
 * positive claim of instant liquidation, so recording `0` on a branch whose
 * oracle read reverts would publish a falsehood, and leaving the field unset
 * makes the coverage audit report an un-researched gap. Both are wrong for the
 * same four MAI branches: the research is complete, the answer simply has no
 * home in the field.
 *
 * This register is the third answer. A branch/field pair listed here is
 * **reviewed-inoperable**: researched, evidenced, and deliberately unrecorded.
 * The audit stops treating it as a missing-evidence finding and instead reports
 * it under its own heading — reviewed-inoperable is never folded into the
 * "complete branches" count, so the report still shows the gap, it just shows
 * it as a decision rather than as backlog.
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

const MAI_SCHEMA_LIMITATION =
  "liquidationDelaySec is a non-negative integer with no unbounded or not-applicable sentinel; 0 is a positive claim "
  + "of instant liquidation, so it cannot express a market where liquidation is uncallable at every block.";

function maiDeadOracleBranch(
  row: Pick<ReviewedOracleRiskBranchDisposition, "branchId" | "finding" | "observedBlocks" | "evidenceUrls">,
): ReviewedOracleRiskBranchDisposition {
  return {
    id: "mai-qidao",
    field: ORACLE_RISK_BRANCH_DISPOSITION_FIELDS[0],
    disposition: ORACLE_RISK_BRANCH_DISPOSITIONS[0],
    reasonCode: ORACLE_RISK_BRANCH_DISPOSITION_REASON_CODES[0],
    schemaLimitation: MAI_SCHEMA_LIMITATION,
    reviewer: "Pharos Safety research",
    reviewedDate: "2026-08-09",
    ...row,
  };
}

/**
 * MAI's four wholly dead-oracle branches — 72.9% of MAI's recorded vault debt,
 * ~1.53M MAI stranded across Fantom, Polygon, and Moonbeam. Each was re-proved
 * on 2026-08-09 by direct `eth_call`: `liquidateVault` and the collateral checks
 * revert with empty return data on live positions, while the same call on a live
 * market on the same endpoint returns the ordinary
 * "Vault is not below minimum collateral percentage" revert string — placing the
 * failure inside the price read rather than in any require. The vault sources
 * carry no delay, grace-period, auction, or timestamp term at all, so there is
 * no positive delay to record either.
 */
export const REVIEWED_ORACLE_RISK_BRANCH_DISPOSITIONS: readonly ReviewedOracleRiskBranchDisposition[] = [
  maiDeadOracleBranch({
    branchId: "fantom-dead-oracle-legacy",
    finding:
      "Fantom BTC vault 0xE5996a2c: liquidateVault(uint256) is in the deployed bytecode and stabilityPool() is the "
      + "zero address, yet checkCollateralPercentage(34), checkLiquidation(34) and liquidateVault(34) all revert empty "
      + "on live vault 34, while ownerOf(999999) still returns its ERC721 revert string.",
    observedBlocks: ["fantom:122814200"],
    evidenceUrls: [
      "https://ftmscan.com/address/0xE5996a2cB60eA57F03bf332b5ADC517035d8d094",
      "https://fantom.drpc.org",
      "https://rpc.fantom.network",
    ],
  }),
  maiDeadOracleBranch({
    branchId: "polygon-dead-oracle-legacy",
    finding:
      "getEthPriceSource() reverts empty on all six wind-down vaults (cxETH, cxADA, cxDOGE, CEL, FXS, dQUICK); on live "
      + "cxETH position 36 the collateral checks and liquidateVault(36) revert empty, whereas the live Polygon WETH "
      + "market 0xb5b31e6a returns 'Vault is not below minimum collateral percentage' at the same block.",
    observedBlocks: ["polygon:91727016"],
    evidenceUrls: [
      "https://polygonscan.com/address/0x506533B9C16eE2472A6BF37cc320aE45a0a24F11",
      "https://polygon-bor-rpc.publicnode.com",
      "https://docs.mai.finance/docs/liquidation",
    ],
  }),
  maiDeadOracleBranch({
    branchId: "polygon-stmatic",
    finding:
      "stMATIC vault: stabilityPool() is the zero address, debtRatio()=2 and gainRatio()=1100 are unchanged, "
      + "getEthPriceSource() reverts empty, and on live position 5 (448.290758 MAI debt) checkCollateralPercentage(5), "
      + "checkLiquidation(5) and liquidateVault(5,0) all revert empty.",
    observedBlocks: ["polygon:91727016-91727114"],
    evidenceUrls: [
      "https://polygonscan.com/address/0x9A05b116b56304F5f4B3F1D5DA4641bFfFfae6Ab",
      "https://polygon-bor-rpc.publicnode.com",
      "https://docs.mai.finance/docs/liquidation",
    ],
  }),
  maiDeadOracleBranch({
    branchId: "moonbeam-glmr",
    finding:
      "GLMR vault: ethPriceSource() 0x4497B606be93e773bbA5eaCFCb2ac5E2214220Eb has a reverting latestRoundData(), "
      + "stabilityPool() is the zero address, and on live position 42 (8.330497 MAI debt) "
      + "checkCollateralPercentage(42), checkLiquidation(42) and liquidateVault(42,0) all revert empty.",
    observedBlocks: ["moonbeam:16786674-16786696"],
    evidenceUrls: [
      "https://moonscan.io/address/0x3A82F4da24F93a32dc3C2A28cFA9D6E63EC28531",
      "https://moonbeam-rpc.publicnode.com",
      "https://docs.mai.finance/docs/liquidation",
    ],
  }),
];
