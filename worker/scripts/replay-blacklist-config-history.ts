import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertCliUsage, runCliEntrypoint, writeCliHelpIfRequested } from "../../scripts/lib/cli-args.mjs";
import { computeBlacklistAmountUsdAtEvent, isGoldBlacklistStablecoin } from "@shared/lib/blacklist";
import { blacklistCanonicalEventFilterSql, blacklistEventIdentity, blacklistEventIdentitySql } from "@shared/lib/blacklist-event-order";
import { parseEvmLogsWithCoverage } from "../src/cron/blacklist/evm-source";
import { buildBlacklistEventInsert } from "../src/cron/blacklist/persistence";
import { blockHashesForLogs, fetchAlchemyLogs, resolveBlockTimestamps, type AlchemyLogEntry } from "../src/lib/alchemy-logs";
import { getBlacklistConfigByKey, getBlacklistTopicHashes, type ContractEventConfig } from "../src/lib/blacklist-contracts";
import { getBlacklistDerivedCacheKeys } from "../src/lib/blacklist-cache-keys";
import { BLACKLIST_CURRENT_BALANCE_COLUMNS, BLACKLIST_CURRENT_BALANCE_UPSERT_POLICY, BLACKLIST_CURRENT_BALANCE_WRITER_PAUSE_KEY, buildBlacklistCurrentBalanceValues } from "../src/lib/blacklist-current-balances";
import { buildCurrentBalanceSnapshotRows } from "../src/lib/blacklist/row-preparation";
import { shouldSuppressAsMirrorZero, type BlacklistRow } from "../src/lib/blacklist/shared";
import { decimalNumberFromBigInt } from "../src/lib/bigint";
import { createBudget } from "../src/lib/evm-logs";
import { encodeBalanceOfCallData } from "../src/lib/evm-selectors";
import { fetchJsonWithRetry } from "../src/lib/fetch-retry";
import { bindBackfillSql } from "./lib/backfill-d1";
import type { CurrentBalanceMaintenanceRow } from "./lib/blacklist-current-balance-maintenance";
import { parseDestructiveOperationArgs } from "./lib/destructive-operation-guard";
import { createRemoteD1Client, sqlString, type RemoteD1Client } from "./lib/remote-d1";
import { assertBlacklistRebuildWriterGuard } from "./rebuild-blacklist-current-balances";

export const SCRIPT_NAME = "worker/scripts/replay-blacklist-config-history.ts";
const WORKER_CWD = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = `Usage: tsx ${SCRIPT_NAME} --config-key <key> --from-block <n> --to-block <n> [options]

Replay one configured EVM deployment's CURRENT event families in an inclusive historical window.
Default is remote, read-only dry-run (D1 SELECTs and RPC reads, no files or writes).

Options:
  --config-key <key>              Exact CONTRACT_CONFIGS key
  --from-block <n>                First block, inclusive (decimal)
  --to-block <n>                  Last block, inclusive; must not exceed the stored cursor
  --rpc-env <name>                RPC URL environment variable (default: BLACKLIST_REPLAY_RPC_URL)
  --chunk-blocks <n>              Outer RPC log page span (default: 100000)
  --database <name>               Remote D1 database (default: stablecoin-db)
  --execute                      Apply one atomic D1 file import (briefly blocks D1 writes)
  --confirm ${SCRIPT_NAME}
                                 Required confirmation for --execute
  --dry-run                      Force read-only mode
  --remote                       Remote D1 (default and only target)
  -h, --help                     Show this help

Apply also requires the existing blacklist current-balance writer pause and no active sync-blacklist lease.
The tool captures a Time Travel restore point immediately before its atomic import; it is not a concurrency token.
Never changes cursors. Amountless events remain NULL without exact event-position proof; current snapshots are separate.`;

export interface ReplayOptions {
  help: boolean;
  apply: boolean;
  configKey: string;
  fromBlock: number;
  toBlock: number;
  rpcEnv: string;
  chunkBlocks: number;
  database: string;
}
type RpcRequest = (method: string, params: unknown[]) => Promise<unknown>;
type Header = { number: string; hash: string; timestamp: string };
type Cursor = { cursor_kind: string; cursor_value: number | null; last_block: number; attempt_generation: number };
export interface ReplayDependencies {
  d1?: RemoteD1Client;
  rpc?: RpcRequest;
  loadLogs?: (config: ContractEventConfig, options: ReplayOptions, rpcUrl: string) => Promise<{ logs: AlchemyLogEntry[]; timestamps: Map<number, number> }>;
  captureRestorePoint?: (database: string) => string;
  now?: () => number;
  log?: (message: string) => void;
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function integer(value: unknown, flag: string, minimum = 0): number {
  assertCliUsage(typeof value === "string" && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= minimum,
    `${flag} must be a safe decimal integer >= ${minimum}`);
  return Number(value);
}
function requireConfig(key: string): ContractEventConfig {
  const config = getBlacklistConfigByKey(key);
  assertCliUsage(config != null && config.chain.type === "evm" && config.chain.evmChainId != null,
    "--config-key must identify an existing EVM CONTRACT_CONFIGS deployment");
  return config;
}
export function parseReplayArgs(argv: string[]): ReplayOptions {
  const { mode, values } = parseDestructiveOperationArgs({
    argv, scriptName: SCRIPT_NAME, defaultTarget: "--remote", localAllowed: false,
    cliOptions: {
      "config-key": { type: "string" }, "from-block": { type: "string" }, "to-block": { type: "string" },
      "rpc-env": { type: "string" }, "chunk-blocks": { type: "string" }, database: { type: "string" },
    },
  });
  const help = values.help === true;
  const configKey = String(values["config-key"] ?? "");
  const fromBlock = help ? 0 : integer(values["from-block"], "--from-block");
  const toBlock = help ? 0 : integer(values["to-block"], "--to-block");
  const rpcEnv = String(values["rpc-env"] ?? "BLACKLIST_REPLAY_RPC_URL");
  if (!help) {
    requireConfig(configKey);
    assertCliUsage(fromBlock <= toBlock, "--from-block must not exceed --to-block");
    assertCliUsage(/^[A-Z_][A-Z0-9_]*$/i.test(rpcEnv), "--rpc-env must be an environment variable name");
  }
  return { help, apply: !mode.dryRun, configKey, fromBlock, toBlock, rpcEnv,
    chunkBlocks: help ? 100_000 : integer(values["chunk-blocks"] ?? "100000", "--chunk-blocks", 1),
    database: String(values.database ?? "stablecoin-db") };
}
function rpcRequest(url: string): RpcRequest {
  return async (method, params) => {
    const response = await fetchJsonWithRetry<{ result?: unknown; error?: unknown }>(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }, 0, { timeoutMs: 30_000 });
    // Do not echo URL-bearing provider error messages or credentials.
    assert(response && response.body.error == null && response.body.result != null, `RPC ${method} failed or returned no result`);
    return response.body.result;
  };
}
function header(value: unknown, expectedNumber?: number): Header {
  assert(value != null && typeof value === "object", "RPC block header missing");
  const h = value as Partial<Header>;
  assert(typeof h.number === "string" && /^0x[0-9a-f]+$/i.test(h.number) && Number.isSafeInteger(Number(h.number))
    && typeof h.hash === "string" && /^0x[0-9a-f]{64}$/i.test(h.hash)
    && typeof h.timestamp === "string" && /^0x[0-9a-f]+$/i.test(h.timestamp) && Number.isSafeInteger(Number(h.timestamp)),
  "Malformed RPC block header");
  assert(expectedNumber == null || Number(h.number) === expectedNumber, "RPC returned the wrong block height");
  // RPC blocks also carry large transaction arrays; only these proven header fields belong in repeated audit observations.
  return { number: h.number, hash: h.hash, timestamp: h.timestamp };
}

/** Same complete-range splitter and current topic registry as normal EVM sync; no explorer row cap. */
export async function fetchReplayLogs(config: ContractEventConfig, options: ReplayOptions, rpcUrl: string) {
  const budget = createBudget(Number.MAX_SAFE_INTEGER);
  const logs: AlchemyLogEntry[] = [];
  const topics = getBlacklistTopicHashes(config);
  for (let from = options.fromBlock; from <= options.toBlock;) {
    const to = Math.min(options.toBlock, from + options.chunkBlocks - 1);
    const page = await fetchAlchemyLogs(rpcUrl, config.contractAddress,
      [{ index: 0, value: topics }], from, to, budget);
    assert(page?.complete && page.scannedToBlock === to, `Incomplete RPC log interval ${from}-${to}: ${page?.failureReason ?? "provider_error"}; no writes`);
    for (const log of page.logs) {
      assert(!log.removed && log.address.toLowerCase() === config.contractAddress.toLowerCase()
        && Number(log.blockNumber) >= from && Number(log.blockNumber) <= to
        && topics.some((topic) => topic.toLowerCase() === log.topics[0]?.toLowerCase()),
      "RPC returned an out-of-scope or removed log");
    }
    logs.push(...page.logs);
    if (to === options.toBlock) break;
    from = to + 1;
  }
  const timestamps = await resolveBlockTimestamps(rpcUrl, logs.map((log) => Number(log.blockNumber)), budget,
    { blockHashes: blockHashesForLogs(logs) });
  return { logs, timestamps };
}
function captureCurrentTimeTravelBookmark(database: string): string {
  const result: unknown = JSON.parse(execFileSync("npx", ["wrangler", "d1", "time-travel", "info", database, "--json"],
    { cwd: WORKER_CWD, encoding: "utf8", stdio: "pipe" }));
  assert(result != null && typeof result === "object" && "bookmark" in result
    && typeof result.bookmark === "string" && result.bookmark.trim().length > 0,
  "Time Travel restore point capture returned no bookmark; no writes");
  return result.bookmark;
}
function loadCursor(d1: RemoteD1Client, config: ContractEventConfig): Cursor {
  // SAFETY: the registry config key is escaped with sqlString, never interpolated as syntax.
  const rows = d1.query<Cursor>(`SELECT cursor_kind, cursor_value, last_block, attempt_generation FROM blacklist_sync_state WHERE config_key = ${sqlString(config.configKey)}`);
  assert(rows.length === 1 && rows[0]!.cursor_kind === "evm_block", "Configured EVM cursor is missing or has the wrong unit");
  const cursor = rows[0]!;
  assert(Number.isSafeInteger(cursor.cursor_value ?? cursor.last_block), "Invalid stored EVM cursor");
  return cursor;
}
function numeric(value: number | null): string {
  assert(value == null || Number.isFinite(value), "Non-finite replay amount");
  return value == null ? "NULL" : String(value);
}

export async function runConfigHistoryReplay(options: ReplayOptions, dependencies: ReplayDependencies = {}): Promise<Record<string, unknown>> {
  const config = requireConfig(options.configKey);
  assert(Number.isSafeInteger(options.fromBlock) && options.fromBlock >= 0 && Number.isSafeInteger(options.toBlock)
    && options.toBlock >= options.fromBlock && Number.isSafeInteger(options.chunkBlocks) && options.chunkBlocks > 0, "Invalid replay block window");
  const d1 = dependencies.d1 ?? createRemoteD1Client(options.database, {
    failedSqlDirectory: resolve(WORKER_CWD, "../agents/blacklist-history-replay-failures"),
  });
  const cursor = loadCursor(d1, config);
  const cursorBefore = cursor.cursor_value ?? cursor.last_block;
  assert(options.toBlock <= cursorBefore, `Refusing window beyond current cursor ${cursorBefore}; normal sync owns the frontier`);
  if (options.apply) assertBlacklistRebuildWriterGuard(d1);
  const rpcUrl = options.rpcEnv === "BLACKLIST_REPLAY_RPC_URL"
    ? process.env.BLACKLIST_REPLAY_RPC_URL
    : process.env[options.rpcEnv];
  assert(rpcUrl && /^https?:\/\//.test(rpcUrl), `Set ${options.rpcEnv} to an RPC endpoint with complete log history and historical eth_call support`);
  const rpc = dependencies.rpc ?? rpcRequest(rpcUrl);
  const chainId = await rpc("eth_chainId", []);
  assert(typeof chainId === "string" && Number(chainId) === config.chain.evmChainId, "RPC chain ID does not match configured deployment");
  const { logs, timestamps } = await (dependencies.loadLogs ?? fetchReplayLogs)(config, options, rpcUrl);
  const parsed = parseEvmLogsWithCoverage(config, logs, timestamps);
  assert(parsed.failures.length === 0 && parsed.coverageCeiling == null, "Canonical parser could not prove complete log coverage; no writes");
  const unique = new Map<string, BlacklistRow>();
  for (const row of parsed.rows) {
    const identity = blacklistEventIdentity(row);
    const previous = unique.get(identity);
    assert(!previous || JSON.stringify(previous) === JSON.stringify(row), `Conflicting duplicate RPC identity ${row.id}`);
    unique.set(identity, row);
  }
  // SAFETY: chain identity is sqlString-escaped; both block bounds were validated as safe integers above.
  const stored = d1.query<BlacklistRow>(`SELECT * FROM blacklist_events WHERE chain_id = ${sqlString(config.chain.chainId)} AND block_number BETWEEN ${options.fromBlock} AND ${options.toBlock}`);
  const existing = new Map(stored.map((row) => [blacklistEventIdentity(row), row]));
  const missing = [...unique].filter(([identity, row]) => {
    const prior = existing.get(identity);
    if (!prior) return true;
    assert(prior.address.toLowerCase() === row.address.toLowerCase() && prior.event_type === row.event_type
      && prior.block_number === row.block_number && (prior.config_key == null || prior.config_key === row.config_key)
      && (prior.contract_address == null || prior.contract_address.toLowerCase() === config.contractAddress.toLowerCase()),
    `Stored event conflicts with canonical RPC identity ${row.id}; review manually`);
    return false;
  }).map(([, row]) => row);
  const now = Math.floor((dependencies.now ?? Date.now)() / 1000);
  const observations: unknown[] = [];
  const readBalance = async (address: string, block: Header): Promise<number | null> => {
    try {
      const raw = await rpc("eth_call", [{ to: config.contractAddress, data: encodeBalanceOfCallData(address) },
        { blockHash: block.hash, requireCanonical: true }]);
      assert(typeof raw === "string" && /^0x[0-9a-f]{64}$/i.test(raw), "Invalid balanceOf result");
      const amount = decimalNumberFromBigInt(BigInt(raw), config.decimals);
      assert(Number.isFinite(amount) && amount >= 0, "Unrepresentable balanceOf result");
      observations.push({ address, block, raw });
      return amount;
    } catch {
      observations.push({ address, block, unavailable: "historical_or_pinned_balance_unavailable" });
      return null;
    }
  };
  for (const row of missing) {
    if (row.amount_native != null) continue; // Emitted amounts always win, including destroy amounts.
    // A hash-pinned preceding-block balance still cannot prove the balance at
    // this event's log position. Keep historical attribution unavailable.
    row.amount_source = "unavailable";
    row.amount_status = "provider_failed";
    row.amount_last_provider = "none";
    row.amount_last_error_class = "event_time_unproven";
  }
  for (const row of missing) {
    if (shouldSuppressAsMirrorZero(row.stablecoin, row.event_type, row.amount_native, row.amount_source)) {
      row.suppression_reason = "circle_mirror_zero_balance";
    }
  }
  const publicMissing = missing.filter((row) => row.suppression_reason == null);
  const affected = [...new Set(publicMissing.map((row) => row.address))];
  const balances: CurrentBalanceMaintenanceRow[] = [];
  let currentHead: Header | null = null;
  let retainedLifecycle: BlacklistRow[] = [];
  if (affected.length > 0) {
    // Read the full lifecycle, not merely the replay window: later destroys/releases own the retained snapshot.
    // SAFETY: registry identities and affected addresses are sqlString literals; the canonical filter is source-owned SQL.
    const ledger = d1.query<BlacklistRow>(`SELECT * FROM blacklist_events WHERE chain_id = ${sqlString(config.chain.chainId)}
      AND stablecoin = ${sqlString(config.stablecoin)} AND (config_key = ${sqlString(config.configKey)} OR (config_key IS NULL AND lower(contract_address) = ${sqlString(config.contractAddress.toLowerCase())}))
      AND lower(address) IN (${affected.map(sqlString).join(", ")}) AND ${blacklistCanonicalEventFilterSql()}`);
    retainedLifecycle = ledger;
    const snapshots = buildCurrentBalanceSnapshotRows([...ledger.map((row) => ({ ...row, config_key: config.configKey, contract_address: config.contractAddress })), ...publicMissing]);
    currentHead = header(await rpc("eth_getBlockByNumber", ["latest", false]));
    assert(Number(currentHead.number) >= options.toBlock, "RPC head is behind replay window");
    for (const row of snapshots) {
      if (row.event_type === "unblacklist" || (row.event_type === "destroy" && row.amount_native == null)) continue;
      let amount = row.event_type === "destroy" ? row.amount_native : await readBalance(row.address, currentHead);
      let source = row.event_type === "destroy" ? "destroy_event" : "current_balance";
      if (row.event_type === "blacklist" && isGoldBlacklistStablecoin(config.stablecoin) && amount === 0 && row.amount_native != null && row.amount_native > 0) {
        amount = row.amount_native;
        source = "gold_event_zero_balance";
      }
      const observedAt = row.event_type === "destroy" ? row.timestamp : now;
      balances.push({ stablecoin: config.stablecoin, chainId: config.chain.chainId, address: row.address,
        configKey: config.configKey, contractAddress: config.contractAddress, amountNative: amount,
        amountUsd: row.event_type === "destroy" ? row.amount_usd_at_event : computeBlacklistAmountUsdAtEvent(config.stablecoin, amount),
        source, status: amount == null ? "provider_failed" : "resolved", observedAt,
        lastSuccessfulObservedAt: amount == null ? null : observedAt, attemptCount: 1,
        lastAttemptedAt: now, lastErrorClass: amount == null ? "provider_null" : null, consecutiveFailures: amount == null ? 1 : 0 });
    }
  }
  let timeTravelBookmark: string | null = null;
  if (options.apply && missing.length > 0) {
    assertBlacklistRebuildWriterGuard(d1);
    timeTravelBookmark = (dependencies.captureRestorePoint ?? captureCurrentTimeTravelBookmark)(options.database);
    assert(typeof timeTravelBookmark === "string" && timeTravelBookmark.trim().length > 0,
      "Time Travel restore point capture returned no bookmark; no writes");
    // Print before import so an uncertain/failed import still leaves an operator-visible restore point.
    dependencies.log?.(JSON.stringify({ status: "restore-point-captured", configKey: config.configKey, timeTravelBookmark }));
  }
  const evidence = { tool: SCRIPT_NAME, config, fromBlock: options.fromBlock, toBlock: options.toBlock,
    rpcOrigin: new URL(rpcUrl).origin, logs: [...logs].sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex)),
    timestamps: [...timestamps].sort(([a], [b]) => a - b), retainedLifecycle, observations, currentHead, timeTravelBookmark };
  const evidenceSha256 = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
  const summary = { mode: options.apply ? "apply" : "dry-run", configKey: config.configKey,
    fromBlock: options.fromBlock, toBlock: options.toBlock, cursorBefore, cursorAfter: cursorBefore,
    currentTopics: getBlacklistTopicHashes(config), fetchedLogCount: logs.length, canonicalEventCount: unique.size,
    existingEventCount: unique.size - missing.length, missingEventCount: missing.length, insertedEventCount: 0,
    affectedBalanceCount: balances.length, unresolvedAmountCount: missing.filter((row) => row.amount_native == null).length,
    evidenceSha256, timeTravelBookmark, missingEventIds: missing.map((row) => row.id), runId: null as string | null,
    status: "ready" };
  if (!options.apply || missing.length === 0) {
    summary.status = options.apply ? "unchanged" : "ready";
    dependencies.log?.(JSON.stringify(summary, null, 2));
    return summary;
  }
  const runId = `blacklist-history-replay:${randomUUID()}`;
  const details = JSON.stringify({ ...summary, tool: SCRIPT_NAME, runId,
    evidence, balanceIdentities: balances.map((row) => buildBlacklistCurrentBalanceValues(row)[0]) });
  const missingIdentities = missing.map((row) => sqlString(blacklistEventIdentity(row))).join(", ");
  const guard = `(SELECT COUNT(*) FROM blacklist_sync_state WHERE config_key = ${sqlString(config.configKey)}
      AND cursor_kind = 'evm_block' AND cursor_value IS ${numeric(cursor.cursor_value)} AND last_block = ${cursor.last_block}
      AND attempt_generation = ${cursor.attempt_generation}) = 1
    AND EXISTS (SELECT 1 FROM cache WHERE key = ${sqlString(BLACKLIST_CURRENT_BALANCE_WRITER_PAUSE_KEY)})
    AND NOT EXISTS (SELECT 1 FROM cron_leases WHERE job = 'sync-blacklist' AND lease_until >= unixepoch())
    AND NOT EXISTS (SELECT 1 FROM blacklist_events WHERE (${blacklistEventIdentitySql()}) IN (${missingIdentities}))`;
  const statements = [
    // The existing audit CHECK aborts the entire file import on a changed cursor, active writer, or raced identity.
    `INSERT INTO admin_action_audit(created_at, actor, action, target, result, details_json, intent_key)
      SELECT ${now}, 'operator-cli', 'replay-blacklist-config-history', ${sqlString(config.configKey)},
      CASE WHEN ${guard} THEN 'ok' ELSE 'guard_failed' END, ${sqlString(details)}, ${sqlString(runId)};`,
    `DELETE FROM cache WHERE key IN (${getBlacklistDerivedCacheKeys().map(sqlString).join(", ")});`,
  ];
  for (const row of missing) {
    const insert = buildBlacklistEventInsert(row);
    statements.push(`${bindBackfillSql(insert.sql, insert.bindings)};`,
      // SAFETY: provenance and row identity are sqlString literals; now is a local integer Unix timestamp.
      `UPDATE blacklist_events SET reconciliation_manifest_id = ${sqlString(`sha256:${evidenceSha256}`)},
       reconciliation_run_id = ${sqlString(runId)}, provenance_source = ${sqlString(`${SCRIPT_NAME}:${evidenceSha256}`)},
       provenance_observed_at = ${now} WHERE id = ${sqlString(row.id)};`);
  }
  for (const row of balances) {
    const values = buildBlacklistCurrentBalanceValues(row).map((value) => typeof value === "number" ? numeric(value) : sqlString(value));
    // SAFETY: columns/policy are source-owned SQL; values contain only sqlString literals or validated finite numbers.
    statements.push(`INSERT INTO blacklist_current_balances (${BLACKLIST_CURRENT_BALANCE_COLUMNS}) VALUES (${values.join(", ")}) ${BLACKLIST_CURRENT_BALANCE_UPSERT_POLICY};`);
  }
  // SAFETY: run identity is sqlString-escaped; expected count is the admitted array length.
  // Count actual inserts inside the same transaction; a mismatch fails the audit CHECK and rolls back everything.
  statements.push(`UPDATE admin_action_audit SET
    result = CASE WHEN (SELECT COUNT(*) FROM blacklist_events WHERE reconciliation_run_id = ${sqlString(runId)}) = ${missing.length}
      THEN 'ok' ELSE 'guard_failed' END,
    details_json = json_set(details_json, '$.status', 'applied',
      '$.insertedEventCount', (SELECT COUNT(*) FROM blacklist_events WHERE reconciliation_run_id = ${sqlString(runId)}),
      '$.plannedMissingEventCount', ${missing.length}, '$.missingEventCount', 0)
    WHERE action = 'replay-blacklist-config-history' AND intent_key = ${sqlString(runId)};`);
  // One array entry is one transactional file import even with the remote client's 200-statement batching.
  d1.executeStatements([statements.join("\n")], "blacklist-history-replay");
  // SAFETY: the generated UUID-based run identity is escaped with sqlString.
  const inserted = d1.query<{ id: string }>(`SELECT id FROM blacklist_events WHERE reconciliation_run_id = ${sqlString(runId)}`);
  assert(inserted.length === missing.length && missing.every((row) => inserted.some((saved) => saved.id === row.id)), "Replay readback failed; inspect the audit and Time Travel bookmark");
  const after = loadCursor(d1, config);
  assert(JSON.stringify(after) === JSON.stringify(cursor), "Cursor changed during replay; inspect concurrent sync activity");
  summary.runId = runId;
  summary.insertedEventCount = inserted.length;
  summary.status = "verified";
  dependencies.log?.(JSON.stringify(summary, null, 2));
  return summary;
}
async function main(): Promise<void> {
  const options = parseReplayArgs(process.argv.slice(2));
  if (writeCliHelpIfRequested(options, USAGE)) return;
  await runConfigHistoryReplay(options, { log: console.log });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCliEntrypoint(main, { label: "replay-blacklist-config-history", usage: USAGE });
}
