import { getBlacklistTrackerMethodologyVersionAt } from "@shared/lib/methodology-versions/blacklist-tracker";
import type {
  BlacklistAmountSource,
  BlacklistAmountStatus,
  BlacklistEvent,
  BlacklistEventType,
  BlacklistStablecoin,
} from "@shared/types/market";

export interface BlacklistEventRow {
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
  methodology_version: string | null;
  contract_address: string | null;
  config_key: string | null;
  event_signature: string | null;
  event_topic0: string | null;
  suppression_reason: string | null;
  explorer_tx_url: string;
  explorer_address_url: string;
}

export function mapBlacklistEventRow(row: BlacklistEventRow): BlacklistEvent {
  return {
    methodologyVersion: row.methodology_version ?? getBlacklistTrackerMethodologyVersionAt(row.timestamp),
    id: row.id,
    stablecoin: row.stablecoin,
    chainId: row.chain_id,
    chainName: row.chain_name,
    eventType: row.event_type,
    address: row.address,
    amountNative: row.amount_native,
    amountUsdAtEvent: row.amount_usd_at_event,
    amountSource: row.amount_source,
    amountStatus: row.amount_status,
    txHash: row.tx_hash,
    blockNumber: row.block_number,
    timestamp: row.timestamp,
    contractAddress: row.contract_address,
    configKey: row.config_key,
    eventSignature: row.event_signature,
    eventTopic0: row.event_topic0,
    suppressionReason: row.suppression_reason ?? null,
    explorerTxUrl: row.explorer_tx_url,
    explorerAddressUrl: row.explorer_address_url,
  };
}
