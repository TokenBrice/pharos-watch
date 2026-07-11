import { pathToFileURL } from "node:url";
import { buildBlacklistAddressCountKey } from "../../shared/lib/blacklist";
import { runCliEntrypoint, writeCliHelpIfRequested } from "../../scripts/lib/cli-args.mjs";
import { tronBase58ToHex } from "../src/lib/tron-address";
import {
  fetchKycRipRows,
  formatKycRipCliUsage,
  parseKycRipCliArgs,
  type KycRipCliOptions,
  type KycRipCurrentBalanceRow,
  type KycRipValidationStats,
} from "./lib/kyc-rip";
import { createRemoteD1Client, sqlString, type RemoteD1Client } from "./lib/remote-d1";

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

export type CurrentBalanceCliOptions = KycRipCliOptions;

const CURRENT_BALANCE_CLI_HELP = {
  scriptName: "worker/scripts/reconcile-blacklist-current-balances-from-kyc-rip.ts",
  applyDescription: "Execute the remote D1 replacement",
  minRowsDescription: "Minimum accepted rows before replacement",
} as const;
const CURRENT_BALANCE_CLI_USAGE = formatKycRipCliUsage(CURRENT_BALANCE_CLI_HELP);

export type CurrentBalanceReconcileDependencies = {
  fetchImpl?: typeof fetch;
  d1?: RemoteD1Client;
  now?: () => number;
  log?: (message: string) => void;
};

function buildCurrentBalanceId(stablecoin: "USDT" | "USDC", chainId: "ethereum" | "tron", address: string): string {
  return buildBlacklistAddressCountKey(stablecoin, chainId, address);
}

export function parseCurrentBalanceArgs(argv: string[]): CurrentBalanceCliOptions {
  return parseKycRipCliArgs(argv, CURRENT_BALANCE_CLI_HELP);
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
  validateReplacementRows(rows);
  return [
    "DELETE FROM blacklist_current_balances WHERE (stablecoin = 'USDT' AND chain_id = 'ethereum') OR (stablecoin = 'USDC' AND chain_id = 'ethereum') OR (stablecoin = 'USDT' AND chain_id = 'tron');",
    ...rows.map(
      (row) =>
        `INSERT OR REPLACE INTO blacklist_current_balances (id, stablecoin, chain_id, address, amount_native, amount_usd, source, status, observed_at, attempt_count, last_attempted_at, last_error_class)
       VALUES (${sqlString(row.id)}, ${sqlString(row.stablecoin)}, ${sqlString(row.chainId)}, ${sqlString(row.address)}, ${row.amountUsd}, ${row.amountUsd}, 'kyc_rip_bootstrap', 'resolved', ${observedAt}, 1, ${observedAt}, NULL);`,
    ),
  ];
}

function validateReplacementRows(rows: SnapshotRow[]): void {
  if (rows.length === 0) {
    throw new Error("refusing to replace blacklist_current_balances with zero normalized rows");
  }

  const ids = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (!row.id || !row.address) {
      throw new Error(`normalized row ${index} is missing an id or address`);
    }
    if (ids.has(row.id)) {
      throw new Error(`normalized row ${index} duplicates id ${row.id}`);
    }
    ids.add(row.id);
    if (!Number.isFinite(row.amountUsd)) {
      throw new Error(`normalized row ${index} has a non-finite amount`);
    }
  }
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
    targetRowsToDeleteNote:
      existingTargetRows == null
        ? "not queried in dry-run; all target-scope rows are replaced only in live mode"
        : undefined,
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
  validateReplacementRows(snapshots);

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
  if (writeCliHelpIfRequested(options, CURRENT_BALANCE_CLI_USAGE)) return;
  await runCurrentBalanceReconciliation(options, { log: console.log });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCliEntrypoint(() => main(), {
    label: "reconcile-blacklist-current-balances-from-kyc-rip",
    usage: CURRENT_BALANCE_CLI_USAGE,
  });
}
