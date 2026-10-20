export { isRecord } from "@shared/lib/type-guards";
import { coerceNonNegativeNumber } from "@shared/lib/type-guards";
import { parseRetryAfterSeconds } from "@shared/lib/retry-after";
import { chunkArray } from "../collections";
import { USER_AGENT } from "../constants";
import { DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES, fetchWithRetry } from "../fetch-retry";
import { parsePositiveNumber } from "../number-utils";
import {
  createPricingAssetAttempt,
  endpointLabel,
  type PricingProviderAttemptDiagnostic,
  type PricingProviderRejectionReason,
} from "../pricing-provider-diagnostics";
import {
  applyJsonParseFailureDiagnostic,
  buildPricingProviderDiagnostic,
} from "../pricing-provider-lifecycle";
import type { AddressPriceQuote, AddressPriceTarget } from "./types";
import { readResponseSnippetWithTimeout, readResponseTextWithinLimitWithTimeout } from "../response-body";

export const ADDRESS_PROVIDER_MIN_LIQUIDITY_USD = 50_000;
export const ADDRESS_PROVIDER_RUN_BUDGET_MS = 90_000;

const ADDRESS_PROVIDER_TIMEOUT_MS = 5_000;
const ADDRESS_PROVIDER_ERROR_BODY_MAX_BYTES = 2_000;
const ADDRESS_PROVIDER_MAX_RETRIES = 0;
const PASSTHROUGH_STATUSES = [400, 401, 403, 404, 408, 409, 418, 425, 429, 451, 500, 502, 503, 504];

function parseRetryAfterSec(response: Response, nowMs = Date.now()): number | undefined {
  const value = response.headers.get("Retry-After")?.trim();
  if (!value) return undefined;
  const parsed = parseRetryAfterSeconds(value, { nowMs });
  if (parsed != null) return parsed;
  // Preserve the provider diagnostic's legacy malformed/date fallback.
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) ? Math.max(0, Math.ceil((retryAt - nowMs) / 1000)) : undefined;
}

async function readProviderResponseText(response: Response, signal?: AbortSignal): Promise<string> {
  return readResponseTextWithinLimitWithTimeout(response, {
    timeoutMs: ADDRESS_PROVIDER_TIMEOUT_MS,
    maxBytes: DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES,
  }, signal);
}

async function readProviderResponseSnippet(response: Response, signal?: AbortSignal): Promise<string | undefined> {
  return readResponseSnippetWithTimeout(response, {
    timeoutMs: ADDRESS_PROVIDER_TIMEOUT_MS,
    maxBytes: ADDRESS_PROVIDER_ERROR_BODY_MAX_BYTES,
    maxChars: 240,
  }, signal);
}

export function hasValue(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function normalizeAddressForKey(address: string): string {
  const trimmed = address.trim();
  return trimmed.startsWith("0x") ? trimmed.toLowerCase() : trimmed;
}

export { parsePositiveNumber };

export function parseNonNegativeNumber(value: unknown): number | null {
  return coerceNonNegativeNumber(value);
}

export const chunk = chunkArray;

export function incrementReason(
  reasons: Partial<Record<PricingProviderRejectionReason, number>>,
  reason: PricingProviderRejectionReason,
  count = 1,
): void {
  reasons[reason] = (reasons[reason] ?? 0) + count;
}

export function groupTargetsByProviderChain(targets: AddressPriceTarget[]): Map<string, AddressPriceTarget[]> {
  const grouped = new Map<string, AddressPriceTarget[]>();
  for (const target of targets) {
    const list = grouped.get(target.providerChainId) ?? [];
    list.push(target);
    grouped.set(target.providerChainId, list);
  }
  return grouped;
}

export async function fetchProviderJson(params: {
  url: string;
  endpoint?: string;
  fetchLogUrl?: string;
  init?: RequestInit;
  candidateCount: number;
  targets?: readonly AddressPriceTarget[];
  candidateAt?: number;
  signal?: AbortSignal;
}): Promise<{ json: unknown | null; diagnostic: PricingProviderAttemptDiagnostic }> {
  const baseDiagnostic = {
    source: "coingecko-onchain-address" as const,
    stage: "primary" as const,
    endpoint: params.endpoint ?? endpointLabel(params.url),
    candidateCount: params.candidateCount,
  };
  const assetAttempts = params.targets?.slice(0, 100).map((target) => createPricingAssetAttempt({
    assetId: target.stablecoinId,
    adapter: "coingecko-onchain-address",
    chain: target.chain,
    target: target.address,
    state: "attempted",
    result: "unresolved",
    candidateAt: params.candidateAt ?? Math.floor(Date.now() / 1000),
  }));

  const response = await fetchWithRetry(
    params.url,
    {
      ...params.init,
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        ...params.init?.headers,
      },
      signal: params.signal,
    },
    ADDRESS_PROVIDER_MAX_RETRIES,
    {
      timeoutMs: ADDRESS_PROVIDER_TIMEOUT_MS,
      logUrl: params.fetchLogUrl,
      passthroughStatuses: PASSTHROUGH_STATUSES,
      waitOnPassthrough429: false,
    },
  );
  if (!response) {
    return {
      json: null,
      diagnostic: buildPricingProviderDiagnostic(baseDiagnostic, {
        errorClass: "no-response",
        rejectionReasonCounts: { "upstream-error": 1 },
        ...(assetAttempts ? { assetAttempts } : {}),
      }),
    };
  }

  const diagnostic = buildPricingProviderDiagnostic(baseDiagnostic, {
    status: response.status,
    ok: response.ok,
    ...(assetAttempts ? { assetAttempts } : {}),
  });

  if (!response.ok) {
    const snippet = await readProviderResponseSnippet(response, params.signal);
    return {
      json: null,
      diagnostic: {
        ...diagnostic,
        status: response.status,
        ok: false,
        success: false,
        ...(snippet ? { snippet } : {}),
        ...(response.status === 429 ? { retryAfterSec: parseRetryAfterSec(response) } : {}),
        rejectionReasonCounts: { "non-ok": 1 },
      },
    };
  }

  try {
    return { json: JSON.parse(await readProviderResponseText(response, params.signal)) as unknown, diagnostic };
  } catch (error) {
    return {
      json: null,
      diagnostic: applyJsonParseFailureDiagnostic(diagnostic, error),
    };
  }
}

export function finalizeAddressPriceDiagnosticAttempts(
  diagnostic: PricingProviderAttemptDiagnostic,
  quotes: readonly AddressPriceQuote[],
): PricingProviderAttemptDiagnostic {
  if (!diagnostic.assetAttempts?.length) return diagnostic;
  const quotesByTarget = new Map(quotes.map((quote) => [
    `${quote.stablecoinId}:${quote.chain}:${quote.address.toLowerCase()}`,
    quote,
  ]));
  const rejectionEntries = Object.entries(diagnostic.rejectionReasonCounts ?? {})
    .filter((entry): entry is [PricingProviderRejectionReason, number] => typeof entry[1] === "number" && entry[1] > 0);
  const exactSharedRejection = rejectionEntries.length === 1 && rejectionEntries[0][1] >= diagnostic.assetAttempts.length
    ? rejectionEntries[0][0]
    : null;
  return {
    ...diagnostic,
    assetAttempts: diagnostic.assetAttempts.map((attempt) => {
      const quote = attempt.chain && attempt.target
        ? quotesByTarget.get(`${attempt.assetId}:${attempt.chain}:${attempt.target.toLowerCase()}`)
        : undefined;
      if (quote) {
        return {
          ...attempt,
          source: quote.source,
          result: "resolved" as const,
          observedAt: quote.observedAt,
        };
      }
      if (!diagnostic.success) {
        return {
          ...attempt,
          result: "failed" as const,
          rejectionClass: diagnostic.errorClass ?? rejectionEntries[0]?.[0] ?? "upstream-error",
        };
      }
      if (exactSharedRejection) {
        return { ...attempt, result: "rejected" as const, rejectionClass: exactSharedRejection };
      }
      return attempt;
    }),
  };
}

