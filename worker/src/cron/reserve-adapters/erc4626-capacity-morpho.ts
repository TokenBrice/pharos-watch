import { canonicalEvmAddress } from "@shared/lib/evm-address";
import { toErrorMessage } from "@shared/lib/error-utils";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { isRecord } from "@shared/lib/type-guards";
import { FetchRequestNotStartedError } from "../../lib/abort";
import { finiteDecimalNumberFromBigInt } from "../../lib/bigint";
import { fetchWithRetry } from "../../lib/fetch-retry";
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
  "coinId" | "contractAddress" | "assetAddress" | "underlyingDecimalsRaw" | "signal" | "ctx"
>;
type MorphoReadVersion = "v1" | "v2";

const DEFAULT_MORPHO_API_BASE_URL = "https://api.morpho.org";
const MORPHO_REQUEST_TIMEOUT_MS = 8_000;
const MORPHO_DIRECTORY_MAX_RESPONSE_BYTES = 1024 * 1024;
const MORPHO_DETAIL_MAX_RESPONSE_BYTES = 16 * 1024;
const MORPHO_DIRECTORY_PAGE_LIMIT = 1000;
const MORPHO_DIRECTORY_MAX_PAGES = 10;

// Morpho applies a 7-day IP ban at 3,334 req/10 min; trip a run-scoped flag
// on the first HTTP 429 so remaining Morpho coins short-circuit immediately.
const morphoRateLimitedRuns = new WeakMap<object, true>();

function rateLimitScope(ctx?: AdapterContext): object | null {
  return ctx?.requestCache ?? ctx ?? null;
}

function isMorphoRateLimited(ctx?: AdapterContext): boolean {
  const scope = rateLimitScope(ctx);
  return scope != null && morphoRateLimitedRuns.get(scope) === true;
}

function markMorphoRateLimited(ctx?: AdapterContext): void {
  const scope = rateLimitScope(ctx);
  if (scope != null) morphoRateLimitedRuns.set(scope, true);
}

function parseMorphoChainId(value: unknown): number | null {
  const parsed = parseDecimalNumber(value);
  return parsed != null && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseUnsignedBigInt(value: unknown): bigint | null {
  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null;
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
  | { kind: "unavailable"; detail: string };

class MorphoReadFailure extends Error {
  constructor(
    readonly kind: "rate-limited" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}

async function fetchMorphoReadJson(
  url: string,
  maxResponseBytes: number,
  signal: AbortSignal,
  ctx?: AdapterContext,
  options?: { passthrough404?: boolean },
): Promise<MorphoFetchOutcome> {
  if (isMorphoRateLimited(ctx)) return { kind: "rate-limited" };
  const requestSignal = ctx?.abortSignal && ctx.abortSignal !== signal
    ? AbortSignal.any([signal, ctx.abortSignal])
    : signal;
  const redactedUrl = redactProviderUrls(url);

  return runAdapterIo(ctx, `morpho-read:${redactedUrl}`, async () => {
    if (isMorphoRateLimited(ctx)) return { kind: "rate-limited" };
    const deadlineMs = ctx?.attemptDeadlineMs;
    const remainingMs = deadlineMs == null ? MORPHO_REQUEST_TIMEOUT_MS : deadlineMs - Date.now();
    if (remainingMs <= 0) {
      return { kind: "unavailable", detail: "attempt deadline exceeded" };
    }
    const attemptTimeoutMs = Math.min(MORPHO_REQUEST_TIMEOUT_MS, remainingMs);
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
          ...(deadlineMs != null ? { deadlineMs } : {}),
          ...(options?.passthrough404 ? { passthrough404: true } : {}),
          passthroughStatuses: [429],
          waitOnPassthrough429: false,
          beforeRequest: () => !isMorphoRateLimited(ctx),
        },
      );
      if (isMorphoRateLimited(ctx)) {
        await cancelResponseBodyQuietly(response);
        return { kind: "rate-limited" };
      }
      if (!response) {
        return { kind: "unavailable", detail: "HTTP request failed" };
      }
      if (response.status === 429) {
        markMorphoRateLimited(ctx);
        await cancelResponseBodyQuietly(response);
        return { kind: "rate-limited" };
      }
      if (response.status === 404) {
        await cancelResponseBodyQuietly(response);
        return { kind: "not-found" };
      }
      if (!response.ok) {
        await cancelResponseBodyQuietly(response);
        return { kind: "unavailable", detail: `HTTP ${response.status}` };
      }
      const bodyRemainingMs = deadlineMs == null ? MORPHO_REQUEST_TIMEOUT_MS : deadlineMs - Date.now();
      if (bodyRemainingMs <= 0) {
        await cancelResponseBodyQuietly(response);
        return { kind: "unavailable", detail: "attempt deadline exceeded" };
      }
      const bodyTimeout = createTimeoutSignal({
        timeoutMs: Math.min(MORPHO_REQUEST_TIMEOUT_MS, bodyRemainingMs),
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
          return { kind: "unavailable", detail: "malformed JSON object" };
        }
        return { kind: "ok", status: response.status, body };
      } catch (error) {
        await cancelResponseBodyQuietly(response);
        throw error;
      } finally {
        bodyTimeout.dispose();
      }
    } catch (error) {
      if (isMorphoRateLimited(ctx)) return { kind: "rate-limited" };
      if (requestSignal.aborted) throw error;
      if (error instanceof FetchRequestNotStartedError) {
        return { kind: "unavailable", detail: error.message };
      }
      return { kind: "unavailable", detail: redactProviderUrls(toErrorMessage(error)) };
    }
  }, { signal: requestSignal });
}

async function fetchMorphoVaultDirectory(
  apiBaseUrl: string,
  version: MorphoReadVersion,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<Map<string, string>> {
  const pathPrefix = version === "v1" ? "/v0/vaults-v1" : "/v0/vaults-v2";
  return getCachedRequest(
    `morpho-read-directory:${version}:${apiBaseUrl}`,
    async () => {
      const directory = new Map<string, string>();
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      let pageCount = 0;

      for (;;) {
        if (pageCount >= MORPHO_DIRECTORY_MAX_PAGES) {
          throw new MorphoReadFailure("unavailable", "directory pagination exceeded page limit");
        }
        const url = cursor
          ? `${apiBaseUrl}${pathPrefix}?limit=${MORPHO_DIRECTORY_PAGE_LIMIT}&cursor=${encodeURIComponent(cursor)}`
          : `${apiBaseUrl}${pathPrefix}?limit=${MORPHO_DIRECTORY_PAGE_LIMIT}`;
        const outcome = await fetchMorphoReadJson(url, MORPHO_DIRECTORY_MAX_RESPONSE_BYTES, signal, ctx);
        if (outcome.kind === "rate-limited") {
          throw new MorphoReadFailure("rate-limited", "Read API rate limited");
        }
        if (outcome.kind !== "ok" || !Array.isArray(outcome.body.data)) {
          const detail = outcome.kind === "unavailable" ? outcome.detail : "directory response missing data array";
          throw new MorphoReadFailure("unavailable", detail);
        }
        pageCount += 1;

        for (const item of outcome.body.data) {
          if (!isRecord(item)) continue;
          const chainId = parseMorphoChainId(item.chain_id);
          const vaultAddress = canonicalEvmAddress(item.vault_address);
          const assetAddress = canonicalEvmAddress(item.asset_address);
          if (chainId == null || !vaultAddress || !assetAddress) continue;
          const key = `${chainId}:${vaultAddress}`;
          if (!directory.has(key)) directory.set(key, assetAddress);
        }

        const nextCursor = outcome.body.cursor;
        if (nextCursor === undefined || nextCursor === null || nextCursor === "") break;
        if (typeof nextCursor !== "string" || seenCursors.has(nextCursor)) {
          throw new MorphoReadFailure("unavailable", "directory pagination cursor cycle or invalid cursor");
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }

      return {
        value: directory,
        cacheBytes: Math.max(64, directory.size * 256),
        basis: "declared-estimate" as const,
      };
    },
    ctx,
  );
}

async function fetchMorphoV2ForceDeallocatableLiquidity(
  apiBaseUrl: string,
  chainId: number,
  vaultLower: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<bigint | undefined> {
  if (isMorphoRateLimited(ctx)) return undefined;
  const outcome = await fetchMorphoReadJson(
    `${apiBaseUrl}/v0/vaults-v2/${chainId}:${vaultLower}/withdrawal-options`,
    MORPHO_DETAIL_MAX_RESPONSE_BYTES,
    signal,
    ctx,
    { passthrough404: true },
  );
  if (outcome.kind !== "ok") return undefined;
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
  ctx?: AdapterContext,
): Promise<number | null> {
  if (isMorphoRateLimited(ctx)) return null;
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
          { passthrough404: true },
        );
        if (outcome.kind === "rate-limited") {
          throw new MorphoReadFailure("rate-limited", "Read API rate limited");
        }
        if (outcome.kind === "not-found") {
          return { value: null, cacheBytes: 64, basis: "declared-estimate" as const };
        }
        if (outcome.kind !== "ok") {
          throw new MorphoReadFailure("unavailable", outcome.detail);
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
  if (isMorphoRateLimited(input.ctx)) {
    return morphoFailure(input, "rate-limited", "Read API rate limited");
  }
  const apiBaseUrl = (input.config.apiUrl ?? DEFAULT_MORPHO_API_BASE_URL).replace(/\/+$/, "");
  const vaultLower = input.contractAddress.toLowerCase();
  const assetLower = input.assetAddress.toLowerCase();
  const vaultSelector = `${input.config.chainId}:${vaultLower}`;
  const isVaultV1 = input.version === "v1";

  try {
    let directory: Map<string, string>;
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

    const listedAsset = directory.get(vaultSelector);
    if (listedAsset == null) {
      return morphoFailure(input, "unlisted", "liquidity vault is not listed");
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
    if (stateOutcome.kind !== "ok" || !isRecord(stateOutcome.body.data)) {
      return morphoFailure(input, "liquidity-unavailable", "state query returned no vault state");
    }

    const state = stateOutcome.body.data;
    if (canonicalEvmAddress(state.address) !== vaultLower) {
      return morphoFailure(input, "identity-mismatch", "liquidity vault address mismatch");
    }
    if (parseMorphoChainId(state.chain_id) !== input.config.chainId) {
      return morphoFailure(input, "chain-mismatch", "liquidity chain mismatch");
    }
    const liquidityRaw = parseUnsignedBigInt(state.withdrawable_assets);
    if (liquidityRaw == null) {
      return morphoFailure(input, "liquidity-invalid", "liquidity payload has invalid withdrawable_assets");
    }

    const forceDeallocatableLiquidityRaw = isVaultV1
      ? undefined
      : await fetchMorphoV2ForceDeallocatableLiquidity(
          apiBaseUrl,
          input.config.chainId,
          vaultLower,
          input.signal,
          input.ctx,
        );

    const underlyingDecimals = input.underlyingDecimalsRaw == null
      ? null
      : parseBoundedDecimals(input.underlyingDecimalsRaw);
    const tokenPriceUsd = underlyingDecimals != null
      ? await fetchMorphoTokenPriceUsd(apiBaseUrl, input.config.chainId, assetLower, input.signal, input.ctx)
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
