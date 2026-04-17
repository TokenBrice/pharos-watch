/**
 * Mint/Burn Bridge Classifier — Pure Logic
 *
 * Classifies mint/burn events as economic flow, bridge transfers, or review
 * rows based on contract-level bridge detection config. Pure function:
 * no I/O, no DB access.
 *
 * Async orchestration wrapper: ../mint-burn-pipeline/classification.ts
 */
import type {
  MintBurnBridgeDetectionConfig,
  MintBurnType,
} from "./mint-burn-contracts";
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

function normalizeHexSet(values: string[]): Set<string> {
  const normalized = values
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  return new Set(normalized);
}

function normalizeSelector(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (!normalized.startsWith("0x")) return null;
  return normalized.slice(0, 10);
}

function setDefaultClassification(row: MintBurnBridgeClassifiableRow): void {
  if (row.direction === "mint") {
    row.burn_type = null;
    row.burn_review_reason = null;
    return;
  }

  row.burn_type = "effective_burn";
  row.burn_review_reason = null;
}

function markBridgeTransfer(rows: MintBurnBridgeClassifiableRow[]): void {
  for (const row of rows) {
    row.flow_type = "bridge_transfer";
    if (row.direction === "burn") {
      row.burn_type = "bridge_burn";
      row.burn_review_reason = null;
    } else {
      row.burn_type = null;
      row.burn_review_reason = null;
    }
  }
}

function hasSetIntersection(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
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

  const rowsByTx = new Map<string, MintBurnBridgeClassifiableRow[]>();
  for (const row of rows) {
    const txRows = rowsByTx.get(row.tx_hash) ?? [];
    txRows.push(row);
    rowsByTx.set(row.tx_hash, txRows);
  }

  if (detection.protocol === "layerzero-oft") {
    const bridgeContractSet = normalizeHexSet(detection.knownBridgeContractAddresses);
    const signalEmitterSet = normalizeHexSet(detection.bridgeSignalEmitterAddresses);
    const topicSet = normalizeHexSet(detection.bridgeSignalTopics);
    const selectorSet = normalizeHexSet(detection.bridgeSignalSelectors);

    for (const [txHash, txRows] of rowsByTx) {
      const ctx = txContextByHash.get(txHash) ?? null;
      if (!ctx) continue;

      const ctxTopics = normalizeHexSet(ctx.logTopics);
      const ctxAddresses = normalizeHexSet(ctx.logAddresses);
      const selector = normalizeSelector(ctx.inputSelector);
      const to = ctx.to?.toLowerCase() ?? null;
      const touchesBridgeContract = Boolean(
        (to && bridgeContractSet.has(to)) || hasSetIntersection(ctxAddresses, bridgeContractSet),
      );
      const hasSignalTopic = hasSetIntersection(ctxTopics, topicSet);
      const hasExpectedEmitter = signalEmitterSet.size === 0 || hasSetIntersection(ctxAddresses, signalEmitterSet);
      const hasSignalSelector = Boolean(selector && selectorSet.has(selector));

      // Bridge fingerprint = ANY of:
      //   (a) tx touches bridge contract AND has signal topic with expected emitter,
      //   (b) tx touches bridge contract AND has known signal selector,
      //   (c) endpoint signal topic emitted by expected emitter (catches Executor-only patterns).
      const fingerprintA = touchesBridgeContract && hasSignalTopic && hasExpectedEmitter;
      const fingerprintB = touchesBridgeContract && hasSignalSelector;
      const fingerprintC = hasSignalTopic && hasExpectedEmitter && signalEmitterSet.size > 0;
      if (fingerprintA || fingerprintB || fingerprintC) {
        markBridgeTransfer(txRows);
      }
    }

    return;
  }

  const poolSet = normalizeHexSet(detection.knownBridgePoolAddresses);
  const routerSet = normalizeHexSet(detection.knownBridgeRouterAddresses);
  const topicSet = normalizeHexSet(detection.bridgeSignalTopics);
  const selectorSet = normalizeHexSet(detection.bridgeSignalSelectors);

  for (const [txHash, txRows] of rowsByTx) {
    const ctx = txContextByHash.get(txHash) ?? null;

    // Compute per-burn pool flags (used for legacy review-required path)
    const burnRows = txRows.filter((row) => row.direction === "burn");
    const knownPoolFlags = burnRows.map((row) =>
      row.counterparty ? poolSet.has(row.counterparty.toLowerCase()) : false,
    );

    if (!ctx) {
      // No tx context: keep legacy review-required for known-pool burns; mints stay standard
      for (let i = 0; i < burnRows.length; i++) {
        const row = burnRows[i];
        if (knownPoolFlags[i]) {
          row.burn_type = "review_required";
          row.burn_review_reason = "tx-context-unavailable";
        }
      }
      continue;
    }

    const ctxTopics = normalizeHexSet(ctx.logTopics);
    const hasBridgeTopic = hasSetIntersection(ctxTopics, topicSet);
    const selector = normalizeSelector(ctx.inputSelector);
    const to = ctx.to?.toLowerCase() ?? null;
    const hasRouterSelector = Boolean(to && selector && routerSet.has(to) && selectorSet.has(selector));
    const hasBridgeSignal = hasBridgeTopic || hasRouterSelector;

    // NEW: if a tx has a bridge signal, tag every row in the tx (mints + burns)
    // as bridge_transfer. This catches isolated bridge mints (destination chain)
    // that have no burn pool counterparty.
    if (hasBridgeSignal) {
      markBridgeTransfer(txRows);
      continue;
    }

    // Legacy path for txs without bridge signal but with known-pool burn counterparty
    for (let i = 0; i < burnRows.length; i++) {
      const row = burnRows[i];
      if (knownPoolFlags[i]) {
        row.burn_type = "review_required";
        row.burn_review_reason = "known-bridge-pool-without-bridge-signal";
      }
    }
  }
}
