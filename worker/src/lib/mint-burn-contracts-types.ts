import type { ChainConfig } from "./blacklist-contracts";

export type MintBurnDirection = "mint" | "burn";
export type MintBurnTier = "critical" | "extended";
export type MintBurnType = "effective_burn" | "bridge_burn" | "review_required";
export type MintBurnAdapterKind = "transfer-zero-address" | "custom-events" | "mixed";
export type MintBurnStartBlockConfidence = "high" | "medium" | "low";

export interface MintBurnCcipBridgeDetectionConfig {
  protocol: "ccip";
  knownBridgePoolAddresses: string[];
  knownBridgeRouterAddresses: string[];
  bridgeSignalTopics: string[];
  bridgeSignalSelectors: string[];
}

export interface MintBurnLayerZeroOftBridgeDetectionConfig {
  protocol: "layerzero-oft";
  knownBridgeContractAddresses: string[];
  bridgeSignalEmitterAddresses: string[];
  bridgeSignalTopics: string[];
  bridgeSignalSelectors: string[];
}

export interface MintBurnCctpBridgeDetectionConfig {
  protocol: "cctp";
  knownBridgePoolAddresses: string[];
  knownBridgeRouterAddresses: string[];
  bridgeSignalTopics: string[];
  bridgeSignalSelectors: string[];
}

export type MintBurnBridgeDetectionConfig =
  | MintBurnCcipBridgeDetectionConfig
  | MintBurnLayerZeroOftBridgeDetectionConfig
  | MintBurnCctpBridgeDetectionConfig;

export interface MintBurnEventDef {
  signature: string;
  topicHash: string;
  direction: MintBurnDirection;
  amountEncoding: "transfer-value" | "first-data-uint256" | "nth-data-uint256";
  dataSlot?: number; // Required when amountEncoding = "nth-data-uint256"; 0-indexed slot in ABI-encoded data
  filterTopic?: {
    index: number;
    value: string;
  };
  /**
   * Override counterparty extraction. When omitted, defaults to:
   *   mint  → topics[2] (Transfer recipient)
   *   burn  → topics[1] (Transfer sender)
   *
   * Use this for non-Transfer custom events where the relevant address is
   * unindexed (data) or located in a non-default topic slot.
   *
   * `source: "topic"` reads `log.topics[index]` (must be ≥1).
   * `source: "data"` reads a 32-byte word from `log.data` at `slot * 32`
   * (the address is the low-20 bytes of that word).
   */
  counterpartyEncoding?:
    | { source: "topic"; index: number }
    | { source: "data"; slot: number };
}

export interface MintBurnContractConfig {
  chain: ChainConfig;
  stablecoinId: string;
  symbol: string;
  contractAddress: string;
  decimals: number;
  dustThreshold: number;
  startBlock: number;
  events: MintBurnEventDef[];
  enabled?: boolean;
  tier?: MintBurnTier;
  bridgeDetection?: MintBurnBridgeDetectionConfig;
  adapterKind: MintBurnAdapterKind;
  startBlockSource: string;
  startBlockConfidence: MintBurnStartBlockConfidence;
}

export interface MintBurnContractConfigSpec {
  chain: ChainConfig;
  stablecoinId: string;
  contractSource?: "primary" | "traded";
  contractAddressOverride?: string;
  decimalsOverride?: number;
  dustThreshold: number;
  startBlock: number;
  events: MintBurnEventDef[];
  enabled?: boolean;
  tier?: MintBurnTier;
  bridgeDetection?: MintBurnBridgeDetectionConfig;
  adapterKind?: MintBurnAdapterKind;
  startBlockSource?: string;
  startBlockConfidence?: MintBurnStartBlockConfidence;
  isDefaultStartBlock?: boolean;
}
