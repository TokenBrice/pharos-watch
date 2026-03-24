import { buildExplorerUrl } from "@shared/lib/explorer";
import type { ChainConfig } from "../../lib/blacklist-contracts";

export interface BlacklistRow {
  id: string;
  stablecoin: string;
  chain_id: string;
  chain_name: string;
  event_type: string;
  address: string;
  amount_native: number | null;
  amount_usd_at_event: number | null;
  amount_source: string;
  amount_status: string;
  tx_hash: string;
  block_number: number;
  timestamp: number;
  methodology_version: string;
  contract_address: string | null;
  config_key: string | null;
  event_signature: string | null;
  event_topic0: string | null;
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
