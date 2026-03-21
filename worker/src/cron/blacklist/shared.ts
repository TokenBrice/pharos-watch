import { buildExplorerUrl } from "@shared/lib/explorer";
import type { ChainConfig } from "../../lib/blacklist-contracts";

export interface BlacklistRow {
  id: string;
  stablecoin: string;
  chain_id: string;
  chain_name: string;
  event_type: string;
  address: string;
  amount: number | null;
  tx_hash: string;
  block_number: number;
  timestamp: number;
  methodology_version: string;
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
