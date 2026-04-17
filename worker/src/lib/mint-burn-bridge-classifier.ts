/**
 * Mint/Burn Bridge Classifier — Pure Logic
 *
 * Thin dispatcher that applies the default classification and forwards to the
 * right per-protocol helper in `./mint-burn-bridge-classifier-protocols.ts`.
 * Shared types live in `./mint-burn-bridge-classifier-types.ts` (re-exported
 * here so existing import paths keep working).
 *
 * Pure function: no I/O, no DB access.
 * Async orchestration wrapper: ../mint-burn-pipeline/classification.ts
 */
import type { MintBurnBridgeDetectionConfig } from "./mint-burn-contracts";
import type {
  MintBurnBridgeClassifiableRow,
  MintBurnTxContext,
} from "./mint-burn-bridge-classifier-types";
import {
  classifyLayerZeroOft,
  classifyPoolBridge,
  setDefaultClassification,
} from "./mint-burn-bridge-classifier-protocols";

export type {
  MintBurnBridgeClassifiableRow,
  MintBurnTxContext,
} from "./mint-burn-bridge-classifier-types";

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
