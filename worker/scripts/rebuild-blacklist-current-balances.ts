import { pathToFileURL } from "node:url";
import { runCliEntrypoint, writeCliHelpIfRequested } from "../../scripts/lib/cli-args.mjs";
import { computeBlacklistAmountUsdAtEvent } from "@shared/lib/blacklist";
import { buildBlacklistActiveRecords } from "@shared/lib/blacklist-active-records";
import { getBlacklistConfigsForSymbolAndChain, type ContractEventConfig } from "../src/lib/blacklist-contracts";
import { buildChainRpcs } from "../src/lib/chain-registry";
import { decimalNumberFromBigInt } from "../src/lib/bigint";
import { encodeBalanceOfCallData } from "../src/lib/evm-selectors";
import { createBudget, createRateLimiter } from "../src/lib/evm-logs";
import { fetchEvmTokenCurrentBalance } from "../src/lib/blacklist/balance-providers";
import { tronBase58ToHex } from "../src/lib/tron-address";
import type { BlacklistStablecoin } from "@shared/types/market";
import { BLACKLIST_CURRENT_BALANCE_WRITER_PAUSE_KEY } from "../src/lib/blacklist-current-balances";
import { describeDestructiveOperationMode, parseDestructiveOperationArgs } from "./lib/destructive-operation-guard";
import { parsePositiveInteger } from "./lib/kyc-rip";
import { createWorkerD1Client, sqlString, type RemoteD1Client } from "./lib/remote-d1";
import {
  applyBlacklistCurrentBalanceMaintenance,
  type CurrentBalanceMaintenanceRow,
} from "./lib/blacklist-current-balance-maintenance";

type BlacklistEventRow = {
  id: string;
  stablecoin: string;
  chain_id: string;
  chain_name: string;
  event_type: "blacklist" | "unblacklist" | "destroy";
  address: string;
  amount_native: number | null;
  amount_usd_at_event: number | null;
  amount_source: string;
  amount_status: string;
  tx_hash: string;
  block_number: number;
  transaction_index: number | null;
  timestamp: number;
  methodology_version: string | null;
  contract_address: string | null;
  config_key: string | null;
  event_signature: string | null;
  event_topic0: string | null;
  suppression_reason?: string | null;
  explorer_tx_url: string;
  explorer_address_url: string;
};

export type ScriptOptions = {
  help: boolean;
  remote: boolean;
  dryRun: boolean;
  force: boolean;
  armWriterPause: boolean;
  clearWriterPause: boolean;
  concurrency: number;
  requestsPerSecond: number;
  chainId: string;
  stablecoin: string;
};

const SCRIPT_NAME = "rebuild-blacklist-current-balances";
const MAX_PROVIDER_FAILURE_FRACTION = 0.1;
const SCRIPT_USAGE = `Usage: tsx worker/scripts/rebuild-blacklist-current-balances.ts [options]

Default mode is a local D1 dry-run. Live mutation requires --execute --confirm ${SCRIPT_NAME}.

Options:
  --execute                    Rebuild current balances
  --confirm <script>           Required for live mutation; value must be ${SCRIPT_NAME}
  --dry-run                    Force dry-run mode
  --force                      Continue when provider failures exceed 10%
  --arm-writer-pause           Preview or arm the blacklist writer pause
  --clear-writer-pause         Preview or clear the blacklist writer pause
  --local                      Target local D1 (default)
  --remote                     Target remote D1
  --concurrency <count>        Concurrent EVM balance workers (default: 20)
  --requests-per-second <n>    Provider request rate (default: 8)
  --chain <id>                 Chain id (default: tron)
  --stablecoin <symbol>        Stablecoin symbol (default: USDT)
  -h, --help                   Show this help`;

type CurrentBalanceWriteRow = CurrentBalanceMaintenanceRow;

type BlacklistRebuildD1Client = Pick<RemoteD1Client, "query">;


export function parseArgs(argv: string[]): ScriptOptions {
  const { mode: operationMode, values } = parseDestructiveOperationArgs({
    argv,
    cliOptions: {
      concurrency: { type: "string" },
      "requests-per-second": { type: "string" },
      chain: { type: "string" },
      stablecoin: { type: "string" },
      force: { type: "boolean" },
      "arm-writer-pause": { type: "boolean" },
      "clear-writer-pause": { type: "boolean" },
    },
    conflicts: [["arm-writer-pause", "clear-writer-pause"]],
    scriptName: SCRIPT_NAME,
  });
  const help = values.help === true;

  return {
    help,
    remote: operationMode.remote,
    dryRun: operationMode.dryRun,
    force: values.force === true,
    armWriterPause: values["arm-writer-pause"] === true,
    clearWriterPause: values["clear-writer-pause"] === true,
    concurrency: help || typeof values.concurrency !== "string"
      ? 20
      : parsePositiveInteger(values.concurrency, "--concurrency"),
    requestsPerSecond: help || typeof values["requests-per-second"] !== "string"
      ? 8
      : parsePositiveInteger(values["requests-per-second"], "--requests-per-second"),
    chainId: String(values.chain ?? "tron").toLowerCase(),
    stablecoin: String(values.stablecoin ?? "USDT").toUpperCase(),
  };
}

function buildCurrentBalanceWriteRow(
  stablecoin: BlacklistStablecoin,
  chainId: string,
  address: string,
  identity: Pick<ContractEventConfig, "configKey" | "contractAddress">,
  observedAt: number,
  amount: number | null,
  errorClass: string | null = null,
): CurrentBalanceWriteRow {
  return {
    configKey: identity.configKey,
    contractAddress: identity.contractAddress,
    stablecoin,
    chainId,
    address,
    amountNative: amount,
    amountUsd: computeBlacklistAmountUsdAtEvent(
      stablecoin as Parameters<typeof computeBlacklistAmountUsdAtEvent>[0],
      amount,
    ),
    source: "current_balance",
    status: amount == null ? "provider_failed" : "resolved",
    observedAt,
    lastSuccessfulObservedAt: amount == null ? null : observedAt,
    consecutiveFailures: amount == null ? 1 : 0,
    attemptCount: 1,
    lastAttemptedAt: observedAt,
    lastErrorClass: amount == null ? (errorClass ?? "provider_null") : null,
  };
}

export function assertBlacklistRebuildFailureRate(
  failedCount: number,
  activeCount: number,
  force: boolean,
): void {
  if (force || activeCount === 0 || failedCount <= activeCount * MAX_PROVIDER_FAILURE_FRACTION) return;
  throw new Error(
    `Refusing rebuild: ${failedCount}/${activeCount} provider lookups failed (maximum ${MAX_PROVIDER_FAILURE_FRACTION * 100}%). Re-run with --force only after reviewing the failures.`,
  );
}

export function assertBlacklistRebuildWriterGuard(d1: BlacklistRebuildD1Client, nowSec = Math.floor(Date.now() / 1000)): void {
  const pauseRows = d1.query<{ paused: number }>(
    // SAFETY: constant key escaped via sqlString.
    `SELECT 1 AS paused FROM cache WHERE key = ${sqlString(BLACKLIST_CURRENT_BALANCE_WRITER_PAUSE_KEY)} LIMIT 1`,
  );
  if (pauseRows[0]?.paused !== 1) {
    throw new Error(
      `Blacklist current-balance writer pause is not armed (${BLACKLIST_CURRENT_BALANCE_WRITER_PAUSE_KEY}).`,
    );
  }
  const leaseRows = d1.query<{ lease_until?: number }>(
    "SELECT lease_until FROM cron_leases WHERE job = 'sync-blacklist' LIMIT 1",
  );
  const leaseUntil = leaseRows[0]?.lease_until;
  if (typeof leaseUntil === "number" && leaseUntil >= nowSec) {
    throw new Error("sync-blacklist lease is active; aborting rebuild.");
  }
}

export function applyCurrentBalanceRebuild(
  d1: RemoteD1Client,
  rowsToWrite: readonly CurrentBalanceWriteRow[],
): void {
  assertBlacklistRebuildWriterGuard(d1);
  applyBlacklistCurrentBalanceMaintenance(
    d1,
    rowsToWrite,
    "blacklist-current-balances",
    () => assertBlacklistRebuildWriterGuard(d1),
  );
}

async function fetchTronCurrentBalanceRowsInBatches(
  active: Array<{ stablecoin: BlacklistStablecoin; chainId: string; address: string }>,
  contractAddress: string,
  decimals: number,
  identity: Pick<ContractEventConfig, "configKey" | "contractAddress">,
  apiKey: string | null,
  limiter: ReturnType<typeof createRateLimiter>,
): Promise<CurrentBalanceWriteRow[]> {
  const contractHex = await tronBase58ToHex(contractAddress);
  if (!contractHex) {
    throw new Error(`Could not convert TRON contract address to hex: ${contractAddress}`);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;

  const batchSize = 100;
  const rowsToWrite: CurrentBalanceWriteRow[] = [];

  for (let start = 0; start < active.length; start += batchSize) {
    const batch = active.slice(start, start + batchSize);
    const observedAt = Math.floor(Date.now() / 1000);

    try {
      const payload = batch.map((record, index) => ({
        jsonrpc: "2.0",
        id: index + 1,
        method: "eth_call",
        params: [
          {
            to: contractHex,
            data: encodeBalanceOfCallData(record.address),
          },
          "latest",
        ],
      }));
      const response = await limiter(async () => {
        const res = await fetch("https://api.trongrid.io/jsonrpc", {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<Array<{ id: number; result?: string; error?: { message?: string } }>>;
      });
      const byId = new Map(response.map((item) => [item.id, item]));
      for (let index = 0; index < batch.length; index++) {
        const record = batch[index]!;
        const item = byId.get(index + 1);
        const amount =
          item?.result && item.result.startsWith("0x") ? decimalNumberFromBigInt(BigInt(item.result), decimals) : null;
        rowsToWrite.push(
          buildCurrentBalanceWriteRow(
            record.stablecoin,
            record.chainId,
            record.address,
            identity,
            observedAt,
            amount,
            item?.error?.message?.slice(0, 200) ?? null,
          ),
        );
      }
    } catch (error) {
      const errorClass = error instanceof Error ? error.message.slice(0, 200) : "provider_error";
      for (const record of batch) {
        rowsToWrite.push(
          buildCurrentBalanceWriteRow(record.stablecoin, record.chainId, record.address, identity, observedAt, null, errorClass),
        );
      }
    }

    const completed = Math.min(start + batch.length, active.length);
    if (completed % 500 === 0 || completed === active.length) {
      console.log(JSON.stringify({ completed, total: active.length }, null, 2));
    }
  }

  return rowsToWrite;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (writeCliHelpIfRequested(options, SCRIPT_USAGE)) return;
  console.log(
    `Mode: ${describeDestructiveOperationMode({
      dryRun: options.dryRun,
      remote: options.remote,
      targetFlag: options.remote ? "--remote" : "--local",
    })}`,
  );
  const matchingConfigs = getBlacklistConfigsForSymbolAndChain(
    options.stablecoin as Parameters<typeof getBlacklistConfigsForSymbolAndChain>[0],
    options.chainId,
  );
  if (matchingConfigs.length !== 1) {
    throw new Error(
      `Expected exactly one blacklist config for ${options.stablecoin} on ${options.chainId}, got ${matchingConfigs.length}`,
    );
  }
  const [config] = matchingConfigs;
  const etherscanApiKey = process.env.ETHERSCAN_API_KEY ?? process.env.ETHERSCAN_V2_API_KEY ?? null;
  const trongridApiKey = process.env.TRONGRID_API_KEY ?? null;
  const drpcApiKey = process.env.DRPC_API_KEY ?? null;
  const chainRpcs = buildChainRpcs(process.env.ALCHEMY_API_KEY, process.env.DRPC_API_KEY);
  const limiter = createRateLimiter(Math.max(1, options.requestsPerSecond));
  const budget = createBudget(1_000_000);
  const d1 = createWorkerD1Client("stablecoin-db", options.remote ? "remote" : "local");

  if (options.armWriterPause || options.clearWriterPause) {
    const action = options.armWriterPause ? "arm-writer-pause" : "clear-writer-pause";
    if (options.dryRun) {
      console.log(JSON.stringify({
        action,
        mode: "dry-run",
        key: BLACKLIST_CURRENT_BALANCE_WRITER_PAUSE_KEY,
        remote: options.remote,
      }, null, 2));
      return;
    }
    const pausedAt = Math.floor(Date.now() / 1000);
    const pausePayload = sqlString(JSON.stringify({ reason: SCRIPT_NAME, pausedAt }));
    // SAFETY: the cache table is fixed and the constant key/payload are SQL-quoted by sqlString.
    const statement = options.armWriterPause
      ? `INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (${sqlString(BLACKLIST_CURRENT_BALANCE_WRITER_PAUSE_KEY)}, ${pausePayload}, ${pausedAt});`
      // SAFETY: constant key escaped via sqlString.
      : `DELETE FROM cache WHERE key = ${sqlString(BLACKLIST_CURRENT_BALANCE_WRITER_PAUSE_KEY)};`;
    d1.executeStatements([statement], "blacklist-current-balance-writer-pause");
    console.log(JSON.stringify({
      action,
      key: BLACKLIST_CURRENT_BALANCE_WRITER_PAUSE_KEY,
      remote: options.remote,
    }, null, 2));
    return;
  }

  // SAFETY: table/columns are fixed and both CLI-selected filters are SQL-quoted by sqlString.
  const sql = `
    SELECT id, stablecoin, chain_id, chain_name, event_type, address, amount_native, amount_usd_at_event,
           amount_source, amount_status, tx_hash, block_number, transaction_index, timestamp, methodology_version, contract_address,
           config_key, event_signature, event_topic0, suppression_reason, explorer_tx_url, explorer_address_url
    FROM blacklist_events
    WHERE stablecoin = ${sqlString(options.stablecoin)}
      AND chain_id = ${sqlString(options.chainId)}
    ORDER BY timestamp DESC
  `;
  const rows = d1.query<BlacklistEventRow>(sql);
  const events = rows.map((row) => ({
    id: row.id,
    stablecoin: row.stablecoin as BlacklistStablecoin,
    chainId: row.chain_id,
    chainName: row.chain_name,
    eventType: row.event_type,
    address: row.address,
    amountNative: row.amount_native,
    amountUsdAtEvent: row.amount_usd_at_event,
    amountSource: row.amount_source as "event" | "historical_balance" | "derived" | "unavailable",
    amountStatus: row.amount_status as
      | "resolved"
      | "recoverable_pending"
      | "permanently_unavailable"
      | "provider_failed"
      | "ambiguous",
    txHash: row.tx_hash,
    blockNumber: row.block_number,
    transactionIndex: row.transaction_index,
    timestamp: row.timestamp,
    methodologyVersion: row.methodology_version ?? "3.4",
    contractAddress: row.contract_address,
    configKey: row.config_key,
    eventSignature: row.event_signature,
    eventTopic0: row.event_topic0,
    suppressionReason: row.suppression_reason ?? null,
    explorerTxUrl: row.explorer_tx_url,
    explorerAddressUrl: row.explorer_address_url,
  }));

  // Only query this configured contract; other contracts' scoped histories remain untouched.
  const scopedEvents = events.filter((event) =>
    (!event.configKey || event.configKey.toLowerCase() === config.configKey.toLowerCase())
    && (!event.contractAddress || event.contractAddress.toLowerCase() === config.contractAddress.toLowerCase()),
  );
  const active = buildBlacklistActiveRecords(scopedEvents).filter(
    (record) => record.chainId === options.chainId && record.destroyedAt == null && !record.orderAmbiguityReason,
  );

  console.log(
    JSON.stringify(
      {
        dryRun: options.dryRun,
        remote: options.remote,
        stablecoin: options.stablecoin,
        chainId: options.chainId,
        configKey: config.configKey,
        activeCandidates: active.length,
      },
      null,
      2,
    ),
  );

  if (!options.dryRun) assertBlacklistRebuildWriterGuard(d1);

  const rowsToWrite: CurrentBalanceWriteRow[] = [];

  if (config.chain.type === "tron") {
    rowsToWrite.push(
      ...(await fetchTronCurrentBalanceRowsInBatches(
        active.map((record) => ({
          stablecoin: record.stablecoin,
          chainId: record.chainId,
          address: record.address,
        })),
        config.contractAddress,
        config.decimals,
        config,
        trongridApiKey,
        limiter,
      )),
    );
  } else {
    const queue = [...active];
    let completed = 0;

    async function worker(): Promise<void> {
      while (queue.length > 0) {
        const next = queue.pop();
        if (!next) return;
        const observedAt = Math.floor(Date.now() / 1000);
        try {
          const amount = await fetchEvmTokenCurrentBalance(
            config,
            next.address,
            etherscanApiKey,
            drpcApiKey,
            limiter,
            budget,
            AbortSignal.timeout(15_000),
            chainRpcs,
          );
          rowsToWrite.push(
            buildCurrentBalanceWriteRow(next.stablecoin, next.chainId, next.address, config, observedAt, amount),
          );
        } catch (error) {
          rowsToWrite.push(
            buildCurrentBalanceWriteRow(
              next.stablecoin,
              next.chainId,
              next.address,
              config,
              observedAt,
              null,
              error instanceof Error ? error.message.slice(0, 200) : "provider_error",
            ),
          );
        }
        completed++;
        if (completed % 250 === 0 || completed === active.length) {
          console.log(JSON.stringify({ completed, total: active.length }, null, 2));
        }
      }
    }

    await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, () => worker()));
  }

  if (active.length > 0 && rowsToWrite.length === 0) {
    throw new Error(
      `Refusing to refresh ${options.stablecoin}:${options.chainId} current balances: ${active.length} active rows produced no observations`,
    );
  }

  const failedCount = rowsToWrite.filter((row) => row.status !== "resolved").length;
  const resolvedTotal = rowsToWrite.reduce((sum, row) => sum + (row.amountUsd ?? 0), 0);

  if (!options.dryRun) {
    assertBlacklistRebuildFailureRate(failedCount, active.length, options.force);
    applyCurrentBalanceRebuild(d1, rowsToWrite);
  }

  console.log(
    JSON.stringify(
      {
        rebuilt: rowsToWrite.length,
        resolvedTotal,
        failedCount,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCliEntrypoint(() => main(), {
    label: SCRIPT_NAME,
    usage: SCRIPT_USAGE,
  });
}
