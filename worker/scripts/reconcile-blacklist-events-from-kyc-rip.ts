import { pathToFileURL } from "node:url";
import { createPublicClient, http, toHex } from "viem";
import { mainnet } from "viem/chains";
import { runCliEntrypoint, writeCliHelpIfRequested } from "../../scripts/lib/cli-args.mjs";
import { parseEvmLogs } from "../src/cron/blacklist/evm-source";
import type { BlacklistRow } from "../src/cron/blacklist/shared";
import {
  getBlacklistConfigsForSymbolAndChain,
  type ContractEventConfig,
} from "../src/lib/blacklist-contracts";
import {
  fetchKycRipRows,
  formatKycRipCliUsage,
  parseKycRipCliArgs,
  type KycRipCliOptions,
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
  topics: `0x${string}`[];
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

export type EventCliOptions = KycRipCliOptions;

const EVENT_CLI_HELP = {
  scriptName: "worker/scripts/reconcile-blacklist-events-from-kyc-rip.ts",
  applyDescription: "Execute remote D1 reads and inserts",
  minRowsDescription: "Minimum accepted rows before reconciliation",
} as const;
const EVENT_CLI_USAGE = formatKycRipCliUsage(EVENT_CLI_HELP);

export type EventReconcileDependencies = {
  fetchImpl?: typeof fetch;
  d1?: RemoteD1Client;
  client?: ReceiptClient;
  log?: (message: string) => void;
};

export function parseEventArgs(argv: string[]): EventCliOptions {
  return parseKycRipCliArgs(argv, EVENT_CLI_HELP);
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
  const parsed = parseEvmLogs(
    config,
    receipt.logs.map((log) => ({
      address: log.address,
      topics: [...log.topics],
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

function redactUrlSecrets(message: string): string {
  return message.replace(/https?:\/\/[^\s)'",]+/g, (rawUrl) => {
    try {
      const url = new URL(rawUrl);
      return `${url.origin}/[redacted]`;
    } catch {
      return "[redacted-url]";
    }
  });
}

function formatRpcErrorForLog(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${redactUrlSecrets(error.message)}`;
  }
  return redactUrlSecrets(String(error));
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
  const rpcUrl = process.env.ETHEREUM_RPC_URL ?? "https://ethereum-rpc.publicnode.com";
  const client = dependencies.client ?? createPublicClient({ chain: mainnet, transport: http(rpcUrl) });
  const insertedRows: BlacklistRow[] = [];

  for (const candidate of candidates) {
    const config = getEthereumConfig(candidate.asset);
    try {
      const row = await fetchReceiptRow(
        client,
        config,
        candidate.address.toLowerCase(),
        candidate.tx_hash.toLowerCase() as `0x${string}`,
      );
      if (row) {
        insertedRows.push(row);
      }
    } catch (error) {
      dependencies.log?.(
        `Skipping ${candidate.asset} ${candidate.tx_hash}: receipt fetch failed (${formatRpcErrorForLog(error)})`,
      );
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
  if (writeCliHelpIfRequested(options, EVENT_CLI_USAGE)) return;
  await runEventReconciliation(options, { log: console.log });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCliEntrypoint(() => main(), {
    label: "reconcile-blacklist-events-from-kyc-rip",
    usage: EVENT_CLI_USAGE,
  });
}
