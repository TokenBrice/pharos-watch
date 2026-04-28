const DEFAULT_PROVIDER_URL = "https://api.kyc.rip/v1/tools/ban-list";
const DEFAULT_LIMIT = 1000;
const DEFAULT_MAX_MALFORMED_ROWS = 10;
const DEFAULT_RETRIES = 2;

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

class RetryableHttpError extends Error {
  constructor(readonly status: number) {
    super(`kyc.rip returned retryable HTTP ${status}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
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
    return await response.json() as unknown;
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
  return (asset === "USDT" && chain === "ETH") || (asset === "USDC" && chain === "ETH") || (asset === "USDT" && chain === "TRON");
}

function validateRow(
  raw: unknown,
  mode: KycRipValidationMode,
): { type: "accepted"; row: KycRipCurrentBalanceRow | KycRipEventRow } | { type: "skipped" } | { type: "malformed"; reason: string } {
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
      throw new Error(`kyc.rip payload had ${stats.malformedRows} malformed rows; maximum allowed is ${maxMalformedRows}`);
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
