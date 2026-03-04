import type {
  MintBurnBridgeDetectionConfig,
  MintBurnType,
} from "./mint-burn-contracts";

export interface MintBurnTxContext {
  to: string | null;
  inputSelector: string | null;
  logTopics: string[];
}

export interface MintBurnBridgeClassifiableRow {
  id: string;
  tx_hash: string;
  direction: "mint" | "burn";
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

export function classifyBridgeAwareBurnRows(
  rows: MintBurnBridgeClassifiableRow[],
  detection: MintBurnBridgeDetectionConfig | undefined,
  txContextByHash: Map<string, MintBurnTxContext | null>,
): void {
  for (const row of rows) {
    if (row.direction === "mint") {
      row.burn_type = null;
      row.burn_review_reason = null;
    } else if (!detection) {
      row.burn_type = "effective_burn";
      row.burn_review_reason = null;
    }
  }

  if (!detection) return;

  const poolSet = normalizeHexSet(detection.knownBridgePoolAddresses);
  const routerSet = normalizeHexSet(detection.knownBridgeRouterAddresses);
  const topicSet = normalizeHexSet(detection.bridgeSignalTopics);
  const selectorSet = normalizeHexSet(detection.bridgeSignalSelectors);

  const burnsByTx = new Map<string, MintBurnBridgeClassifiableRow[]>();
  for (const row of rows) {
    if (row.direction !== "burn") continue;
    const txRows = burnsByTx.get(row.tx_hash) ?? [];
    txRows.push(row);
    burnsByTx.set(row.tx_hash, txRows);
  }

  for (const [txHash, txRows] of burnsByTx) {
    const ctx = txContextByHash.get(txHash) ?? null;
    const knownPoolFlags = txRows.map((row) =>
      row.counterparty ? poolSet.has(row.counterparty.toLowerCase()) : false,
    );
    const hasKnownPoolBurn = knownPoolFlags.some(Boolean);

    if (!ctx) {
      for (let i = 0; i < txRows.length; i++) {
        const row = txRows[i];
        if (knownPoolFlags[i]) {
          row.burn_type = "review_required";
          row.burn_review_reason = "tx-context-unavailable";
        } else {
          row.burn_type = "effective_burn";
          row.burn_review_reason = null;
        }
      }
      continue;
    }

    const ctxTopics = normalizeHexSet(ctx.logTopics);
    const hasBridgeTopic = [...ctxTopics].some((topic) => topicSet.has(topic));
    const selector = normalizeSelector(ctx.inputSelector);
    const to = ctx.to?.toLowerCase() ?? null;
    const hasRouterSelector = Boolean(
      to &&
      selector &&
      routerSet.has(to) &&
      selectorSet.has(selector),
    );
    const hasBridgeSignal = hasBridgeTopic || hasRouterSelector;

    for (let i = 0; i < txRows.length; i++) {
      const row = txRows[i];
      const fromKnownPool = knownPoolFlags[i];

      if (fromKnownPool && hasBridgeSignal) {
        row.burn_type = "bridge_burn";
        row.burn_review_reason = null;
        continue;
      }

      if (fromKnownPool && !hasBridgeSignal) {
        row.burn_type = "review_required";
        row.burn_review_reason = "known-bridge-pool-without-bridge-signal";
        continue;
      }

      if (!fromKnownPool && hasBridgeSignal && !hasKnownPoolBurn) {
        row.burn_type = "review_required";
        row.burn_review_reason = "bridge-signal-with-unknown-pool";
        continue;
      }

      row.burn_type = "effective_burn";
      row.burn_review_reason = null;
    }
  }
}
