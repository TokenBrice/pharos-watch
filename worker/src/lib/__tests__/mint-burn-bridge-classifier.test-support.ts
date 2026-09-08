import type { MintBurnBridgeClassifiableRow, MintBurnTxContext } from "../mint-burn-bridge-classifier";
import type { MintBurnCcipBridgeDetectionConfig, MintBurnCctpBridgeDetectionConfig } from "../mint-burn-contracts";

export function makeBridgeRow(overrides: Partial<MintBurnBridgeClassifiableRow> = {}): MintBurnBridgeClassifiableRow {
  return {
    id: "row-1", tx_hash: "0xtx", direction: "burn", flow_type: "standard",
    counterparty: null, burn_type: null, burn_review_reason: null,
    ...overrides,
  };
}

export function signalContext(detection: MintBurnCcipBridgeDetectionConfig | MintBurnCctpBridgeDetectionConfig): MintBurnTxContext {
  return {
    to: detection.knownBridgeRouterAddresses[0],
    inputSelector: detection.bridgeSignalSelectors[0],
    logTopics: [detection.bridgeSignalTopics[0]],
    logAddresses: [detection.knownBridgeRouterAddresses[0]],
  };
}
