import { pathToFileURL } from "node:url";
import { buildBlacklistAddressCountKey } from "../../shared/lib/blacklist";
import { tronBase58ToHex } from "../src/lib/tron-address";
import {
  fetchKycRipRows,
  type KycRipCurrentBalanceRow,
  type KycRipValidationStats,
} from "./lib/kyc-rip";
import {
  createRemoteD1Client,
  sqlString,
  type RemoteD1Client,
} from "./lib/remote-d1";

type SnapshotRow = {
  id: string;
  stablecoin: "USDT" | "USDC";
  chainId: "ethereum" | "tron";
  address: string;
  amountUsd: number;
};

type ExistingCountRow = {
  count: number;
};

export type CurrentBalanceCliOptions = {
  apply: boolean;
  remote: true;
  database: string;
  timeoutMs: number;
  minRows: number;
  providerUrl?: string;
};

export type CurrentBalanceReconcileDependencies = {
  fetchImpl?: typeof fetch;
  d1?: RemoteD1Client;
  now?: () => number;
  log?: (message: string) => void;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MIN_ROWS = 100;
const DEFAULT_DATABASE = "stablecoin-db";

function buildCurrentBalanceId(stablecoin: "USDT" | "USDC", chainId: "ethereum" | "tron", address: string): string {
  return buildBlacklistAddressCountKey(stablecoin, chainId, address);
}

export function parseCurrentBalanceArgs(argv: string[]): CurrentBalanceCliOptions {
  const options: CurrentBalanceCliOptions = {
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
  console.log(`Usage: tsx worker/scripts/reconcile-blacklist-current-balances-from-kyc-rip.ts [options]

Default mode is dry-run. Remote D1 writes require --apply.

Options:
  --apply                Execute the remote D1 replacement
  --remote               Target remote D1 (default and only supported D1 target)
  --timeout-ms <ms>      kyc.rip request timeout (default: ${DEFAULT_TIMEOUT_MS})
  --min-rows <count>     Minimum accepted rows before replacement (default: ${DEFAULT_MIN_ROWS})
  --database <name>      D1 database name (default: ${DEFAULT_DATABASE})
  --provider-url <url>   Override kyc.rip ban-list URL
  --help                 Show this help`);
}

export async function normalizeCurrentBalanceRows(rows: KycRipCurrentBalanceRow[]): Promise<SnapshotRow[]> {
  const snapshots: SnapshotRow[] = [];
  for (const row of rows) {
    if (row.chain === "ETH" && row.asset === "USDT") {
      const address = row.address.toLowerCase();
      snapshots.push({
        id: buildCurrentBalanceId("USDT", "ethereum", address),
        stablecoin: "USDT",
        chainId: "ethereum",
        address,
        amountUsd: Number(row.frozen_balance),
      });
      continue;
    }

    if (row.chain === "ETH" && row.asset === "USDC") {
      const address = row.address.toLowerCase();
      snapshots.push({
        id: buildCurrentBalanceId("USDC", "ethereum", address),
        stablecoin: "USDC",
        chainId: "ethereum",
        address,
        amountUsd: Number(row.frozen_balance),
      });
      continue;
    }

    if (row.chain === "TRON" && row.asset === "USDT") {
      const address = await tronBase58ToHex(row.address);
      if (!address) continue;
      snapshots.push({
        id: buildCurrentBalanceId("USDT", "tron", address),
        stablecoin: "USDT",
        chainId: "tron",
        address,
        amountUsd: Number(row.frozen_balance),
      });
    }
  }

  return snapshots;
}

function buildReplacementStatements(rows: SnapshotRow[], observedAt: number): string[] {
  return [
    `CREATE TEMP TABLE kyc_rip_current_balance_stage (
      id TEXT PRIMARY KEY,
      stablecoin TEXT NOT NULL,
      chain_id TEXT NOT NULL,
      address TEXT NOT NULL,
      amount_native REAL,
      amount_usd REAL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL,
      last_attempted_at INTEGER NOT NULL,
      last_error_class TEXT
    );`,
    ...rows.map((row) =>
      `INSERT INTO kyc_rip_current_balance_stage (id, stablecoin, chain_id, address, amount_native, amount_usd, source, status, observed_at, attempt_count, last_attempted_at, last_error_class)
       VALUES (${sqlString(row.id)}, ${sqlString(row.stablecoin)}, ${sqlString(row.chainId)}, ${sqlString(row.address)}, ${row.amountUsd}, ${row.amountUsd}, 'kyc_rip_bootstrap', 'resolved', ${observedAt}, 1, ${observedAt}, NULL);`,
    ),
    "DELETE FROM blacklist_current_balances WHERE (stablecoin = 'USDT' AND chain_id = 'ethereum') OR (stablecoin = 'USDC' AND chain_id = 'ethereum') OR (stablecoin = 'USDT' AND chain_id = 'tron');",
    `INSERT OR REPLACE INTO blacklist_current_balances (id, stablecoin, chain_id, address, amount_native, amount_usd, source, status, observed_at, attempt_count, last_attempted_at, last_error_class)
     SELECT id, stablecoin, chain_id, address, amount_native, amount_usd, source, status, observed_at, attempt_count, last_attempted_at, last_error_class
     FROM kyc_rip_current_balance_stage;`,
    "DROP TABLE kyc_rip_current_balance_stage;",
  ];
}

function summarizeByScope(rows: SnapshotRow[]): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    const key = `${row.stablecoin}:${row.chainId}`;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

function loadExistingTargetCount(d1: RemoteD1Client): number {
  const rows = d1.query<ExistingCountRow>(
    `SELECT COUNT(*) AS count
     FROM blacklist_current_balances
     WHERE (stablecoin = 'USDT' AND chain_id = 'ethereum')
        OR (stablecoin = 'USDC' AND chain_id = 'ethereum')
        OR (stablecoin = 'USDT' AND chain_id = 'tron')`,
  );
  return rows[0]?.count ?? 0;
}

function buildSummary(
  options: CurrentBalanceCliOptions,
  providerUrl: string,
  stats: KycRipValidationStats,
  snapshots: SnapshotRow[],
  existingTargetRows: number | null,
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
    normalizedRows: snapshots.length,
    skippedUnsupportedRows: stats.skippedUnsupportedRows,
    malformedRows: stats.malformedRows,
    malformedExamples: stats.malformedExamples,
    affectedAssetsChains: summarizeByScope(snapshots),
    targetRowsToDelete: existingTargetRows,
    targetRowsToDeleteNote: existingTargetRows == null ? "not queried in dry-run; all target-scope rows are replaced only with --apply" : undefined,
    rowsToInsert: snapshots.length,
  };
}

export async function runCurrentBalanceReconciliation(
  options: CurrentBalanceCliOptions,
  dependencies: CurrentBalanceReconcileDependencies = {},
): Promise<Record<string, unknown>> {
  const { rows, stats, providerUrl } = await fetchKycRipRows<KycRipCurrentBalanceRow>({
    mode: "current-balances",
    timeoutMs: options.timeoutMs,
    minRows: options.minRows,
    providerUrl: options.providerUrl,
    fetchImpl: dependencies.fetchImpl,
  });
  const snapshots = await normalizeCurrentBalanceRows(rows);
  if (snapshots.length < options.minRows) {
    throw new Error(`normalized ${snapshots.length} rows, below minimum ${options.minRows}`);
  }

  if (!options.apply) {
    const summary = buildSummary(options, providerUrl, stats, snapshots, null);
    dependencies.log?.(JSON.stringify(summary, null, 2));
    return summary;
  }

  const d1 = dependencies.d1 ?? createRemoteD1Client(options.database);
  const summary = buildSummary(options, providerUrl, stats, snapshots, loadExistingTargetCount(d1));
  dependencies.log?.(JSON.stringify(summary, null, 2));
  const observedAt = Math.floor((dependencies.now?.() ?? Date.now()) / 1000);
  d1.executeStatements(buildReplacementStatements(snapshots, observedAt), "blacklist-kyc-rip-reconcile");
  return summary;
}

async function main(): Promise<void> {
  const options = parseCurrentBalanceArgs(process.argv.slice(2));
  await runCurrentBalanceReconciliation(options, { log: console.log });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
