/**
 * Mint/Burn Bridge Classifier — Public Type Surface
 *
 * Leaf module holding the row and tx-context types shared by the dispatcher
 * (`mint-burn-bridge-classifier.ts`) and the per-protocol helpers
 * (`mint-burn-bridge-classifier-protocols.ts`). Kept as a leaf to break what
 * would otherwise be a madge-visible cycle between those two files even when
 * imports are type-only. The dispatcher re-exports these for downstream
 * consumers so existing import paths keep working.
 */
import type { MintBurnType } from "./mint-burn-contracts";
import type { MintBurnFlowType } from "./mint-burn-pipeline/types";

export interface MintBurnTxContext {
  to: string | null;
  inputSelector: string | null;
  logTopics: string[];
  logAddresses: string[];
}

export interface MintBurnBridgeClassifiableRow {
  id: string;
  tx_hash: string;
  direction: "mint" | "burn";
  flow_type: MintBurnFlowType;
  counterparty: string | null;
  burn_type: MintBurnType | null;
  burn_review_reason: string | null;
}
