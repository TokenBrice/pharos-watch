import { formatSchemaLikeIssues } from "@shared/lib/schema-like";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { z } from "zod";
import { CIRCUIT_SOURCE, DEFILLAMA_BASE } from "../../lib/constants";
import { fetchTextWithRetry } from "../../lib/fetch-retry";
import { recordOutcomeSafe, shouldAttemptFetch } from "../../lib/circuit-breaker";
import { ScheduledFetchBudget } from "../../lib/scheduled-fetch-budget";
import { assessFreshnessTimestamp } from "../../lib/api-freshness-age";
import type { ContractDeployment } from "@shared/types/core";
import {
  type DetailResponseHelpers,
  DETAIL_UPSTREAM_MAX_RETRIES,
  DETAIL_UPSTREAM_TIMEOUT_MS,
  logUpstreamException,
  logUpstreamFailure,
} from "./shared";

interface DetailMeta {
  contracts?: ContractDeployment[];
}

interface PegMeta extends DetailMeta {
  flags: {
    pegCurrency: string;
  };
}

// Measured 2026-10-06: USDT 21.6 MB, USDC 22.9 MB before chainBalances
// removal. The shared 16 MiB default rejects these healthy provider responses.
export const DEFILLAMA_DETAIL_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

// Bound materialization across different coins, not just per-coin single-flight:
// one raw body plus its parsed history graph can occupy about 68 MB.
let detailMaterializationBudget = new ScheduledFetchBudget(1);

/** @internal Simulate isolate recycling alongside per-coin single-flight state. */
export function resetDefiLlamaDetailStateForTests(): void {
  detailMaterializationBudget = new ScheduledFetchBudget(1);
}

export async function acquireDefiLlamaDetailMaterialization(): Promise<() => void> {
  const admissionTimeout = createTimeoutSignal({
    timeoutMs: DETAIL_UPSTREAM_TIMEOUT_MS,
    timeoutReason: new DOMException("DefiLlama detail materialization queue timed out", "TimeoutError"),
  });
  try {
    return await detailMaterializationBudget.acquire(1, admissionTimeout.signal);
  } finally {
    admissionTimeout.dispose();
  }
}

interface DefiLlamaDetailConfig {
  db: D1Database;
  stablecoinId: string;
  llamaId: string;
  meta: PegMeta | undefined;
}

/**
 * Zod schema for the DefiLlama stablecoin detail response.
 * Validates essential fields used by normalizeDefiLlamaDetailBody.
 * Extra fields are allowed via passthrough so new DL fields don't cause failures.
 */
const DlSupplyBucketsSchema = z.record(z.string(), z.number().finite().nonnegative());
const DlTokenEntrySchema = z
  .object({
    date: z.number().int().positive().refine(
      (date) => assessFreshnessTimestamp(Math.floor(Date.now() / 1000), date).reason == null,
      "History date must be an admitted observation timestamp",
    ),
    totalCirculatingUSD: DlSupplyBucketsSchema.optional(),
    totalCirculating: DlSupplyBucketsSchema.optional(),
    circulating: DlSupplyBucketsSchema.optional(),
  })
  .passthrough()
  .refine(
    (entry) => [entry.totalCirculatingUSD, entry.totalCirculating, entry.circulating]
      .some((buckets) => buckets != null && Object.keys(buckets).length > 0),
    "History checkpoint must contain observed supply",
  );

const DlDetailResponseSchema = z
  .object({
    tokens: z.array(DlTokenEntrySchema),
  })
  .passthrough();

function getCuratedPrimaryAddress(meta: DetailMeta | undefined): string | null {
  const contract = meta?.contracts?.find((entry) => entry.chain === "ethereum") ?? meta?.contracts?.[0];
  return contract?.address ?? null;
}

function hasTopLevelSerializedAddress(body: string, serializedAddress: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      if (depth === 1 && body.startsWith(serializedAddress, index)) return true;
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
    }
  }

  return false;
}

export function applyCuratedDetailAddress(body: string, meta: DetailMeta | undefined): string {
  const curatedAddress = getCuratedPrimaryAddress(meta);
  if (!curatedAddress) return body;

  const serializedAddress = `"address":${JSON.stringify(curatedAddress)}`;
  if (hasTopLevelSerializedAddress(body, serializedAddress)) return body;

  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return body;
    return JSON.stringify({ ...parsed, address: curatedAddress });
  } catch {
    return body;
  }
}

/**
 * Validates required upstream history and preserves its observed unit buckets.
 * Native `circulating` aliases become `totalCirculating`; missing USD/native
 * conversions stay unavailable, regardless of peg currency or today's quote.
 * Raw upstream passthrough fields are retained after admission.
 * Throws on invalid JSON or required history shape.
 */
export function normalizeDefiLlamaDetailBody(
  body: string,
  meta: PegMeta | undefined,
): string {
  return JSON.stringify(normalizeDefiLlamaDetail(body, meta));
}

function normalizeDefiLlamaDetail(body: string, meta: PegMeta | undefined): z.infer<typeof DlDetailResponseSchema> {
  const parsed: unknown = JSON.parse(body);

  // Drop the per-chain full-history blob: for large coins it is ~98% of the
  // upstream payload (USDT: ~21.0 MB of 21.3 MB across 127 chains), has no
  // consumer in the documented contract or the frontend, and pushed detail
  // cache rows past D1's 2 MiB value cap — silently freezing flagship coins'
  // cached detail for weeks. Current per-chain supply remains available via
  // /api/stablecoins chainCirculating.
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    delete (parsed as Record<string, unknown>).chainBalances;
  }

  const schemaResult = DlDetailResponseSchema.safeParse(parsed);
  if (!schemaResult.success) {
    const issues = formatSchemaLikeIssues(schemaResult.error.issues);
    throw new Error(`Invalid DefiLlama detail history: ${issues}`);
  }

  const normalized = schemaResult.data;
  const curatedAddress = getCuratedPrimaryAddress(meta);
  if (curatedAddress) {
    normalized.address = curatedAddress;
  }

  for (const entry of normalized.tokens) {
    const nativeBuckets = entry.totalCirculating;
    if ((!nativeBuckets || Object.keys(nativeBuckets).length === 0) && entry.circulating) {
      entry.totalCirculating = entry.circulating;
    }
  }

  return normalized;
}

export async function handleDefiLlamaDetail(
  config: DefiLlamaDetailConfig,
  detail: DetailResponseHelpers,
): Promise<Response> {
  let release: () => void;
  try {
    release = await acquireDefiLlamaDetailMaterialization();
  } catch (err) {
    // Local contention is not an upstream failure and must not trip the source
    // circuit or admit a half-open probe that never reaches the provider.
    logUpstreamException("defillama-detail-admission", config.stablecoinId, err);
    const fallback = await detail.trySupplyHistoryFallback("defillama-detail-admission-timeout");
    if (fallback) return fallback;
    return detail.staleCacheOrError(503, "DefiLlama detail refresh capacity unavailable");
  }

  try {
    return await fetchAndNormalizeDefiLlamaDetail(config, detail);
  } finally {
    release();
  }
}

async function fetchAndNormalizeDefiLlamaDetail(
  config: DefiLlamaDetailConfig,
  detail: DetailResponseHelpers,
): Promise<Response> {
  const dlDetailAllowed = await shouldAttemptFetch(config.db, CIRCUIT_SOURCE.DL_STABLECOIN_DETAIL);
  if (!dlDetailAllowed) {
    const fallback = await detail.trySupplyHistoryFallback("defillama-circuit-open");
    if (fallback) return fallback;
    return detail.staleCacheOrError(503, "DefiLlama detail circuit open");
  }

  try {
    const result = await fetchTextWithRetry(
      `${DEFILLAMA_BASE}/stablecoin/${encodeURIComponent(config.llamaId)}`,
      undefined,
      DETAIL_UPSTREAM_MAX_RETRIES,
      {
        timeoutMs: DETAIL_UPSTREAM_TIMEOUT_MS,
        maxResponseBytes: DEFILLAMA_DETAIL_MAX_RESPONSE_BYTES,
        passthrough404: true,
      },
    );

    if (!result?.response.ok) {
      // A missing asset is an id-local data failure, not a provider outage.
      // Keep it unavailable/fallback-only without poisoning other coins.
      if (result?.response.status !== 404) {
        await recordOutcomeSafe(config.db, CIRCUIT_SOURCE.DL_STABLECOIN_DETAIL, false);
      }
      logUpstreamFailure(
        "defillama-stablecoin-detail",
        config.stablecoinId,
        result?.response.status ?? "no-response",
      );
      const fallback = await detail.trySupplyHistoryFallback("defillama-upstream-failure");
      if (fallback) return fallback;
      return detail.staleCacheOrError(502, `Failed to fetch stablecoin ${config.stablecoinId}`);
    }

    const upstreamBody = result.body;
    let normalized: z.infer<typeof DlDetailResponseSchema>;
    try {
      normalized = normalizeDefiLlamaDetail(upstreamBody, config.meta);
    } catch (err) {
      await recordOutcomeSafe(config.db, CIRCUIT_SOURCE.DL_STABLECOIN_DETAIL, false);
      logUpstreamException("defillama-stablecoin-detail-parse", config.stablecoinId, err);
      const fallback = await detail.trySupplyHistoryFallback("defillama-parse-failure");
      if (fallback) return fallback;
      return detail.staleCacheOrError(502, `Invalid upstream data for stablecoin ${config.stablecoinId}`);
    }

    const history = await detail.resolveTokensWithSupplyHistoryFallback(normalized.tokens, {
      emptyReason: "defillama-history-empty",
      staleReason: "defillama-history-stale",
    });
    await recordOutcomeSafe(config.db, CIRCUIT_SOURCE.DL_STABLECOIN_DETAIL, normalized.tokens.length > 0);
    if (history.tokens.length === 0) {
      return detail.staleCacheOrError(502, `Historical detail data unavailable for stablecoin ${config.stablecoinId}`);
    }
    return detail.createResponseFromResolvedTokens(history, normalized);
  } catch (err) {
    await recordOutcomeSafe(config.db, CIRCUIT_SOURCE.DL_STABLECOIN_DETAIL, false);
    logUpstreamException("defillama-stablecoin-detail", config.stablecoinId, err);
    const fallback = await detail.trySupplyHistoryFallback("defillama-exception");
    if (fallback) return fallback;
    return detail.staleCacheOrError(502, `Failed to fetch stablecoin ${config.stablecoinId}`);
  }
}
