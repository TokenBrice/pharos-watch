import { formatSchemaLikeIssues } from "@shared/lib/schema-like";
import { z } from "zod";
import { logWorkerEventArgs } from "../../lib/structured-log";
import { CIRCUIT_SOURCE, DEFILLAMA_BASE } from "../../lib/constants";
import { fetchTextWithRetry } from "../../lib/fetch-retry";
import { recordOutcomeSafe, shouldAttemptFetch } from "../../lib/circuit-breaker";
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

type PegBuckets = Record<string, number>;

/**
 * Zod schema for the DefiLlama stablecoin detail response.
 * Validates essential fields used by normalizeDefiLlamaDetailBody.
 * Extra fields are allowed via passthrough so new DL fields don't cause failures.
 */
const DlTokenEntrySchema = z
  .object({
    totalCirculatingUSD: z.record(z.string(), z.number()).optional(),
    totalCirculating: z.record(z.string(), z.number()).optional(),
    circulating: z.record(z.string(), z.number()).optional(),
  })
  .passthrough();

const DlDetailResponseSchema = z
  .object({
    price: z.number().optional(),
    tokens: z.array(DlTokenEntrySchema).optional(),
  })
  .passthrough();

function isNonUsdPeg(meta: PegMeta | undefined): boolean {
  return !!meta && meta.flags.pegCurrency !== "USD";
}

function toPegBuckets(value: unknown): PegBuckets | undefined {
  if (!value || typeof value !== "object") return undefined;
  const buckets: PegBuckets = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      buckets[key] = raw;
    }
  }
  return Object.keys(buckets).length > 0 ? buckets : undefined;
}

function scalePegBuckets(buckets: PegBuckets, multiplier: number): PegBuckets {
  const scaled: PegBuckets = {};
  for (const [key, value] of Object.entries(buckets)) {
    scaled[key] = value * multiplier;
  }
  return scaled;
}

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
 * Validates upstream JSON and materializes consistent chart fields:
 * - totalCirculating: native units
 * - totalCirculatingUSD: USD market cap
 *
 * Raw upstream fields such as `circulating` are preserved for compatibility.
 * Throws on invalid JSON to preserve existing upstream-parse error behavior.
 */
export function normalizeDefiLlamaDetailBody(
  body: string,
  meta: PegMeta | undefined,
): string {
  const parsed = JSON.parse(body) as {
    price?: unknown;
    tokens?: Array<{
      totalCirculatingUSD?: Record<string, number>;
      totalCirculating?: Record<string, number>;
      circulating?: Record<string, number>;
      [key: string]: unknown;
    }>;
    address?: unknown;
    chainBalances?: unknown;
  };

  // Drop the per-chain full-history blob: for large coins it is ~98% of the
  // upstream payload (USDT: ~21.0 MB of 21.3 MB across 127 chains), has no
  // consumer in the documented contract or the frontend, and pushed detail
  // cache rows past D1's 2 MiB value cap — silently freezing flagship coins'
  // cached detail for weeks. Current per-chain supply remains available via
  // /api/stablecoins chainCirculating.
  delete parsed.chainBalances;

  const schemaResult = DlDetailResponseSchema.safeParse(parsed);
  if (!schemaResult.success) {
    const issues = formatSchemaLikeIssues(schemaResult.error.issues);
    logWorkerEventArgs("api", "warn", `[defillama-detail] Response schema mismatch: ${issues}`);
  }

  const curatedAddress = getCuratedPrimaryAddress(meta);
  if (curatedAddress) {
    parsed.address = curatedAddress;
  }

  if (!Array.isArray(parsed.tokens)) {
    // Serialize unconditionally so the chainBalances strip applies even when
    // there is no curated address and no tokens array to normalize.
    return JSON.stringify(parsed);
  }

  const isNonUsd = isNonUsdPeg(meta);
  const price =
    typeof parsed.price === "number" && Number.isFinite(parsed.price) && parsed.price > 0
      ? parsed.price
      : null;

  for (const entry of parsed.tokens) {
    const rawTotalCirculating = toPegBuckets(entry.totalCirculating);
    const rawCirculating = toPegBuckets(entry.circulating);
    const rawTotalCirculatingUsd = toPegBuckets(entry.totalCirculatingUSD);

    if (isNonUsd) {
      const nativeBuckets = rawTotalCirculating ?? rawCirculating;
      if (nativeBuckets) {
        entry.totalCirculating = nativeBuckets;
        if (price != null) {
          entry.totalCirculatingUSD = scalePegBuckets(nativeBuckets, price);
        } else if (rawTotalCirculatingUsd) {
          entry.totalCirculatingUSD = rawTotalCirculatingUsd;
        }
      } else if (rawTotalCirculatingUsd) {
        entry.totalCirculatingUSD = rawTotalCirculatingUsd;
        if (price != null) {
          entry.totalCirculating = scalePegBuckets(rawTotalCirculatingUsd, 1 / price);
        }
      }
      continue;
    }

    const nativeBuckets = rawTotalCirculating ?? rawCirculating;
    if (nativeBuckets) {
      entry.totalCirculating = nativeBuckets;
    }
    if (rawTotalCirculatingUsd) {
      entry.totalCirculatingUSD = rawTotalCirculatingUsd;
      if (!nativeBuckets) {
        entry.totalCirculating = rawTotalCirculatingUsd;
      }
    }
  }

  return JSON.stringify(parsed);
}

export async function handleDefiLlamaDetail(
  config: {
    db: D1Database;
    stablecoinId: string;
    llamaId: string;
    meta: PegMeta | undefined;
  },
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
      { timeoutMs: DETAIL_UPSTREAM_TIMEOUT_MS },
    );

    if (!result?.response.ok) {
      await recordOutcomeSafe(config.db, CIRCUIT_SOURCE.DL_STABLECOIN_DETAIL, false);
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
    let body: string;
    try {
      body = normalizeDefiLlamaDetailBody(upstreamBody, config.meta);
    } catch (err) {
      await recordOutcomeSafe(config.db, CIRCUIT_SOURCE.DL_STABLECOIN_DETAIL, false);
      logUpstreamException("defillama-stablecoin-detail-parse", config.stablecoinId, err);
      const fallback = await detail.trySupplyHistoryFallback("defillama-parse-failure");
      if (fallback) return fallback;
      return detail.staleCacheOrError(502, `Invalid upstream data for stablecoin ${config.stablecoinId}`);
    }

    await recordOutcomeSafe(config.db, CIRCUIT_SOURCE.DL_STABLECOIN_DETAIL, true);
    return detail.createFreshResponseFromBody(body);
  } catch (err) {
    await recordOutcomeSafe(config.db, CIRCUIT_SOURCE.DL_STABLECOIN_DETAIL, false);
    logUpstreamException("defillama-stablecoin-detail", config.stablecoinId, err);
    const fallback = await detail.trySupplyHistoryFallback("defillama-exception");
    if (fallback) return fallback;
    return detail.staleCacheOrError(502, `Failed to fetch stablecoin ${config.stablecoinId}`);
  }
}
