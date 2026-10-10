import { pathToFileURL } from "node:url";
import { buildBlacklistContractBalanceKey } from "@shared/lib/blacklist";
import { getBlacklistConfigsForSymbolAndChain } from "../src/lib/blacklist-contracts";
import { applyBlacklistCurrentBalanceMaintenance } from "./lib/blacklist-current-balance-maintenance";
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
import { createRemoteD1Client, type RemoteD1Client } from "./lib/remote-d1";

type SnapshotRow = {
  id: string;
  stablecoin: "USDT" | "USDC";
  chainId: "ethereum" | "tron";
  address: string;
  configKey: string;
  contractAddress: string;
  amountUsd: number;
};

type ExistingCountRow = {
  count: number;
};

export type CurrentBalanceCliOptions = KycRipCliOptions;

const CURRENT_BALANCE_CLI_HELP = {
  scriptName: "worker/scripts/reconcile-blacklist-current-balances-from-kyc-rip.ts",
  applyDescription: "Admit and upsert remote D1 scoped observations",
  minRowsDescription: "Minimum accepted rows before admission",
} as const;
const CURRENT_BALANCE_CLI_USAGE = formatKycRipCliUsage(CURRENT_BALANCE_CLI_HELP);

export type CurrentBalanceReconcileDependencies = {
  fetchImpl?: typeof fetch;
  d1?: RemoteD1Client;
  now?: () => number;
  log?: (message: string) => void;
};

function buildSnapshotRow(
  stablecoin: "USDT" | "USDC",
  chainId: "ethereum" | "tron",
  address: string,
  amountUsd: number,
): SnapshotRow {
  const configs = getBlacklistConfigsForSymbolAndChain(stablecoin, chainId);
  if (configs.length !== 1) throw new Error(`Expected exactly one blacklist config for ${stablecoin}:${chainId}`);
  const config = configs[0]!;
  return {
    id: buildBlacklistContractBalanceKey(stablecoin, chainId, address, config.configKey, config.contractAddress),
    stablecoin,
    chainId,
    address,
    configKey: config.configKey,
    contractAddress: config.contractAddress,
    amountUsd,
  };
}

export function parseCurrentBalanceArgs(argv: string[]): CurrentBalanceCliOptions {
  return parseKycRipCliArgs(argv, CURRENT_BALANCE_CLI_HELP);
}

export async function normalizeCurrentBalanceRows(rows: KycRipCurrentBalanceRow[]): Promise<SnapshotRow[]> {
  const snapshots: SnapshotRow[] = [];
  for (const row of rows) {
    if (row.chain === "ETH" && row.asset === "USDT") {
      const address = row.address.toLowerCase();
      snapshots.push(buildSnapshotRow("USDT", "ethereum", address, Number(row.frozen_balance)));
      continue;
    }

    if (row.chain === "ETH" && row.asset === "USDC") {
      const address = row.address.toLowerCase();
      snapshots.push(buildSnapshotRow("USDC", "ethereum", address, Number(row.frozen_balance)));
      continue;
    }

    if (row.chain === "TRON" && row.asset === "USDT") {
      const address = await tronBase58ToHex(row.address);
      if (!address) continue;
      snapshots.push(buildSnapshotRow("USDT", "tron", address, Number(row.frozen_balance)));
    }
  }

  return snapshots;
}

function applyObservations(d1: RemoteD1Client, rows: SnapshotRow[], observedAt: number): void {
  applyBlacklistCurrentBalanceMaintenance(d1, rows.map((row) => ({
    ...row,
    amountNative: row.amountUsd,
    source: "kyc_rip_bootstrap",
    status: "resolved" as const,
    observedAt,
    lastSuccessfulObservedAt: observedAt,
    attemptCount: 1,
    lastAttemptedAt: observedAt,
    lastErrorClass: null,
    consecutiveFailures: 0,
  })), "blacklist-kyc-rip-reconcile");
}

function validateObservationRows(rows: SnapshotRow[]): void {
  if (rows.length === 0) {
    throw new Error("refusing to admit blacklist_current_balances with zero normalized rows");
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
    existingTargetRows,
    retainedLedgerRows: "All existing identities remain; only admitted scoped observations are upserted.",
    rowsToUpsert: snapshots.length,
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
  validateObservationRows(snapshots);

  if (!options.apply) {
    const summary = buildSummary(options, providerUrl, stats, snapshots, null);
    dependencies.log?.(JSON.stringify(summary, null, 2));
    return summary;
  }

  const d1 = dependencies.d1 ?? createRemoteD1Client(options.database);
  const summary = buildSummary(options, providerUrl, stats, snapshots, loadExistingTargetCount(d1));
  dependencies.log?.(JSON.stringify(summary, null, 2));
  const observedAt = Math.floor((dependencies.now?.() ?? Date.now()) / 1000);
  applyObservations(d1, snapshots, observedAt);
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
