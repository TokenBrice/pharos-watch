import { getBlacklistTrackerMethodologyVersionAt } from "@shared/lib/methodology-versions/blacklist-tracker";
import type { BlacklistEvent } from "@shared/types/market";
import type { BlacklistPersistedRow } from "./blacklist/shared";

export type BlacklistEventRow = Omit<BlacklistPersistedRow,
  | "methodology_version"
  | "suppression_reason"
  | "amount_attempt_count"
  | "amount_last_attempted_at"
  | "amount_last_error_class"
  | "amount_last_provider"
> & {
  methodology_version: string | null;
  suppression_reason: string | null;
};

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
