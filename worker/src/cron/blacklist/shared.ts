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
  if (chain.type === "tron") {
    return `${chain.explorerUrl}/#/transaction/${txHash}`;
  }
  return `${chain.explorerUrl}/tx/${txHash}`;
}

export function buildExplorerAddressUrl(chain: ChainConfig, address: string): string {
  if (chain.type === "tron") {
    const tronAddr = address.startsWith("0x") ? "41" + address.slice(2) : address;
    return `${chain.explorerUrl}/#/address/${tronAddr}`;
  }
  return `${chain.explorerUrl}/address/${address}`;
}
