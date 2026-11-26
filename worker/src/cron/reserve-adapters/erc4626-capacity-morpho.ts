import { canonicalEvmAddress } from "@shared/lib/evm-address";
import { toErrorMessage } from "@shared/lib/error-utils";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { isRecord } from "@shared/lib/type-guards";
import { FetchRequestNotStartedError } from "../../lib/abort";
import { finiteDecimalNumberFromBigInt } from "../../lib/bigint";
import { fetchEvmBlockTimestamp } from "../../lib/evm-rpc";
import { fetchWithRetry } from "../../lib/fetch-retry";
import {
  MORPHO_RATE_LIMIT_CACHE_KEY,
  parseMorphoRateLimitBackoff,
  persistMorphoRateLimitBackoff,
  resolveMorphoRateLimitBackoff,
  type MorphoRateLimitBackoff,
} from "../../lib/morpho-rate-limit";
import { cancelResponseBodyQuietly, readResponseJsonWithinLimitWithSignal } from "../../lib/response-body";
import { redactProviderUrls } from "../../lib/safe-error-message";
import { decodeStrictAddressWord } from "./abi-decode";
import { runAdapterIo } from "./concurrency";
import { ADAPTER_USER_AGENT, createRequestBodyObserver, getCachedRequest } from "./request";
import { parseBoundedDecimals } from "./slice-math";
import { parseDecimalNumber } from "./strict-amount";
import type { AdapterContext } from "./types";
import { reserveInfoWarning } from "./warnings";
import {
  probeFailure, routeForSource,
  type CapacityProbeResult, type Erc4626RedemptionLiquidityConfig, type ObserveConfiguredErc4626CapacityInput,
} from "./erc4626-capacity-observation";

type MorphoVaultV1RedemptionLiquidityConfig = Extract<Erc4626RedemptionLiquidityConfig, { source: "morpho-vault-v1" }>;
type MorphoVaultV2RedemptionLiquidityConfig = Extract<Erc4626RedemptionLiquidityConfig, { source: "morpho-vault-v2" }>;

type MorphoProbeInput = Pick<
  ObserveConfiguredErc4626CapacityInput,
  | "coinId"
  | "contractAddress"
  | "assetAddress"
  | "underlyingDecimalsRaw"
  | "chain"
  | "rpcUrl"
  | "fallbackRpcUrl"
  | "timeoutMs"
  | "signal"
  | "ctx"
>;
type MorphoReadVersion = "v1" | "v2";

interface MorphoVaultDirectory {
  assets: Map<string, string>;
  poisoned: Set<string>;
  unparseableRowCount: number;
}

const DEFAULT_MORPHO_API_BASE_URL = "https://api.morpho.org";
const MORPHO_REQUEST_TIMEOUT_MS = 8_000;
const MORPHO_DIAGNOSTIC_TIMEOUT_MS = 3_000;
const MORPHO_DIAGNOSTIC_RESERVE_MS = 1_500;
const MORPHO_DIRECTORY_MAX_RESPONSE_BYTES = 1024 * 1024;
const MORPHO_DETAIL_MAX_RESPONSE_BYTES = 16 * 1024;
const MORPHO_DIRECTORY_PAGE_LIMIT = 1000;
const MORPHO_DIRECTORY_MAX_PAGES = 10;
const MORPHO_STATE_MAX_AGE_SEC = 1_800;
const MORPHO_STATE_MAX_FUTURE_SKEW_SEC = 300;
const MORPHO_PRICE_MAX_AGE_SEC = 86_400;

// Morpho applies a 7-day IP ban at 3,334 req/10 min; trip a run-scoped flag
// and share the Retry-After-aware D1 backoff row with the yield Morpho lane
// so remaining Morpho coins and scheduled continuations short-circuit immediately.
const morphoRateLimitedRuns = new WeakMap<object, boolean>();
const morphoRateLimitLoadPromises = new WeakMap<object, Promise<boolean>>();
const morphoDirectoryFailureRuns = new WeakMap<object, Map<string, string>>();

function rateLimitScope(ctx?: AdapterContext): object | null {
  return ctx?.requestCache ?? ctx ?? null;
}

function isMorphoRateLimitedSync(ctx?: AdapterContext): boolean {
  const scope = rateLimitScope(ctx);
  return scope != null && morphoRateLimitedRuns.get(scope) === true;
}

async function checkMorphoRateLimited(ctx?: AdapterContext): Promise<boolean> {
  const scope = rateLimitScope(ctx);
  if (scope == null) return false;
  const cached = morphoRateLimitedRuns.get(scope);
  if (cached !== undefined) return cached;
  const db = ctx?.db;
  if (!db) return false;
  let pending = morphoRateLimitLoadPromises.get(scope);
  if (!pending) {
    pending = (async () => {
      try {
        const row = await db
          .prepare("SELECT value FROM cache WHERE key = ?")
          .bind(MORPHO_RATE_LIMIT_CACHE_KEY)
          .first<{ value: string }>();
        const nowSec = ctx?.nowSec ?? Math.floor(Date.now() / 1000);
        const active = parseMorphoRateLimitBackoff(row?.value, nowSec) != null;
        // Never downgrade a flag that was tripped while the D1 read was in flight.
        if (morphoRateLimitedRuns.get(scope) === true) return true;
        morphoRateLimitedRuns.set(scope, active);
        return active;
      } catch {
        return morphoRateLimitedRuns.get(scope) === true;
      }
    })();
    morphoRateLimitLoadPromises.set(scope, pending);
  }
  return pending;
}

async function markMorphoRateLimited(
  ctx: AdapterContext | undefined,
  backoff: MorphoRateLimitBackoff,
  recordedAtSec: number,
  options?: { nonBlocking?: boolean },
): Promise<void> {
  const scope = rateLimitScope(ctx);
  if (scope != null) morphoRateLimitedRuns.set(scope, true);
  const db = ctx?.db;
  if (!db) return;
  const writePromise = persistMorphoRateLimitBackoff(db, backoff, recordedAtSec, "reserve-adapter").catch(() => {
    // Best-effort continuation persistence; in-memory scope flag is already tripped.
  });
  if (options?.nonBlocking) {
    if (ctx?.waitUntil) {
      ctx.waitUntil(writePromise);
    }
    return;
  }
  await writePromise;
}

function getCachedDirectoryFailure(cacheKey: string, ctx?: AdapterContext): string | null {
  const scope = rateLimitScope(ctx);
  if (scope == null) return null;
  return morphoDirectoryFailureRuns.get(scope)?.get(cacheKey) ?? null;
}

function recordDirectoryFailure(cacheKey: string, detail: string, ctx?: AdapterContext): void {
  const scope = rateLimitScope(ctx);
  if (scope == null) return;
  let failures = morphoDirectoryFailureRuns.get(scope);
  if (!failures) {
    failures = new Map();
    morphoDirectoryFailureRuns.set(scope, failures);
  }
  failures.set(cacheKey, detail);
}

function parseMorphoChainId(value: unknown): number | null {
  const parsed = parseDecimalNumber(value);
  return parsed != null && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseUnsignedBigInt(value: unknown): bigint | null {
  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null;
}

function parsePositiveSafeInt(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function parseUnixTimestampSec(value: unknown): number | null {
  return parsePositiveSafeInt(value);
}

function computeDiagnosticLiquidityUsd(
  rawAmount: bigint,
  underlyingDecimals: number | null,
  tokenPriceUsd: number | null,
): number | undefined {
  if (underlyingDecimals == null || tokenPriceUsd == null) return undefined;
  const tokens = finiteDecimalNumberFromBigInt(rawAmount, underlyingDecimals);
  if (tokens == null || tokens < 0) return undefined;
  const usd = tokens * tokenPriceUsd;
  return Number.isFinite(usd) && usd >= 0 ? usd : undefined;
}

function computeDiagnosticDeadlineMs(ctx?: AdapterContext): number | null {
  const now = Date.now();
  const attemptDeadlineMs = ctx?.attemptDeadlineMs;
  if (attemptDeadlineMs == null) return now + MORPHO_DIAGNOSTIC_TIMEOUT_MS;
  const budgetDeadlineMs = attemptDeadlineMs - MORPHO_DIAGNOSTIC_RESERVE_MS;
  if (budgetDeadlineMs <= now) return null;
  return Math.min(budgetDeadlineMs, now + MORPHO_DIAGNOSTIC_TIMEOUT_MS);
}

function morphoFailure(
  input: { warningCodePrefix: string; versionLabel: string; coinId: string },
  code: string,
  detail: string,
): CapacityProbeResult {
  return probeFailure(
    `${input.warningCodePrefix}-${code}`,
    `${input.versionLabel} ${detail} for ${input.coinId}`,
  );
}

type MorphoFetchOutcome =
  | { kind: "ok"; status: number; body: Record<string, unknown> }
  | { kind: "rate-limited" }
  | { kind: "not-found" }
  | { kind: "unavailable"; detail: string; cacheable: boolean };

class MorphoReadFailure extends Error {
  constructor(
    readonly kind: "rate-limited" | "unavailable",
    message: string,
    readonly cacheable = true,
  ) {
    super(message);
  }
}

async function fetchMorphoReadJson(
  url: string,
  maxResponseBytes: number,
  signal: AbortSignal,
  ctx?: AdapterContext,
  options?: { passthrough404?: boolean; timeoutMs?: number; deadlineMs?: number; isDiagnostic?: boolean },
): Promise<MorphoFetchOutcome> {
  if (await checkMorphoRateLimited(ctx)) return { kind: "rate-limited" };
  const requestSignal = ctx?.abortSignal && ctx.abortSignal !== signal
    ? AbortSignal.any([signal, ctx.abortSignal])
    : signal;
  const redactedUrl = redactProviderUrls(url);
  const maxTimeoutMs = options?.timeoutMs ?? MORPHO_REQUEST_TIMEOUT_MS;

  return runAdapterIo(ctx, `morpho-read:${redactedUrl}`, async () => {
    if (isMorphoRateLimitedSync(ctx)) return { kind: "rate-limited" };
    const effectiveDeadlineMs = options?.deadlineMs != null && ctx?.attemptDeadlineMs != null
      ? Math.min(options.deadlineMs, ctx.attemptDeadlineMs)
      : options?.deadlineMs ?? ctx?.attemptDeadlineMs;
    const remainingMs = effectiveDeadlineMs == null ? maxTimeoutMs : effectiveDeadlineMs - Date.now();
    if (remainingMs <= 0) {
      return { kind: "unavailable", detail: "attempt deadline exceeded", cacheable: false };
    }
    const attemptTimeoutMs = Math.min(maxTimeoutMs, remainingMs);
    const observation = createRequestBodyObserver(ctx, maxResponseBytes);

    try {
      const response = await fetchWithRetry(
        url,
        {
          headers: { Accept: "application/json", "User-Agent": ADAPTER_USER_AGENT },
          signal: requestSignal,
        },
        1,
        {
          timeoutMs: attemptTimeoutMs,
          ...(effectiveDeadlineMs != null ? { deadlineMs: effectiveDeadlineMs } : {}),
          ...(options?.passthrough404 ? { passthrough404: true } : {}),
          passthroughStatuses: [429],
          waitOnPassthrough429: false,
          throwOnFinalNetworkError: true,
          beforeRequest: () => !isMorphoRateLimitedSync(ctx),
        },
      );
      if (isMorphoRateLimitedSync(ctx)) {
        await cancelResponseBodyQuietly(response);
        return { kind: "rate-limited" };
      }
      if (!response) {
        // Local budget exhaustion / timeouts must not poison shared run-wide caches.
        const timedOutByBudget = effectiveDeadlineMs != null && Date.now() >= effectiveDeadlineMs;
        return { kind: "unavailable", detail: "HTTP request failed", cacheable: !timedOutByBudget };
      }
      if (response.status === 429) {
        const receivedAtMs = Date.now();
        const receivedAtSec = Math.floor(receivedAtMs / 1000);
        const backoff = resolveMorphoRateLimitBackoff(response, receivedAtMs);
        const scope = rateLimitScope(ctx);
        if (scope != null) morphoRateLimitedRuns.set(scope, true);
        await cancelResponseBodyQuietly(response);
        await markMorphoRateLimited(ctx, backoff, receivedAtSec, { nonBlocking: options?.isDiagnostic === true });
        return { kind: "rate-limited" };
      }
      if (response.status === 404) {
        await cancelResponseBodyQuietly(response);
        return { kind: "not-found" };
      }
      if (!response.ok) {
        await cancelResponseBodyQuietly(response);
        return { kind: "unavailable", detail: `HTTP ${response.status}`, cacheable: true };
      }
      const bodyRemainingMs = effectiveDeadlineMs == null ? maxTimeoutMs : effectiveDeadlineMs - Date.now();
      if (bodyRemainingMs <= 0) {
        await cancelResponseBodyQuietly(response);
        return { kind: "unavailable", detail: "attempt deadline exceeded", cacheable: false };
      }
      const bodyTimeout = createTimeoutSignal({
        timeoutMs: Math.min(maxTimeoutMs, bodyRemainingMs),
        timeoutReason: new DOMException("Morpho Read API response body timed out", "TimeoutError"),
        parentSignal: requestSignal,
      });
      try {
        const body = await readResponseJsonWithinLimitWithSignal<unknown>(
          response,
          maxResponseBytes,
          bodyTimeout.signal,
          observation.onBodyRead,
        );
        if (!isRecord(body)) {
          return { kind: "unavailable", detail: "malformed JSON object", cacheable: true };
        }
        return { kind: "ok", status: response.status, body };
      } catch (error) {
        await cancelResponseBodyQuietly(response);
        throw error;
      } finally {
        bodyTimeout.dispose();
      }
    } catch (error) {
      if (isMorphoRateLimitedSync(ctx)) return { kind: "rate-limited" };
      if (requestSignal.aborted) throw error;
      if (error instanceof FetchRequestNotStartedError) {
        return { kind: "unavailable", detail: error.message, cacheable: false };
      }
      const isLocalTimeout = error instanceof DOMException && error.name === "TimeoutError";
      return {
        kind: "unavailable",
        detail: redactProviderUrls(toErrorMessage(error)),
        cacheable: !isLocalTimeout,
      };
    }
  }, { signal: requestSignal });
}

async function fetchMorphoVaultDirectory(
  apiBaseUrl: string,
  version: MorphoReadVersion,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<MorphoVaultDirectory> {
  const pathPrefix = version === "v1" ? "/v0/vaults-v1" : "/v0/vaults-v2";
  const cacheKey = `morpho-read-directory:${version}:${apiBaseUrl}`;
  const priorFailure = getCachedDirectoryFailure(cacheKey, ctx);
  if (priorFailure != null) {
    throw new MorphoReadFailure("unavailable", priorFailure, true);
  }
  try {
    return await getCachedRequest(
      cacheKey,
      async () => {
        const assets = new Map<string, string>();
        const poisoned = new Set<string>();
        const seenCursors = new Set<string>();
        let cursor: string | null = null;
        let pageCount = 0;
        let unparseableRowCount = 0;

        for (;;) {
          if (pageCount >= MORPHO_DIRECTORY_MAX_PAGES) {
            throw new MorphoReadFailure("unavailable", "directory pagination exceeded page limit", true);
          }
          const url = cursor
            ? `${apiBaseUrl}${pathPrefix}?limit=${MORPHO_DIRECTORY_PAGE_LIMIT}&cursor=${encodeURIComponent(cursor)}`
            : `${apiBaseUrl}${pathPrefix}?limit=${MORPHO_DIRECTORY_PAGE_LIMIT}`;
          const outcome = await fetchMorphoReadJson(url, MORPHO_DIRECTORY_MAX_RESPONSE_BYTES, signal, ctx);
          if (outcome.kind === "rate-limited") {
            throw new MorphoReadFailure("rate-limited", "Read API rate limited", false);
          }
          if (outcome.kind !== "ok") {
            const detail = outcome.kind === "unavailable" ? outcome.detail : "directory endpoint returned 404";
            throw new MorphoReadFailure("unavailable", detail, outcome.kind === "unavailable" ? outcome.cacheable : true);
          }
          // Require HTTP 200 on every directory page; HTTP 206 partial pages cannot establish completeness.
          if (outcome.status !== 200) {
            throw new MorphoReadFailure("unavailable", `directory page returned HTTP ${outcome.status}`, true);
          }
          if (!Array.isArray(outcome.body.data)) {
            throw new MorphoReadFailure("unavailable", "directory response missing data array", true);
          }
          pageCount += 1;

          for (const item of outcome.body.data) {
            if (!isRecord(item)) {
              unparseableRowCount += 1;
              continue;
            }
            const chainId = parseMorphoChainId(item.chain_id);
            const vaultAddress = canonicalEvmAddress(item.vault_address);
            if (chainId == null || !vaultAddress) {
              unparseableRowCount += 1;
              continue;
            }
            const key = `${chainId}:${vaultAddress}`;
            const assetAddress = canonicalEvmAddress(item.asset_address);
            if (!assetAddress) {
              poisoned.add(key);
              assets.delete(key);
              continue;
            }
            if (poisoned.has(key)) continue;
            const existing = assets.get(key);
            if (existing != null && existing !== assetAddress) {
              poisoned.add(key);
              assets.delete(key);
              continue;
            }
            assets.set(key, assetAddress);
          }

          if (!Object.prototype.hasOwnProperty.call(outcome.body, "cursor")) {
            throw new MorphoReadFailure("unavailable", "directory response missing cursor field", true);
          }
          const nextCursor = outcome.body.cursor;
          if (nextCursor === null) break;
          if (typeof nextCursor !== "string" || nextCursor.length === 0 || seenCursors.has(nextCursor)) {
            throw new MorphoReadFailure("unavailable", "directory pagination cursor cycle or invalid cursor", true);
          }
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        }

        return {
          value: { assets, poisoned, unparseableRowCount },
          cacheBytes: Math.max(64, (assets.size + poisoned.size) * 256),
          basis: "declared-estimate" as const,
        };
      },
      ctx,
    );
  } catch (error) {
    if (error instanceof MorphoReadFailure && error.kind === "unavailable" && error.cacheable) {
      recordDirectoryFailure(cacheKey, error.message, ctx);
    }
    throw error;
  }
}

async function fetchIndexedBlockTimestamp(
  input: Pick<MorphoProbeInput, "chain" | "rpcUrl" | "fallbackRpcUrl" | "timeoutMs" | "signal" | "ctx">,
  blockNumber: number,
): Promise<number | null> {
  const extraRpcUrls = [input.rpcUrl, input.fallbackRpcUrl].filter((url): url is string => Boolean(url));
  const cacheKey = `morpho-indexed-block-ts:${input.chain}:${blockNumber}`;
  try {
    return await getCachedRequest<number>(
      cacheKey,
      async () => {
        const timestamp = await runAdapterIo(
          input.ctx,
          `morpho-block-ts:${input.chain}:${blockNumber}`,
          () =>
            fetchEvmBlockTimestamp(input.chain, blockNumber, {
              ...(extraRpcUrls.length > 0 ? { extraRpcUrls } : {}),
              chainRpcs: input.ctx?.chainRpcs,
              signal: input.ctx?.abortSignal && input.ctx.abortSignal !== input.signal
                ? AbortSignal.any([input.signal, input.ctx.abortSignal])
                : input.signal,
              timeoutMs: Math.min(input.timeoutMs, MORPHO_REQUEST_TIMEOUT_MS),
              ...(input.ctx?.attemptDeadlineMs != null ? { deadlineMs: input.ctx.attemptDeadlineMs } : {}),
            }),
          { signal: input.signal },
        );
        // Never retain a transient RPC failure in requestCache so retries and sibling vaults can recover.
        if (timestamp == null) {
          throw new MorphoReadFailure("unavailable", "block header timestamp unavailable", false);
        }
        return { value: timestamp, cacheBytes: 64, basis: "declared-estimate" as const };
      },
      input.ctx,
    );
  } catch (error) {
    if (input.signal.aborted || input.ctx?.abortSignal?.aborted) throw error;
    return null;
  }
}

async function fetchMorphoV2ForceDeallocatableLiquidity(
  apiBaseUrl: string,
  chainId: number,
  vaultLower: string,
  signal: AbortSignal,
  deadlineMs: number,
  ctx?: AdapterContext,
): Promise<bigint | undefined> {
  if (isMorphoRateLimitedSync(ctx) || deadlineMs <= Date.now()) return undefined;
  const outcome = await fetchMorphoReadJson(
    `${apiBaseUrl}/v0/vaults-v2/${chainId}:${vaultLower}/withdrawal-options`,
    MORPHO_DETAIL_MAX_RESPONSE_BYTES,
    signal,
    ctx,
    { passthrough404: true, timeoutMs: MORPHO_DIAGNOSTIC_TIMEOUT_MS, deadlineMs, isDiagnostic: true },
  );
  if (outcome.kind !== "ok" || outcome.status !== 200) return undefined;
  const data = outcome.body.data;
  if (!isRecord(data)) return undefined;
  if (
    parseMorphoChainId(data.chain_id) !== chainId
    || canonicalEvmAddress(data.vault_address) !== vaultLower
  ) {
    return undefined;
  }
  if (!Array.isArray(data.adapter_penalties)) return undefined;
  let total = 0n;
  for (const entry of data.adapter_penalties) {
    if (!isRecord(entry)) return undefined;
    const assets = parseUnsignedBigInt(entry.force_deallocatable_assets);
    if (assets == null) return undefined;
    total += assets;
  }
  return total;
}

async function fetchMorphoTokenPriceUsd(
  apiBaseUrl: string,
  chainId: number,
  assetLower: string,
  signal: AbortSignal,
  deadlineMs: number,
  ctx?: AdapterContext,
): Promise<number | null> {
  if (isMorphoRateLimitedSync(ctx) || deadlineMs <= Date.now()) return null;
  const assetSelector = `${chainId}:${assetLower}`;
  try {
    return await getCachedRequest<number | null>(
      `morpho-read-token-price:${apiBaseUrl}:${assetSelector}`,
      async () => {
        const outcome = await fetchMorphoReadJson(
          `${apiBaseUrl}/v0/tokens/${assetSelector}/price`,
          MORPHO_DETAIL_MAX_RESPONSE_BYTES,
          signal,
          ctx,
          { passthrough404: true, timeoutMs: MORPHO_DIAGNOSTIC_TIMEOUT_MS, deadlineMs, isDiagnostic: true },
        );
        if (outcome.kind === "rate-limited") {
          throw new MorphoReadFailure("rate-limited", "Read API rate limited", false);
        }
        if (outcome.kind === "not-found") {
          return { value: null, cacheBytes: 64, basis: "declared-estimate" as const };
        }
        if (outcome.kind !== "ok") {
          throw new MorphoReadFailure("unavailable", outcome.detail, outcome.cacheable);
        }
        // HTTP 206 Partial Content (or any non-200) explicitly suppresses diagnostic USD pricing.
        if (outcome.status !== 200) {
          return { value: null, cacheBytes: 64, basis: "declared-estimate" as const };
        }
        const data = outcome.body.data;
        if (!isRecord(data)) {
          return { value: null, cacheBytes: 64, basis: "declared-estimate" as const };
        }
        if (
          parseMorphoChainId(data.chain_id) !== chainId
          || canonicalEvmAddress(data.address) !== assetLower
        ) {
          return { value: null, cacheBytes: 64, basis: "declared-estimate" as const };
        }
        // Require a positive Unix timestamp (decimal string or safe integer) within freshness bounds.
        const ts = parseUnixTimestampSec(data.timestamp);
        const nowSec = ctx?.nowSec ?? Math.floor(Date.now() / 1000);
        if (ts == null || ts > nowSec + MORPHO_STATE_MAX_FUTURE_SKEW_SEC || nowSec - ts > MORPHO_PRICE_MAX_AGE_SEC) {
          return { value: null, cacheBytes: 64, basis: "declared-estimate" as const };
        }
        const price = typeof data.price === "number" && Number.isFinite(data.price) && data.price > 0
          ? data.price
          : null;
        return { value: price, cacheBytes: 64, basis: "declared-estimate" as const };
      },
      ctx,
    );
  } catch (error) {
    if (signal.aborted || ctx?.abortSignal?.aborted) throw error;
    return null;
  }
}

type MorphoLiquidityInput = MorphoProbeInput & {
  config: { chainId: number; apiUrl?: string };
  version: MorphoReadVersion;
  versionLabel: "Morpho V1" | "Morpho V2";
  warningCodePrefix: "morpho-vault-v1" | "morpho-vault-v2";
};

async function fetchMorphoVaultLiquidity(input: MorphoLiquidityInput): Promise<CapacityProbeResult> {
  if (await checkMorphoRateLimited(input.ctx)) {
    return morphoFailure(input, "rate-limited", "Read API rate limited");
  }
  const apiBaseUrl = (input.config.apiUrl ?? DEFAULT_MORPHO_API_BASE_URL).replace(/\/+$/, "");
  const vaultLower = input.contractAddress.toLowerCase();
  const assetLower = input.assetAddress.toLowerCase();
  const vaultSelector = `${input.config.chainId}:${vaultLower}`;
  const isVaultV1 = input.version === "v1";

  try {
    let directory: MorphoVaultDirectory;
    try {
      directory = await fetchMorphoVaultDirectory(apiBaseUrl, input.version, input.signal, input.ctx);
    } catch (error) {
      if (error instanceof MorphoReadFailure) {
        return error.kind === "rate-limited"
          ? morphoFailure(input, "rate-limited", "Read API rate limited")
          : morphoFailure(input, "liquidity-unavailable", `directory fetch failed: ${error.message}`);
      }
      throw error;
    }

    if (directory.poisoned.has(vaultSelector)) {
      return morphoFailure(input, "liquidity-invalid", "directory contains malformed or conflicting vault identity");
    }
    const listedAsset = directory.assets.get(vaultSelector);
    if (listedAsset == null) {
      if (directory.unparseableRowCount > 0) {
        return morphoFailure(input, "liquidity-invalid", "directory contained unparseable rows; cannot certify vault absence");
      }
      return morphoFailure(
        input,
        "unlisted",
        isVaultV1
          ? "liquidity vault is absent from Morpho Read API V1 directory"
          : "liquidity vault is not listed",
      );
    }
    if (listedAsset !== assetLower) {
      return morphoFailure(input, "asset-mismatch", "liquidity asset mismatch");
    }

    const statePath = isVaultV1
      ? `/v0/vaults-v1/${vaultSelector}/state`
      : `/v1/vaults-v2/${vaultSelector}/state`;
    const stateOutcome = await fetchMorphoReadJson(
      `${apiBaseUrl}${statePath}`,
      MORPHO_DETAIL_MAX_RESPONSE_BYTES,
      input.signal,
      input.ctx,
    );
    if (stateOutcome.kind === "rate-limited") {
      return morphoFailure(input, "rate-limited", "Read API rate limited");
    }
    if (stateOutcome.kind !== "ok" || stateOutcome.status !== 200 || !isRecord(stateOutcome.body.data)) {
      return morphoFailure(input, "liquidity-unavailable", "state query returned no vault state");
    }

    const state = stateOutcome.body.data;
    if (canonicalEvmAddress(state.address) !== vaultLower) {
      return morphoFailure(input, "identity-mismatch", "liquidity vault address mismatch");
    }
    if (parseMorphoChainId(state.chain_id) !== input.config.chainId) {
      return morphoFailure(input, "chain-mismatch", "liquidity chain mismatch");
    }
    const lastIndexedBlock = parsePositiveSafeInt(state.last_indexed_block);
    if (lastIndexedBlock == null) {
      return morphoFailure(input, "liquidity-invalid", "state payload has invalid last_indexed_block");
    }
    const nowSec = input.ctx?.nowSec ?? Math.floor(Date.now() / 1000);
    if (!isVaultV1 && state.last_accrual_timestamp != null) {
      // Morpho V2 last_accrual_timestamp reflects the vault's last interest accrual, which
      // can legitimately predate the current indexed block; reject only malformed or future values.
      const accrualTs = parseUnixTimestampSec(state.last_accrual_timestamp);
      if (accrualTs == null) {
        return morphoFailure(input, "liquidity-invalid", "state payload has invalid last_accrual_timestamp");
      }
      if (accrualTs > nowSec + MORPHO_STATE_MAX_FUTURE_SKEW_SEC) {
        return morphoFailure(input, "state-stale", "state payload last_accrual_timestamp is in the future");
      }
    }
    const liquidityRaw = parseUnsignedBigInt(state.withdrawable_assets);
    if (liquidityRaw == null) {
      return morphoFailure(input, "liquidity-invalid", "liquidity payload has invalid withdrawable_assets");
    }

    // Verify indexer freshness against the on-chain timestamp of last_indexed_block (cached by chain & block).
    const indexedBlockTimestamp = await fetchIndexedBlockTimestamp(input, lastIndexedBlock);
    if (indexedBlockTimestamp == null) {
      return morphoFailure(input, "liquidity-unavailable", "unable to verify last_indexed_block timestamp on-chain");
    }
    if (
      indexedBlockTimestamp > nowSec + MORPHO_STATE_MAX_FUTURE_SKEW_SEC
      || nowSec - indexedBlockTimestamp > MORPHO_STATE_MAX_AGE_SEC
    ) {
      return morphoFailure(input, "state-stale", "state payload last_indexed_block timestamp is stale or in the future");
    }

    // Bound optional diagnostics to one shared absolute sub-deadline leaving reserve headroom so
    // stalled diagnostics can never discard the already-validated capacityRaw above.
    const diagnosticDeadlineMs = computeDiagnosticDeadlineMs(input.ctx);
    const forceDeallocatableLiquidityRaw = !isVaultV1 && diagnosticDeadlineMs != null
      ? await fetchMorphoV2ForceDeallocatableLiquidity(
          apiBaseUrl,
          input.config.chainId,
          vaultLower,
          input.signal,
          diagnosticDeadlineMs,
          input.ctx,
        )
      : undefined;

    const underlyingDecimals = input.underlyingDecimalsRaw == null
      ? null
      : parseBoundedDecimals(input.underlyingDecimalsRaw);
    const tokenPriceUsd = underlyingDecimals != null && diagnosticDeadlineMs != null && diagnosticDeadlineMs > Date.now()
      ? await fetchMorphoTokenPriceUsd(
          apiBaseUrl,
          input.config.chainId,
          assetLower,
          input.signal,
          diagnosticDeadlineMs,
          input.ctx,
        )
      : null;
    const liquidityUsd = computeDiagnosticLiquidityUsd(liquidityRaw, underlyingDecimals, tokenPriceUsd);
    const forceDeallocatableLiquidityUsd = forceDeallocatableLiquidityRaw != null
      ? computeDiagnosticLiquidityUsd(forceDeallocatableLiquidityRaw, underlyingDecimals, tokenPriceUsd)
      : undefined;

    return {
      capacityRaw: liquidityRaw,
      warnings: [],
      route: routeForSource(
        isVaultV1 ? "morpho-vault-v1-liquidity" : "morpho-vault-v2-liquidity",
      ),
      diagnostics: {},
      telemetry: isVaultV1
        ? {
            morphoVaultV1LiquidityRaw: liquidityRaw.toString(),
            ...(liquidityUsd != null ? { morphoVaultV1LiquidityUsd: liquidityUsd } : {}),
          }
        : {
            morphoVaultV2LiquidityRaw: liquidityRaw.toString(),
            ...(liquidityUsd != null ? { morphoVaultV2LiquidityUsd: liquidityUsd } : {}),
            ...(forceDeallocatableLiquidityRaw != null
              ? { morphoVaultV2ForceDeallocatableLiquidityRaw: forceDeallocatableLiquidityRaw.toString() }
              : {}),
            ...(forceDeallocatableLiquidityUsd != null
              ? { morphoVaultV2ForceDeallocatableLiquidityUsd: forceDeallocatableLiquidityUsd }
              : {}),
          },
    };
  } catch (error) {
    if (input.signal.aborted || input.ctx?.abortSignal?.aborted) throw error;
    return probeFailure(
      `${input.warningCodePrefix}-liquidity-unavailable`,
      `${input.versionLabel} liquidity fetch failed for ${input.coinId}: ${redactProviderUrls(toErrorMessage(error))}`,
    );
  }
}

export async function fetchMorphoVaultV2Liquidity(
  input: MorphoProbeInput & Pick<ObserveConfiguredErc4626CapacityInput, "call"> & {
    config: MorphoVaultV2RedemptionLiquidityConfig;
  },
): Promise<CapacityProbeResult> {
  // Ordinary exit() can deallocate only through the vault's selected adapter.
  // Read API liquidity alone is not callable withdrawal capacity when it is unset.
  const adapter = decodeStrictAddressWord(await input.call("0xad468d11").catch(() => null));
  if (adapter == null || adapter === "0x0000000000000000000000000000000000000000") {
    const reason = adapter == null ? "unavailable" : "zero";
    return {
      capacityRaw: null,
      warnings: [reserveInfoWarning(
        `morpho-vault-v2-liquidity-adapter-${reason}`,
        `Morpho V2 liquidityAdapter() ${reason}; only independently observed idle underlying is usable as capacity`,
      )],
    };
  }
  return fetchMorphoVaultLiquidity({
    ...input,
    version: "v2",
    versionLabel: "Morpho V2",
    warningCodePrefix: "morpho-vault-v2",
  });
}

export function fetchMorphoVaultV1Liquidity(
  input: MorphoProbeInput & { config: MorphoVaultV1RedemptionLiquidityConfig },
): Promise<CapacityProbeResult> {
  return fetchMorphoVaultLiquidity({
    ...input,
    version: "v1",
    versionLabel: "Morpho V1",
    warningCodePrefix: "morpho-vault-v1",
  });
}
