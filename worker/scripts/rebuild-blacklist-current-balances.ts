import { pathToFileURL } from "node:url";
import { buildBlacklistAddressCountKey } from "../../shared/lib/blacklist";
import { computeBlacklistAmountUsdAtEvent } from "../../shared/lib/blacklist";
import { buildBlacklistActiveRecords } from "../../shared/lib/blacklist-active-records";
import { getBlacklistConfigsForSymbolAndChain } from "../src/lib/blacklist-contracts";
import { buildChainRpcs } from "../src/lib/chain-registry";
import { decimalNumberFromBigInt } from "../src/lib/bigint";
import { encodeBalanceOfCallData } from "../src/lib/evm-selectors";
import { createBudget, createRateLimiter } from "../src/lib/evm-logs";
import { fetchEvmTokenCurrentBalance } from "../src/cron/blacklist/balance-providers";
import { tronBase58ToHex } from "../src/lib/tron-address";
import type { BlacklistStablecoin } from "../../shared/types/market";
import { describeDestructiveOperationMode, parseDestructiveOperationMode } from "./lib/destructive-operation-guard";
import { parsePositiveInteger } from "./lib/kyc-rip";
import { createWorkerD1Client, sqlString } from "./lib/remote-d1";

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
  remote: boolean;
  dryRun: boolean;
  concurrency: number;
  requestsPerSecond: number;
  chainId: string;
  stablecoin: string;
};

type CurrentBalanceWriteRow = {
  id: string;
  stablecoin: string;
  chainId: string;
  address: string;
  amountNative: number | null;
  amountUsd: number | null;
  source: string;
  status: "resolved" | "provider_failed";
  observedAt: number;
  attemptCount: number;
  lastAttemptedAt: number;
  lastErrorClass: string | null;
};

function parsePositiveIntegerFlag(args: Map<string, string | boolean>, flag: string, fallback: number): number {
  const value = args.get(flag);
  if (value == null) return fallback;
  if (typeof value === "boolean") throw new Error(`--${flag} requires a value`);
  return parsePositiveInteger(value, `--${flag}`);
}

function buildCurrentBalanceId(stablecoin: string, chainId: string, address: string): string {
  return buildBlacklistAddressCountKey(
    stablecoin as Parameters<typeof buildBlacklistAddressCountKey>[0],
    chainId,
    address,
  );
}

export function parseArgs(argv: string[]): ScriptOptions {
  const args = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const inlineValueIndex = arg.indexOf("=");
    if (inlineValueIndex > 2) {
      args.set(arg.slice(2, inlineValueIndex), arg.slice(inlineValueIndex + 1));
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args.set(key, true);
      continue;
    }
    args.set(key, next);
    index++;
  }
  const operationMode = parseDestructiveOperationMode({
    argv,
    scriptName: "rebuild-blacklist-current-balances",
  });

  return {
    remote: operationMode.remote,
    dryRun: operationMode.dryRun,
    concurrency: parsePositiveIntegerFlag(args, "concurrency", 20),
    requestsPerSecond: parsePositiveIntegerFlag(args, "requests-per-second", 8),
    chainId: String(args.get("chain") ?? "tron").toLowerCase(),
    stablecoin: String(args.get("stablecoin") ?? "USDT").toUpperCase(),
  };
}

function buildCurrentBalanceWriteRow(
  stablecoin: string,
  chainId: string,
  address: string,
  observedAt: number,
  amount: number | null,
  errorClass: string | null = null,
): CurrentBalanceWriteRow {
  return {
    id: buildCurrentBalanceId(stablecoin as Parameters<typeof buildCurrentBalanceId>[0], chainId, address),
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
    attemptCount: 1,
    lastAttemptedAt: observedAt,
    lastErrorClass: amount == null ? (errorClass ?? "provider_null") : null,
  };
}

async function fetchTronCurrentBalanceRowsInBatches(
  active: Array<{ stablecoin: string; chainId: string; address: string }>,
  contractAddress: string,
  decimals: number,
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
          buildCurrentBalanceWriteRow(record.stablecoin, record.chainId, record.address, observedAt, null, errorClass),
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
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

  const sql = `
    SELECT id, stablecoin, chain_id, chain_name, event_type, address, amount_native, amount_usd_at_event,
           amount_source, amount_status, tx_hash, block_number, timestamp, methodology_version, contract_address,
           config_key, event_signature, event_topic0, suppression_reason, explorer_tx_url, explorer_address_url
    FROM blacklist_events
    WHERE stablecoin = ${sqlString(options.stablecoin)}
      AND chain_id = ${sqlString(options.chainId)}
    ORDER BY timestamp DESC
  `;
  const raw = d1.queryRaw(sql);
  const rows = (JSON.parse(raw)[0]?.results ?? []) as BlacklistEventRow[];
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

  const active = buildBlacklistActiveRecords(events).filter(
    (record) => record.chainId === options.chainId && record.destroyedAt == null,
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

  if (options.dryRun) return;

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
            buildCurrentBalanceWriteRow(next.stablecoin, next.chainId, next.address, observedAt, amount),
          );
        } catch (error) {
          rowsToWrite.push(
            buildCurrentBalanceWriteRow(
              next.stablecoin,
              next.chainId,
              next.address,
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
      `Refusing to delete ${options.stablecoin}:${options.chainId} current balances: ${active.length} active rows produced no replacement rows`,
    );
  }

  d1.executeStatements(
    [
      // SAFETY: stablecoin and chainId are constrained by getBlacklistConfigsForSymbolAndChain() before writes, and sqlString() quotes both values.
      `DELETE FROM blacklist_current_balances WHERE stablecoin = ${sqlString(options.stablecoin)} AND chain_id = ${sqlString(options.chainId)};`,
      ...rowsToWrite.map(
        (row) =>
          `INSERT INTO blacklist_current_balances (id, stablecoin, chain_id, address, amount_native, amount_usd, source, status, observed_at, attempt_count, last_attempted_at, last_error_class)
       VALUES (${sqlString(row.id)}, ${sqlString(row.stablecoin)}, ${sqlString(row.chainId)}, ${sqlString(row.address)}, ${row.amountNative ?? "NULL"}, ${row.amountUsd ?? "NULL"}, ${sqlString(row.source)}, ${sqlString(row.status)}, ${row.observedAt}, ${row.attemptCount}, ${row.lastAttemptedAt}, ${sqlString(row.lastErrorClass)})
       ON CONFLICT(id) DO UPDATE SET
         amount_native = excluded.amount_native,
         amount_usd = excluded.amount_usd,
         source = excluded.source,
         status = excluded.status,
         observed_at = excluded.observed_at,
         attempt_count = excluded.attempt_count,
         last_attempted_at = excluded.last_attempted_at,
         last_error_class = excluded.last_error_class;`,
      ),
    ],
    "blacklist-current-balances",
  );

  const resolvedTotal = rowsToWrite.reduce((sum, row) => sum + (row.amountUsd ?? 0), 0);
  const failedCount = rowsToWrite.filter((row) => row.status !== "resolved").length;
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
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
