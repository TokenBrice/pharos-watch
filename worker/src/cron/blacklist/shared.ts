import type { BlacklistAmountSource, BlacklistAmountStatus, BlacklistEventType, BlacklistStablecoin } from "@shared/types/market";
import { buildExplorerUrl } from "@shared/lib/explorer";
import type { ChainConfig } from "../../lib/blacklist-contracts";

export function shouldSuppressAsMirrorZero(
  stablecoin: string,
  eventType: string,
  amountNative: number | null,
): boolean {
  return (
    stablecoin === "EURC"
    && (eventType === "blacklist" || eventType === "unblacklist")
    && amountNative === 0
  );
}

export interface BlacklistRow {
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

export function buildExplorerTxUrl(chain: ChainConfig, txHash: string): string {
  return buildExplorerUrl({
    chainType: chain.type,
    explorerUrl: chain.explorerUrl,
    entityType: "tx",
    value: txHash,
  }) ?? `${chain.explorerUrl}/tx/${txHash}`;
}

export function buildExplorerAddressUrl(chain: ChainConfig, address: string): string {
  return buildExplorerUrl({
    chainType: chain.type,
    explorerUrl: chain.explorerUrl,
    entityType: "address",
    value: address,
  }) ?? `${chain.explorerUrl}/address/${address}`;
}
