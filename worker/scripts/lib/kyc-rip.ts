import { isRecord } from "@shared/lib/type-guards";
import { parseDestructiveOperationMode } from "./destructive-operation-guard";

const DEFAULT_PROVIDER_URL = "https://api.kyc.rip/v1/tools/ban-list";
const DEFAULT_LIMIT = 1000;
const DEFAULT_MAX_MALFORMED_ROWS = 10;
const DEFAULT_RETRIES = 2;
export const KYC_RIP_DEFAULT_TIMEOUT_MS = 15_000;
export const KYC_RIP_DEFAULT_MIN_ROWS = 100;
export const KYC_RIP_DEFAULT_DATABASE = "stablecoin-db";

export type KycRipAsset = "USDT" | "USDC";
export type KycRipChain = "ETH" | "TRON";

export type KycRipCurrentBalanceRow = {
  address: string;
  asset: KycRipAsset;
  chain: KycRipChain;
  frozen_balance: string;
};

export type KycRipEventRow = {
  address: string;
  asset: KycRipAsset;
  chain: KycRipChain;
  tx_hash: string;
};

export type KycRipValidationMode = "current-balances" | "events";

export type KycRipValidationStats = {
  fetchedRows: number;
  acceptedRows: number;
  skippedUnsupportedRows: number;
  malformedRows: number;
  malformedExamples: string[];
};

export type FetchKycRipRowsOptions = {
  mode: KycRipValidationMode;
  timeoutMs: number;
  minRows: number;
  providerUrl?: string;
  retries?: number;
  maxMalformedRows?: number;
  fetchImpl?: typeof fetch;
};

export type FetchKycRipRowsResult<T> = {
  rows: T[];
  stats: KycRipValidationStats;
  providerUrl: string;
};

export type KycRipCliOptions = {
  apply: boolean;
  remote: true;
  database: string;
  timeoutMs: number;
  minRows: number;
  providerUrl?: string;
};

type KycRipCliHelpOptions = {
  scriptName: string;
  applyDescription: string;
  minRowsDescription: string;
};

class RetryableHttpError extends Error {
  constructor(readonly status: number) {
    super(`kyc.rip returned retryable HTTP ${status}`);
  }
}

export function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function printKycRipCliHelp(help: KycRipCliHelpOptions): void {
  console.log(`Usage: tsx ${help.scriptName} [options]

Default mode is dry-run. Remote D1 writes require --execute --confirm ${help.scriptName}.

Options:
  --execute              ${help.applyDescription}
  --apply                Compatibility alias for --execute; still requires --confirm
  --confirm <script>     Required for live mutation; value must be ${help.scriptName}
  --dry-run              Force dry-run mode
  --remote               Target remote D1 (default and only supported D1 target)
  --timeout-ms <ms>      kyc.rip request timeout (default: ${KYC_RIP_DEFAULT_TIMEOUT_MS})
  --min-rows <count>     ${help.minRowsDescription} (default: ${KYC_RIP_DEFAULT_MIN_ROWS})
  --database <name>      D1 database name (default: ${KYC_RIP_DEFAULT_DATABASE})
  --provider-url <url>   Override kyc.rip ban-list URL
  --help                 Show this help`);
}

export function parseKycRipCliArgs(argv: string[], help: KycRipCliHelpOptions): KycRipCliOptions {
  if (argv.includes("--help")) {
    printKycRipCliHelp(help);
    process.exit(0);
  }

  const mode = parseDestructiveOperationMode({
    argv,
    defaultTarget: "--remote",
    executeAliases: ["--apply"],
    localAllowed: false,
    scriptName: help.scriptName,
  });
  const options: KycRipCliOptions = {
    apply: !mode.dryRun,
    remote: true,
    database: KYC_RIP_DEFAULT_DATABASE,
    timeoutMs: KYC_RIP_DEFAULT_TIMEOUT_MS,
    minRows: KYC_RIP_DEFAULT_MIN_ROWS,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (
      arg === "--apply" ||
      arg === "--execute" ||
      arg === "--dry-run" ||
      arg === "--remote" ||
      arg === "--local" ||
      arg.startsWith("--confirm=")
    ) {
      continue;
    }
    if (arg === "--confirm") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      index++;
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

function isSupportedAsset(value: unknown): value is KycRipAsset {
  return value === "USDT" || value === "USDC";
}

function isSupportedChain(value: unknown): value is KycRipChain {
  return value === "ETH" || value === "TRON";
}

function buildUrl(baseUrl: string, limit: number, offset: number): string {
  const url = new URL(baseUrl);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  return url.toString();
}

function extractRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload) && Array.isArray(payload.data)) return payload.data;
  throw new Error("kyc.rip payload must be an array or an object with a data array");
}

function isRetryableFetchError(error: unknown): boolean {
  if (error instanceof RetryableHttpError) return true;
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.name === "TypeError";
}

async function fetchJsonWithTimeout(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (response.status >= 500 && response.status <= 599) {
      throw new RetryableHttpError(response.status);
    }
    if (!response.ok) {
      throw new Error(`kyc.rip returned HTTP ${response.status}`);
    }
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
  retries: number,
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchJsonWithTimeout(fetchImpl, url, timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isRetryableFetchError(error)) {
        throw error;
      }
    }
  }
  throw lastError;
}

function isSupportedPair(mode: KycRipValidationMode, asset: KycRipAsset, chain: KycRipChain): boolean {
  if (mode === "events") return chain === "ETH" && (asset === "USDT" || asset === "USDC");
  return (
    (asset === "USDT" && chain === "ETH") ||
    (asset === "USDC" && chain === "ETH") ||
    (asset === "USDT" && chain === "TRON")
  );
}

function validateRow(
  raw: unknown,
  mode: KycRipValidationMode,
):
  | { type: "accepted"; row: KycRipCurrentBalanceRow | KycRipEventRow }
  | { type: "skipped" }
  | { type: "malformed"; reason: string } {
  if (!isRecord(raw)) {
    return { type: "malformed", reason: "row is not an object" };
  }

  const { address, asset, chain } = raw;
  if (typeof address !== "string" || address.length === 0) {
    return { type: "malformed", reason: "missing address" };
  }
  if (typeof asset !== "string" || typeof chain !== "string") {
    return { type: "malformed", reason: "missing asset or chain" };
  }
  if (!isSupportedAsset(asset) || !isSupportedChain(chain)) {
    return { type: "skipped" };
  }
  if (!isSupportedPair(mode, asset, chain)) {
    return { type: "skipped" };
  }

  if (mode === "current-balances") {
    const amount = raw.frozen_balance;
    const amountString = typeof amount === "number" ? String(amount) : amount;
    if (typeof amountString !== "string" || amountString.length === 0 || !Number.isFinite(Number(amountString))) {
      return { type: "malformed", reason: "missing or invalid frozen_balance" };
    }
    return {
      type: "accepted",
      row: { address, asset, chain, frozen_balance: amountString },
    };
  }

  const txHash = raw.tx_hash;
  if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { type: "malformed", reason: "missing or invalid tx_hash" };
  }
  return {
    type: "accepted",
    row: { address, asset, chain, tx_hash: txHash },
  };
}

export async function fetchKycRipRows<T extends KycRipCurrentBalanceRow | KycRipEventRow>(
  options: FetchKycRipRowsOptions,
): Promise<FetchKycRipRowsResult<T>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const providerUrl = options.providerUrl ?? DEFAULT_PROVIDER_URL;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const maxMalformedRows = options.maxMalformedRows ?? DEFAULT_MAX_MALFORMED_ROWS;
  const rows: T[] = [];
  const stats: KycRipValidationStats = {
    fetchedRows: 0,
    acceptedRows: 0,
    skippedUnsupportedRows: 0,
    malformedRows: 0,
    malformedExamples: [],
  };
  let offset = 0;

  while (true) {
    const pageUrl = buildUrl(providerUrl, DEFAULT_LIMIT, offset);
    const payload = await fetchJsonWithRetry(fetchImpl, pageUrl, options.timeoutMs, retries);
    const batch = extractRows(payload);
    stats.fetchedRows += batch.length;

    for (const rawRow of batch) {
      const result = validateRow(rawRow, options.mode);
      if (result.type === "accepted") {
        rows.push(result.row as T);
      } else if (result.type === "skipped") {
        stats.skippedUnsupportedRows++;
      } else {
        stats.malformedRows++;
        if (stats.malformedExamples.length < 3) stats.malformedExamples.push(result.reason);
      }
    }

    if (stats.malformedRows > maxMalformedRows) {
      throw new Error(
        `kyc.rip payload had ${stats.malformedRows} malformed rows; maximum allowed is ${maxMalformedRows}`,
      );
    }

    if (batch.length < DEFAULT_LIMIT) break;
    offset += DEFAULT_LIMIT;
  }

  stats.acceptedRows = rows.length;
  if (rows.length < options.minRows) {
    throw new Error(`kyc.rip accepted ${rows.length} rows, below minimum ${options.minRows}`);
  }

  return { rows, stats, providerUrl };
}
