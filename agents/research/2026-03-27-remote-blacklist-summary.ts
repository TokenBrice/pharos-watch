import { execFileSync } from "node:child_process";
import { buildBlacklistAddressCountKey } from "../../shared/lib/blacklist";
import {
  buildBlacklistActiveRecords,
  computeBlacklistActiveSummaryStats,
  type BlacklistCurrentBalanceSnapshot,
} from "../../shared/lib/blacklist-active-records";
import type { BlacklistEvent } from "../../shared/types/market";

type EventRow = {
  id: string;
  stablecoin: BlacklistEvent["stablecoin"];
  chain_id: string;
  chain_name: string;
  event_type: BlacklistEvent["eventType"];
  address: string;
  amount_native: number | null;
  amount_usd_at_event: number | null;
  amount_source: BlacklistEvent["amountSource"];
  amount_status: BlacklistEvent["amountStatus"];
  tx_hash: string;
  block_number: number;
  timestamp: number;
  methodology_version: string | null;
  contract_address: string | null;
  config_key: string | null;
  event_signature: string | null;
  event_topic0: string | null;
  explorer_tx_url: string;
  explorer_address_url: string;
};

type CurrentBalanceRow = {
  id: string;
  stablecoin: BlacklistEvent["stablecoin"];
  chain_id: string;
  address: string;
  amount_native: number | null;
  amount_usd: number | null;
  status: "resolved" | "provider_failed";
  source: string;
  observed_at: number;
};

function query(sql: string): unknown[] {
  const raw = execFileSync("npx", ["wrangler", "d1", "execute", "stablecoin-db", "--remote", "--json", "--command", sql], {
    cwd: "./worker",
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 128,
  });
  return JSON.parse(raw)[0]?.results ?? [];
}

function buildCurrentBalanceId(stablecoin: BlacklistEvent["stablecoin"], chainId: string, address: string): string {
  return buildBlacklistAddressCountKey(stablecoin, chainId, address);
}

const eventRows = query(
  `SELECT id, stablecoin, chain_id, chain_name, event_type, address, amount_native, amount_usd_at_event,
          amount_source, amount_status, tx_hash, block_number, timestamp, methodology_version, contract_address,
          config_key, event_signature, event_topic0, explorer_tx_url, explorer_address_url
   FROM blacklist_events
   ORDER BY timestamp DESC`,
) as EventRow[];
const currentBalanceRows = query(
  `SELECT id, stablecoin, chain_id, address, amount_native, amount_usd, status, source, observed_at
   FROM blacklist_current_balances`,
) as CurrentBalanceRow[];

const events = eventRows.map((row) => ({
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
  methodologyVersion: row.methodology_version ?? "3.4",
  contractAddress: row.contract_address,
  configKey: row.config_key,
  eventSignature: row.event_signature,
  eventTopic0: row.event_topic0,
  explorerTxUrl: row.explorer_tx_url,
  explorerAddressUrl: row.explorer_address_url,
})) satisfies BlacklistEvent[];

const currentBalances = new Map<string, BlacklistCurrentBalanceSnapshot>(
  currentBalanceRows.map((row) => [
    row.id,
    {
      stablecoin: row.stablecoin,
      chainId: row.chain_id,
      address: row.address,
      amountNative: row.amount_native,
      amountUsd: row.amount_usd,
      status: row.status,
      source: row.source,
      observedAt: row.observed_at,
    },
  ]),
);

const activeRecords = buildBlacklistActiveRecords(events, currentBalances);
const stats = computeBlacklistActiveSummaryStats(activeRecords);
const activeIds = new Set(activeRecords.map((record) => record.id));
const eventIds = new Set(events.map((event) => buildCurrentBalanceId(event.stablecoin, event.chainId, event.address)));
let orphanActiveAddressCount = 0;
let orphanActiveFrozenTotal = 0;
let orphanActiveAmountGapCount = 0;
for (const snapshot of currentBalances.values()) {
  const snapshotId = buildCurrentBalanceId(snapshot.stablecoin, snapshot.chainId, snapshot.address);
  if (activeIds.has(snapshotId) || eventIds.has(snapshotId)) continue;
  orphanActiveAddressCount++;
  if (snapshot.amountUsd == null) {
    orphanActiveAmountGapCount++;
    continue;
  }
  orphanActiveFrozenTotal += snapshot.amountUsd;
}
const breakdown = Object.entries(
  activeRecords.reduce<Record<string, { count: number; total: number; gaps: number }>>((acc, row) => {
    const key = `${row.chainId}/${row.stablecoin}`;
    acc[key] ??= { count: 0, total: 0, gaps: 0 };
    acc[key].count++;
    if (row.frozenAmountUsd == null) acc[key].gaps++;
    else acc[key].total += row.frozenAmountUsd;
    return acc;
  }, {}),
).sort(([a], [b]) => a.localeCompare(b));

console.log(JSON.stringify({
  stats: {
    activeAddressCount: stats.activeAddressCount + orphanActiveAddressCount,
    activeFrozenTotal: stats.activeFrozenTotal + orphanActiveFrozenTotal,
    activeAmountGapCount: stats.activeAmountGapCount + orphanActiveAmountGapCount,
  },
  orphanActiveAddressCount,
  orphanActiveFrozenTotal,
  orphanActiveAmountGapCount,
  breakdown,
}, null, 2));
