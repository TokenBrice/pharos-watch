import { pathToFileURL } from "node:url";
import { createPublicClient, http, toHex } from "viem";
import { mainnet } from "viem/chains";
import { computeBlacklistAmountUsdAtEvent } from "../../shared/lib/blacklist";
import { getBlacklistTrackerMethodologyVersionAt } from "../../shared/lib/blacklist-tracker-version";
import type { BlacklistRow } from "../src/cron/blacklist/shared";
import {
  getBlacklistConfigsForSymbolAndChain,
  getBlacklistEventByTopic,
  type ContractEventConfig,
} from "../src/lib/blacklist-contracts";
import { decodeAddress, decodeUint256 } from "../src/lib/evm-logs";
import {
  fetchKycRipRows,
  type KycRipEventRow,
  type KycRipValidationStats,
} from "./lib/kyc-rip";
import {
  createRemoteD1Client,
  sqlString,
  type RemoteD1Client,
} from "./lib/remote-d1";

type ExistingRow = {
  stablecoin: "USDT" | "USDC";
  chain_id: "ethereum";
  address: string;
};

type ParsedReceiptLog = {
  address: `0x${string}`;
  topics: readonly `0x${string}`[];
  data: `0x${string}`;
  blockNumber: `0x${string}`;
  transactionHash: `0x${string}`;
  logIndex: `0x${string}`;
  timeStamp: `0x${string}`;
};

type ReceiptClient = {
  getTransactionReceipt(args: { hash: `0x${string}` }): Promise<{
    blockNumber: bigint;
    logs: Array<{
      address: `0x${string}`;
      topics: readonly `0x${string}`[];
      data: `0x${string}`;
      blockNumber: bigint;
      transactionHash: `0x${string}`;
      logIndex: number;
    }>;
  }>;
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
};

export type EventCliOptions = {
  apply: boolean;
  remote: true;
  database: string;
  timeoutMs: number;
  minRows: number;
  providerUrl?: string;
};

export type EventReconcileDependencies = {
  fetchImpl?: typeof fetch;
  d1?: RemoteD1Client;
  client?: ReceiptClient;
  log?: (message: string) => void;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MIN_ROWS = 100;
const DEFAULT_DATABASE = "stablecoin-db";

export function parseEventArgs(argv: string[]): EventCliOptions {
  const options: EventCliOptions = {
    apply: false,
    remote: true,
    database: DEFAULT_DATABASE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    minRows: DEFAULT_MIN_ROWS,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--remote") {
      continue;
    }
    if (arg === "--timeout-ms" || arg === "--min-rows" || arg === "--database" || arg === "--provider-url") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--timeout-ms") options.timeoutMs = parsePositiveInteger(value, arg);
      if (arg === "--min-rows") options.minRows = parsePositiveInteger(value, arg);
      if (arg === "--database") options.database = value;
      if (arg === "--provider-url") options.providerUrl = value;
      index++;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function printHelp(): void {
  console.log(`Usage: tsx worker/scripts/reconcile-blacklist-events-from-kyc-rip.ts [options]

Default mode is dry-run. Remote D1 writes require --apply.

Options:
  --apply                Execute remote D1 reads and inserts
  --remote               Target remote D1 (default and only supported D1 target)
  --timeout-ms <ms>      kyc.rip request timeout (default: ${DEFAULT_TIMEOUT_MS})
  --min-rows <count>     Minimum accepted rows before reconciliation (default: ${DEFAULT_MIN_ROWS})
  --database <name>      D1 database name (default: ${DEFAULT_DATABASE})
  --provider-url <url>   Override kyc.rip ban-list URL
  --help                 Show this help`);
}

function buildAddressKey(stablecoin: "USDT" | "USDC", address: string): string {
  return `${stablecoin}:${address.toLowerCase()}`;
}

function loadExistingEthereumBlacklistSet(d1: RemoteD1Client): Set<string> {
  const rows = d1.query<ExistingRow>(
    `SELECT stablecoin, chain_id, address
     FROM blacklist_events
     WHERE chain_id = 'ethereum'
       AND stablecoin IN ('USDT', 'USDC')
       AND event_type = 'blacklist'`,
  );

  return new Set(rows.map((row) => buildAddressKey(row.stablecoin, row.address)));
}

function getEthereumConfig(stablecoin: "USDT" | "USDC"): ContractEventConfig {
  const config = getBlacklistConfigsForSymbolAndChain(stablecoin, "ethereum")[0];
  if (!config) throw new Error(`Missing ethereum blacklist config for ${stablecoin}`);
  return config;
}

async function fetchReceiptRow(
  client: ReceiptClient,
  config: ContractEventConfig,
  address: string,
  txHash: `0x${string}`,
): Promise<BlacklistRow | null> {
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  const parsed = parseReceiptLogs(
    config,
    receipt.logs.map((log) => ({
      address: log.address,
      topics: log.topics,
      data: log.data,
      blockNumber: toHex(log.blockNumber),
      transactionHash: log.transactionHash,
      logIndex: toHex(log.logIndex),
      timeStamp: toHex(Number(block.timestamp)),
    })) satisfies ParsedReceiptLog[],
  );

  return parsed.find((row) =>
    row.event_type === "blacklist"
    && row.address.toLowerCase() === address.toLowerCase()
    && row.tx_hash.toLowerCase() === txHash.toLowerCase(),
  ) ?? null;
}

function parseReceiptLogs(config: ContractEventConfig, logs: ParsedReceiptLog[]): BlacklistRow[] {
  const rows: BlacklistRow[] = [];
  for (const log of logs) {
    const eventDef = getBlacklistEventByTopic(config, log.topics[0]);
    if (!eventDef) continue;
    const topicIdx = eventDef.addressTopicIndex ?? 1;
    const addressIndexed = log.topics.length > topicIdx;
    const affectedAddress = addressIndexed ? decodeAddress(log.topics[topicIdx]) : decodeAddress(log.data.slice(0, 66));
    const amount = eventDef.hasAmount
      ? addressIndexed
        ? log.data.length >= 66
          ? decodeUint256(log.data, config.decimals)
          : null
        : log.data.length > 66
          ? decodeUint256(`0x${log.data.slice(66)}`, config.decimals)
          : null
      : null;

    const blockNumber = Number.parseInt(log.blockNumber, 16);
    const timestamp = Number.parseInt(log.timeStamp, 16);
    if (Number.isNaN(blockNumber) || Number.isNaN(timestamp)) continue;

    rows.push({
      id: `${config.chain.chainId}-${log.transactionHash}-${log.logIndex}`,
      stablecoin: config.stablecoin,
      chain_id: config.chain.chainId,
      chain_name: config.chain.chainName,
      event_type: eventDef.eventType,
      address: affectedAddress,
      amount_native: amount,
      amount_usd_at_event: computeBlacklistAmountUsdAtEvent(config.stablecoin, amount),
      amount_source: amount != null ? "event" : "unavailable",
      amount_status: amount != null ? "resolved" : "recoverable_pending",
      tx_hash: log.transactionHash,
      block_number: blockNumber,
      timestamp,
      methodology_version: getBlacklistTrackerMethodologyVersionAt(timestamp),
      contract_address: config.contractAddress,
      config_key: config.configKey,
      event_signature: eventDef.signature,
      event_topic0: log.topics[0] ?? null,
      suppression_reason: null,
      amount_attempt_count: 0,
      amount_last_attempted_at: null,
      amount_last_error_class: null,
      amount_last_provider: null,
      explorer_tx_url: `${config.chain.explorerUrl}/tx/${log.transactionHash}`,
      explorer_address_url: `${config.chain.explorerUrl}/address/${affectedAddress}`,
    });
  }
  return rows;
}

function buildInsertStatement(row: BlacklistRow): string {
  return `INSERT OR IGNORE INTO blacklist_events
    (id, stablecoin, chain_id, chain_name, event_type, address, amount, amount_native, amount_usd_at_event, amount_source, amount_status, tx_hash, block_number, timestamp, methodology_version, contract_address, config_key, event_signature, event_topic0, amount_attempt_count, amount_last_attempted_at, amount_last_error_class, amount_last_provider, explorer_tx_url, explorer_address_url)
    VALUES (${sqlString(row.id)}, ${sqlString(row.stablecoin)}, ${sqlString(row.chain_id)}, ${sqlString(row.chain_name)}, ${sqlString(row.event_type)}, ${sqlString(row.address)}, ${row.amount_native == null ? "NULL" : row.amount_native}, ${row.amount_native == null ? "NULL" : row.amount_native}, ${row.amount_usd_at_event == null ? "NULL" : row.amount_usd_at_event}, ${sqlString(row.amount_source)}, ${sqlString(row.amount_status)}, ${sqlString(row.tx_hash)}, ${row.block_number}, ${row.timestamp}, ${sqlString(row.methodology_version)}, ${sqlString(row.contract_address)}, ${sqlString(row.config_key)}, ${sqlString(row.event_signature)}, ${sqlString(row.event_topic0)}, ${row.amount_attempt_count}, ${row.amount_last_attempted_at == null ? "NULL" : row.amount_last_attempted_at}, ${sqlString(row.amount_last_error_class)}, ${sqlString(row.amount_last_provider)}, ${sqlString(row.explorer_tx_url)}, ${sqlString(row.explorer_address_url)});`;
}

function buildSummary(
  options: EventCliOptions,
  providerUrl: string,
  stats: KycRipValidationStats,
  candidates: KycRipEventRow[],
  insertedRows: BlacklistRow[],
): Record<string, unknown> {
  return {
    mode: options.apply ? "apply" : "dry-run",
    remote: options.remote,
    database: options.database,
    providerUrl,
    timeoutMs: options.timeoutMs,
    minRows: options.minRows,
    fetchedRows: stats.fetchedRows,
    acceptedRows: stats.acceptedRows,
    skippedUnsupportedRows: stats.skippedUnsupportedRows,
    malformedRows: stats.malformedRows,
    malformedExamples: stats.malformedExamples,
    candidates: candidates.length,
    inserted: insertedRows.length,
    dryRunD1Skipped: options.apply ? undefined : true,
    byStablecoin: insertedRows.reduce<Record<string, number>>((acc, row) => {
      acc[row.stablecoin] = (acc[row.stablecoin] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

export async function runEventReconciliation(
  options: EventCliOptions,
  dependencies: EventReconcileDependencies = {},
): Promise<Record<string, unknown>> {
  const { rows, stats, providerUrl } = await fetchKycRipRows<KycRipEventRow>({
    mode: "events",
    timeoutMs: options.timeoutMs,
    minRows: options.minRows,
    providerUrl: options.providerUrl,
    fetchImpl: dependencies.fetchImpl,
  });

  if (!options.apply) {
    const summary = buildSummary(options, providerUrl, stats, rows, []);
    dependencies.log?.(JSON.stringify(summary, null, 2));
    return summary;
  }

  const d1 = dependencies.d1 ?? createRemoteD1Client(options.database);
  const existing = loadExistingEthereumBlacklistSet(d1);
  const candidates = rows.filter((row) => !existing.has(buildAddressKey(row.asset, row.address)));
  const client = dependencies.client ?? createPublicClient({ chain: mainnet, transport: http("https://ethereum-rpc.publicnode.com") });
  const insertedRows: BlacklistRow[] = [];

  for (const candidate of candidates) {
    const config = getEthereumConfig(candidate.asset);
    const row = await fetchReceiptRow(
      client,
      config,
      candidate.address.toLowerCase(),
      candidate.tx_hash.toLowerCase() as `0x${string}`,
    );
    if (row) {
      insertedRows.push(row);
    }
  }

  const summary = buildSummary(options, providerUrl, stats, candidates, insertedRows);
  dependencies.log?.(JSON.stringify(summary, null, 2));

  if (insertedRows.length > 0) {
    d1.executeStatements(insertedRows.map(buildInsertStatement), "blacklist-kyc-rip-events");
  }

  return summary;
}

async function main(): Promise<void> {
  const options = parseEventArgs(process.argv.slice(2));
  await runEventReconciliation(options, { log: console.log });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
