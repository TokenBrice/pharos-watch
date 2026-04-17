/**
 * Mint/Burn Bridge Classifier — Pure Logic
 *
 * Classifies mint/burn events as economic flow, bridge transfers, or review
 * rows based on contract-level bridge detection config. Pure function:
 * no I/O, no DB access.
 *
 * Per-protocol logic lives in `./mint-burn-bridge-classifier-protocols.ts`;
 * this module is a thin dispatcher that applies the default classification
 * and forwards to the right helper.
 *
 * Async orchestration wrapper: ../mint-burn-pipeline/classification.ts
 */
import type {
  MintBurnBridgeDetectionConfig,
  MintBurnType,
} from "./mint-burn-contracts";
import type { MintBurnFlowType } from "./mint-burn-pipeline/types";
import {
  classifyLayerZeroOft,
  classifyPoolBridge,
  setDefaultClassification,
} from "./mint-burn-bridge-classifier-protocols";

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

export function classifyBridgeAwareBurnRows(
  rows: MintBurnBridgeClassifiableRow[],
  detection: MintBurnBridgeDetectionConfig | undefined,
  txContextByHash: Map<string, MintBurnTxContext | null>,
): void {
  for (const row of rows) {
    setDefaultClassification(row);
  }

  if (!detection) return;

  if (detection.protocol === "layerzero-oft") {
    classifyLayerZeroOft(rows, detection, txContextByHash);
    return;
  }

  classifyPoolBridge(rows, detection, txContextByHash);
}
