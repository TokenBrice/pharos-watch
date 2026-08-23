import type {
  BlacklistAmountSource,
  BlacklistAmountStatus,
  BlacklistEventType,
  BlacklistStablecoin,
} from "@shared/types/market";
import { computeBlacklistAmountUsdAtEvent } from "@shared/lib/blacklist";
import { buildExplorerUrl } from "@shared/lib/explorer";
import { getBlacklistTrackerMethodologyVersionAt } from "@shared/lib/methodology-versions/blacklist-tracker";
import type { ChainConfig } from "../blacklist-contracts";

export function shouldSuppressAsMirrorZero(
  stablecoin: string,
  eventType: string,
  amountNative: number | null,
): boolean {
  return stablecoin === "EURC" && (eventType === "blacklist" || eventType === "unblacklist") && amountNative === 0;
}

export interface BlacklistPersistedRow {
  id: string;
  stablecoin: BlacklistStablecoin;
  chain_id: string;
  chain_name: string;
  event_type: BlacklistEventType;
  address: string;
  amount_native: number | null;
  amount_usd_at_event: number | null;
  amount_source: BlacklistAmountSource;
  amount_status: BlacklistAmountStatus;
  tx_hash: string;
  block_number: number;
  timestamp: number;
  methodology_version: string;
  contract_address: string | null;
  config_key: string | null;
  event_signature: string | null;
  event_topic0: string | null;
  suppression_reason?: string | null;
  amount_attempt_count: number;
  amount_last_attempted_at: number | null;
  amount_last_error_class: string | null;
  amount_last_provider: string | null;
  explorer_tx_url: string;
  explorer_address_url: string;
}

export type BlacklistRow = BlacklistPersistedRow;

export interface BlacklistScanResult {
  rows: BlacklistRow[];
  latestCursor: number;
  nextCursor: number | null;
  apiError: boolean;
  incomplete: boolean;
  usedRpcLogs: boolean;
  scannedToCursor: number | null;
  safeHead: number | null;
  coverageOutcome: BlacklistScanCoverageOutcome;
  topicCount: number;
  coveredTopicCount: number;
  providerCalls: number;
  maxSplitDepth: number;
  failureSamples: string[];
}

export type BlacklistScanCoverageOutcome =
  "complete" | "quiet" | "partial" | "provider_error" | "missing_topic" | "incomplete" | "cursor_ahead";

interface BuildBlacklistRowOptions {
  id: string;
  stablecoin: BlacklistStablecoin;
  chain: ChainConfig;
  eventType: BlacklistEventType;
  address: string;
  amount: number | null;
  txHash: string;
  blockNumber: number;
  timestamp: number;
  contractAddress: string | null;
  configKey: string | null;
  eventSignature: string | null;
  eventTopic0: string | null;
}

export function buildBlacklistRow({
  id,
  stablecoin,
  chain,
  eventType,
  address,
  amount,
  txHash,
  blockNumber,
  timestamp,
  contractAddress,
  configKey,
  eventSignature,
  eventTopic0,
}: BuildBlacklistRowOptions): BlacklistRow {
  const amountResolved = amount != null;

  return {
    id,
    stablecoin,
    chain_id: chain.chainId,
    chain_name: chain.chainName,
    event_type: eventType,
    address,
    amount_native: amount,
    amount_usd_at_event: computeBlacklistAmountUsdAtEvent(stablecoin, amount),
    amount_source: amountResolved ? "event" : "unavailable",
    amount_status: amountResolved ? "resolved" : "recoverable_pending",
    tx_hash: txHash,
    block_number: blockNumber,
    timestamp,
    methodology_version: getBlacklistTrackerMethodologyVersionAt(timestamp),
    contract_address: contractAddress,
    config_key: configKey,
    event_signature: eventSignature,
    event_topic0: eventTopic0,
    suppression_reason: null,
    amount_attempt_count: 0,
    amount_last_attempted_at: null,
    amount_last_error_class: null,
    amount_last_provider: null,
    explorer_tx_url: buildExplorerTxUrl(chain, txHash),
    explorer_address_url: buildExplorerAddressUrl(chain, address),
  };
}

function buildExplorerTxUrl(chain: ChainConfig, txHash: string): string {
  return (
    buildExplorerUrl({
      chainType: chain.type,
      explorerUrl: chain.explorerUrl,
      entityType: "tx",
      value: txHash,
    }) ?? `${chain.explorerUrl}/tx/${txHash}`
  );
}

function buildExplorerAddressUrl(chain: ChainConfig, address: string): string {
  return (
    buildExplorerUrl({
      chainType: chain.type,
      explorerUrl: chain.explorerUrl,
      entityType: "address",
      value: address,
    }) ?? `${chain.explorerUrl}/address/${address}`
  );
}
