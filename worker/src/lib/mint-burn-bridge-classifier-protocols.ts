/**
 * Mint/Burn Bridge Classifier — Protocol Helpers
 *
 * Per-protocol classification logic split out from
 * `./mint-burn-bridge-classifier.ts` so each protocol family lives in its own
 * focused function. Pure logic: no I/O, no DB access.
 *
 * The parent dispatcher (`classifyBridgeAwareBurnRows`) applies the default
 * classification once, then forwards to one of the helpers below based on
 * `detection.protocol`.
 */
import type {
  MintBurnCcipBridgeDetectionConfig,
  MintBurnCctpBridgeDetectionConfig,
  MintBurnLayerZeroOftBridgeDetectionConfig,
} from "./mint-burn-contracts";
import type {
  MintBurnBridgeClassifiableRow,
  MintBurnTxContext,
} from "./mint-burn-bridge-classifier-types";

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

export function setDefaultClassification(row: MintBurnBridgeClassifiableRow): void {
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

function groupRowsByTx(
  rows: MintBurnBridgeClassifiableRow[],
): Map<string, MintBurnBridgeClassifiableRow[]> {
  const rowsByTx = new Map<string, MintBurnBridgeClassifiableRow[]>();
  for (const row of rows) {
    const txRows = rowsByTx.get(row.tx_hash) ?? [];
    txRows.push(row);
    rowsByTx.set(row.tx_hash, txRows);
  }
  return rowsByTx;
}

/**
 * Classify LayerZero OFT bridge activity.
 *
 * Bridge fingerprint = ANY of:
 *   (a) tx touches bridge contract AND has signal topic with expected emitter,
 *   (b) tx touches bridge contract AND has known signal selector,
 *   (c) endpoint signal topic emitted by expected emitter (catches Executor-only patterns).
 */
export function classifyLayerZeroOft(
  rows: MintBurnBridgeClassifiableRow[],
  detection: MintBurnLayerZeroOftBridgeDetectionConfig,
  txContextByHash: Map<string, MintBurnTxContext | null>,
): void {
  const rowsByTx = groupRowsByTx(rows);
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

    const fingerprintA = touchesBridgeContract && hasSignalTopic && hasExpectedEmitter;
    const fingerprintB = touchesBridgeContract && hasSignalSelector;
    const fingerprintC = hasSignalTopic && hasExpectedEmitter && signalEmitterSet.size > 0;
    if (fingerprintA || fingerprintB || fingerprintC) {
      markBridgeTransfer(txRows);
    }
  }
}

/**
 * Classify CCIP / CCTP (pool-based) bridge activity.
 *
 * If the tx has a bridge signal, every row in the tx (mints + burns) is
 * tagged `bridge_transfer`. This catches isolated bridge mints on the
 * destination chain that have no burn-pool counterparty.
 *
 * Legacy fallback: a known-pool burn without any bridge signal (or with no
 * tx context available) is marked `review_required`.
 */
export function classifyPoolBridge(
  rows: MintBurnBridgeClassifiableRow[],
  detection: MintBurnCcipBridgeDetectionConfig | MintBurnCctpBridgeDetectionConfig,
  txContextByHash: Map<string, MintBurnTxContext | null>,
): void {
  const rowsByTx = groupRowsByTx(rows);
  const poolSet = normalizeHexSet(detection.knownBridgePoolAddresses);
  const routerSet = normalizeHexSet(detection.knownBridgeRouterAddresses);
  const topicSet = normalizeHexSet(detection.bridgeSignalTopics);
  const selectorSet = normalizeHexSet(detection.bridgeSignalSelectors);
  const transmitter = detection.protocol === "cctp" ? detection.messageTransmitterAddress.toLowerCase() : null;

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

    if (detection.protocol === "cctp" && ctx.receiptLogs) {
      const logs = ctx.receiptLogs;
      const received = logs.some((log) =>
        log.address.toLowerCase() === transmitter
        && log.topics.length === 4
        && log.topics[0].toLowerCase() === detection.messageReceivedTopic.toLowerCase(),
      );
      // MessageReceived is shared infrastructure, not token mint evidence.
      // Require the reviewed messenger's token-bound MintAndWithdraw and its
      // matching zero-address Transfer in the same receipt. Keep it separate
      // from the source-side deposit fingerprints below.
      const token = detection.mintTokenAddress.toLowerCase();
      const bridgeRows = new Set<MintBurnBridgeClassifiableRow>();
      if (received) for (let mintIndex = 0; mintIndex < logs.length; mintIndex++) {
        const log = logs[mintIndex];
        if (
          !routerSet.has(log.address.toLowerCase())
          || log.topics.length !== 3
          || log.topics[0].toLowerCase() !== detection.mintAndWithdrawTopic.toLowerCase()
          || !/^0x0{24}[0-9a-f]{40}$/i.test(log.topics[1])
          || !/^0x0{24}[0-9a-f]{40}$/i.test(log.topics[2])
          || `0x${log.topics[2].slice(-40)}`.toLowerCase() !== token
          || !/^0x[0-9a-f]{128}$/i.test(log.data)
        ) continue;
        const recipient = log.topics[1].toLowerCase();
        const amountWord = log.data.slice(2, 66).toLowerCase();
        const feeWord = log.data.slice(66).toLowerCase();
        const transfers = logs.slice(0, mintIndex).filter((transfer) =>
          transfer.address.toLowerCase() === token
          && transfer.topics.length === 3
          && transfer.topics[0].toLowerCase() === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
          && transfer.topics[1].toLowerCase() === `0x${"0".repeat(64)}`
          && /^0x0{24}[0-9a-f]{40}$/i.test(transfer.topics[2])
          && /^0x[0-9a-f]{64}$/i.test(transfer.data),
        );
        let principalIndex = -1;
        for (let index = transfers.length - 1; index >= 0; index--) {
          if (transfers[index].topics[2].toLowerCase() === recipient && transfers[index].data.slice(2).toLowerCase() === amountWord) {
            principalIndex = index;
            break;
          }
        }
        if (principalIndex < 0) continue;
        const matchedTransfers = [transfers[principalIndex]];
        // Reviewed TokenMinterV2 mints the recipient first, then the separate
        // fee recipient. Bind that second Transfer, not arbitrary same-tx mints.
        const feeTransfer = transfers[principalIndex + 1];
        if (feeWord !== "0".repeat(64) && feeTransfer?.data.slice(2).toLowerCase() === feeWord) {
          matchedTransfers.push(feeTransfer);
        }
        for (const transfer of matchedTransfers) {
          if (!transfer.logIndex || !/^0x[0-9a-f]+$/i.test(transfer.logIndex)) continue;
          const logIndex = Number.parseInt(transfer.logIndex, 16);
          if (!Number.isSafeInteger(logIndex)) continue;
          for (const row of txRows) {
            if (row.direction === "mint" && row.id.endsWith(`-${txHash}-${logIndex}`)) bridgeRows.add(row);
          }
        }
      }
      if (bridgeRows.size > 0) {
        markBridgeTransfer([...bridgeRows]);
      }
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

