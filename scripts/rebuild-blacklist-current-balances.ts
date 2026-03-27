import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeBlacklistAmountUsdAtEvent } from "../shared/lib/blacklist";
import { buildBlacklistActiveRecords } from "../shared/lib/blacklist-active-records";
import { getBlacklistConfigsForSymbolAndChain } from "../worker/src/lib/blacklist-contracts";
import { buildChainRpcs } from "../worker/src/lib/chain-registry";
import { bigIntToDecimal } from "../worker/src/lib/bigint";
import { buildBlacklistCurrentBalanceId } from "../worker/src/lib/blacklist-current-balances";
import { createBudget, createRateLimiter } from "../worker/src/lib/evm-logs";
import {
  fetchEvmTokenCurrentBalance,
} from "../worker/src/cron/blacklist/balance-providers";
import { tronBase58ToHex } from "../worker/src/lib/tron-address";

type ExecuteWranglerOptions = {
  remote: boolean;
  sql?: string;
  file?: string;
};

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
  explorer_tx_url: string;
  explorer_address_url: string;
};

type ScriptOptions = {
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

function parseArgs(argv: string[]): ScriptOptions {
  const args = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args.set(key, true);
      continue;
    }
    args.set(key, next);
    index++;
  }

  return {
    remote: args.get("local") !== true,
    dryRun: args.get("dry-run") === true,
    concurrency: Number(args.get("concurrency") ?? 20),
    requestsPerSecond: Number(args.get("requests-per-second") ?? 8),
    chainId: String(args.get("chain") ?? "tron").toLowerCase(),
    stablecoin: String(args.get("stablecoin") ?? "USDT").toUpperCase(),
  };
}

function executeWrangler(options: ExecuteWranglerOptions): string {
  const command = options.sql
    ? ["d1", "execute", "stablecoin-db", options.remote ? "--remote" : "--local", "--json", "--command", options.sql]
    : ["d1", "execute", "stablecoin-db", options.remote ? "--remote" : "--local", "--json", "--file", options.file!];
  return execFileSync("npx", ["wrangler", ...command], {
    cwd: join(process.cwd(), "worker"),
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  });
}

function sqlString(value: string | null): string {
  if (value == null) return "NULL";
  return `'${value.replace(/'/g, "''")}'`;
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
    id: buildBlacklistCurrentBalanceId(
      stablecoin as Parameters<typeof buildBlacklistCurrentBalanceId>[0],
      chainId,
      address,
    ),
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
            data: "0x70a08231" + record.address.slice(2).padStart(64, "0"),
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
        const amount = item?.result && item.result.startsWith("0x")
          ? bigIntToDecimal(BigInt(item.result), decimals)
          : null;
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
          buildCurrentBalanceWriteRow(
            record.stablecoin,
            record.chainId,
            record.address,
            observedAt,
            null,
            errorClass,
          ),
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
  const chainRpcs = buildChainRpcs(process.env.ALCHEMY_API_KEY, process.env.DRPC_API_KEY);
  const limiter = createRateLimiter(Math.max(1, options.requestsPerSecond));
  const budget = createBudget(1_000_000);

  const sql = `
    SELECT id, stablecoin, chain_id, chain_name, event_type, address, amount_native, amount_usd_at_event,
           amount_source, amount_status, tx_hash, block_number, timestamp, methodology_version, contract_address,
           config_key, event_signature, event_topic0, explorer_tx_url, explorer_address_url
    FROM blacklist_events
    WHERE stablecoin = '${options.stablecoin}'
      AND chain_id = '${options.chainId}'
    ORDER BY timestamp DESC
  `;
  const raw = executeWrangler({ remote: options.remote, sql });
  const rows = (JSON.parse(raw)[0]?.results ?? []) as BlacklistEventRow[];
  const events = rows.map((row) => ({
    id: row.id,
    stablecoin: row.stablecoin as "USDT" | "USDC" | "PAXG" | "XAUT" | "PYUSD" | "USD1",
    chainId: row.chain_id,
    chainName: row.chain_name,
    eventType: row.event_type,
    address: row.address,
    amountNative: row.amount_native,
    amountUsdAtEvent: row.amount_usd_at_event,
    amountSource: row.amount_source as "event" | "historical_balance" | "derived" | "unavailable",
    amountStatus: row.amount_status as "resolved" | "recoverable_pending" | "permanently_unavailable" | "provider_failed" | "ambiguous",
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
      ...await fetchTronCurrentBalanceRowsInBatches(
        active.map((record) => ({
          stablecoin: record.stablecoin,
          chainId: record.chainId,
          address: record.address,
        })),
        config.contractAddress,
        config.decimals,
        trongridApiKey,
        limiter,
      ),
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
            limiter,
            budget,
            AbortSignal.timeout(15_000),
            chainRpcs,
          );
          rowsToWrite.push(
            buildCurrentBalanceWriteRow(
              next.stablecoin,
              next.chainId,
              next.address,
              observedAt,
              amount,
            ),
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

  const tmpDir = mkdtempSync(join(tmpdir(), "blacklist-current-balances-"));
  try {
    const sqlFile = join(tmpDir, "rebuild.sql");
    const statements = [
      `DELETE FROM blacklist_current_balances WHERE stablecoin = '${options.stablecoin}' AND chain_id = '${options.chainId}';`,
      ...rowsToWrite.map((row) =>
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
    ];
    writeFileSync(sqlFile, statements.join("\n"));
    executeWrangler({ remote: options.remote, file: sqlFile });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
