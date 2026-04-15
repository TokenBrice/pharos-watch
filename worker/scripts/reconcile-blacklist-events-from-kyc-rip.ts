import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, http, toHex } from "viem";
import { mainnet } from "viem/chains";
import { computeBlacklistAmountUsdAtEvent } from "../../shared/lib/blacklist";
import { getBlacklistTrackerMethodologyVersionAt } from "../../shared/lib/blacklist-tracker-version";
import {
  getBlacklistConfigsForSymbolAndChain,
  getBlacklistEventByTopic,
  type ContractEventConfig,
} from "../src/lib/blacklist-contracts";
import { decodeAddress, decodeUint256 } from "../src/lib/evm-logs";
import type { BlacklistRow } from "../src/cron/blacklist/shared";

type ExternalRow = {
  address: string;
  asset: "USDT" | "USDC";
  chain: "ETH" | "TRON";
  tx_hash: string;
};

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

function query(sql: string): unknown[] {
  const workerCwd = process.cwd().endsWith("/worker") ? process.cwd() : join(process.cwd(), "worker");
  const raw = execFileSync("npx", ["wrangler", "d1", "execute", "stablecoin-db", "--remote", "--json", "--command", sql], {
    cwd: workerCwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
    stdio: "pipe",
  });
  return JSON.parse(raw)[0]?.results ?? [];
}

function executeWrangler(file: string): void {
  const workerCwd = process.cwd().endsWith("/worker") ? process.cwd() : join(process.cwd(), "worker");
  execFileSync("npx", ["wrangler", "d1", "execute", "stablecoin-db", "--remote", "--json", "--file", file], {
    cwd: workerCwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
    stdio: "pipe",
  });
}

function sqlString(value: string | null): string {
  if (value == null) return "NULL";
  return `'${value.replace(/'/g, "''")}'`;
}

async function fetchAllExternalRows(): Promise<ExternalRow[]> {
  const rows: ExternalRow[] = [];
  const limit = 1000;
  let offset = 0;

  while (true) {
    const res = await fetch(`https://api.kyc.rip/v1/tools/ban-list?limit=${limit}&offset=${offset}`);
    if (!res.ok) throw new Error(`kyc.rip returned ${res.status}`);
    const json = await res.json() as { data?: ExternalRow[] };
    const batch = json.data ?? [];
    rows.push(...batch);
    if (batch.length < limit) return rows;
    offset += limit;
  }
}

function buildAddressKey(stablecoin: "USDT" | "USDC", address: string): string {
  return `${stablecoin}:${address.toLowerCase()}`;
}

function loadExistingEthereumBlacklistSet(): Set<string> {
  const rows = query(
    `SELECT stablecoin, chain_id, address
     FROM blacklist_events
     WHERE chain_id = 'ethereum'
       AND stablecoin IN ('USDT', 'USDC')
       AND event_type = 'blacklist'`,
  ) as ExistingRow[];

  return new Set(rows.map((row) => buildAddressKey(row.stablecoin, row.address)));
}

function getEthereumConfig(stablecoin: "USDT" | "USDC"): ContractEventConfig {
  const config = getBlacklistConfigsForSymbolAndChain(stablecoin, "ethereum")[0];
  if (!config) throw new Error(`Missing ethereum blacklist config for ${stablecoin}`);
  return config;
}

async function fetchReceiptRow(
  client: ReturnType<typeof createPublicClient>,
  config: ContractEventConfig,
  address: string,
  txHash: `0x${string}`,
) {
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

async function main() {
  const externalRows = await fetchAllExternalRows();
  const existing = loadExistingEthereumBlacklistSet();
  const candidates = externalRows.filter((row) =>
    row.chain === "ETH"
    && (row.asset === "USDT" || row.asset === "USDC")
    && !existing.has(buildAddressKey(row.asset, row.address)),
  );

  const client = createPublicClient({ chain: mainnet, transport: http("https://ethereum-rpc.publicnode.com") });
  const insertedRows = [];

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

  if (insertedRows.length > 0) {
    const tmpDir = mkdtempSync(join(tmpdir(), "blacklist-kyc-rip-events-"));
    try {
      const sqlFile = join(tmpDir, "reconcile-events.sql");
      // Temp SQL file is created under mkdtempSync() and never leaves this function.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      writeFileSync(sqlFile, insertedRows.map(buildInsertStatement).join("\n"));
      executeWrangler(sqlFile);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  console.log(JSON.stringify({
    candidates: candidates.length,
    inserted: insertedRows.length,
    byStablecoin: insertedRows.reduce<Record<string, number>>((acc, row) => {
      acc[row.stablecoin] = (acc[row.stablecoin] ?? 0) + 1;
      return acc;
    }, {}),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
