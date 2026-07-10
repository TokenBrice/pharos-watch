export { isRecord } from "@shared/lib/type-guards";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { rethrowIfAborted } from "../abort";
import { chunkArray } from "../collections";
import { USER_AGENT } from "../constants";
import { fetchWithRetry } from "../fetch-retry";
import { parsePositiveNumber } from "../number-utils";
import {
  endpointLabel,
  type PricingProviderAttemptDiagnostic,
  type PricingProviderDiagnosticSource,
  type PricingProviderRejectionReason,
} from "../pricing-provider-diagnostics";
import {
  applyJsonParseFailureDiagnostic,
  buildPricingProviderDiagnostic,
} from "../pricing-provider-lifecycle";
import type {
  AddressPriceProviderKey,
  AddressPriceProviderRunResult,
  AddressPriceQuote,
  AddressPriceTarget,
} from "./types";
import { readResponseTextBoundedWithSignal, readResponseTextWithSignal } from "../response-body";

export const ADDRESS_PROVIDER_MIN_LIQUIDITY_USD = 50_000;
export const ADDRESS_PROVIDER_RUN_BUDGET_MS = 90_000;

const ADDRESS_PROVIDER_TIMEOUT_MS = 5_000;
const ADDRESS_PROVIDER_ERROR_BODY_MAX_BYTES = 2_000;
const ADDRESS_PROVIDER_MAX_RETRIES = 0;
const PASSTHROUGH_STATUSES = [400, 401, 403, 404, 408, 409, 418, 425, 429, 451, 500, 502, 503, 504];

function parseRetryAfterSec(response: Response, nowMs = Date.now()): number | undefined {
  const value = response.headers.get("Retry-After")?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.max(0, Math.ceil((retryAt - nowMs) / 1000));
}

async function readProviderResponseText(response: Response, signal?: AbortSignal): Promise<string> {
  const timeout = createTimeoutSignal({
    timeoutMs: ADDRESS_PROVIDER_TIMEOUT_MS,
    timeoutReason: new DOMException(`response body timed out after ${ADDRESS_PROVIDER_TIMEOUT_MS}ms`, "TimeoutError"),
    parentSignal: signal,
  });
  try {
    return await readResponseTextWithSignal(response, timeout.signal);
  } finally {
    timeout.dispose();
  }
}

function sanitizeProviderSnippet(value: string): string | undefined {
  const snippet = value.replace(/\s+/g, " ").trim().slice(0, 240);
  return snippet.length > 0 ? snippet : undefined;
}

async function readProviderResponseSnippet(response: Response, signal?: AbortSignal): Promise<string | undefined> {
  const timeout = createTimeoutSignal({
    timeoutMs: ADDRESS_PROVIDER_TIMEOUT_MS,
    timeoutReason: new DOMException(`response body timed out after ${ADDRESS_PROVIDER_TIMEOUT_MS}ms`, "TimeoutError"),
    parentSignal: signal,
  });
  try {
    return sanitizeProviderSnippet(
      await readResponseTextBoundedWithSignal(response, ADDRESS_PROVIDER_ERROR_BODY_MAX_BYTES, timeout.signal),
    );
  } catch (error) {
    rethrowIfAborted(error, signal);
    return undefined;
  } finally {
    timeout.dispose();
  }
}

export function hasValue(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function normalizeAddressForKey(address: string): string {
  const trimmed = address.trim();
  return trimmed.startsWith("0x") ? trimmed.toLowerCase() : trimmed;
}

export function parseObservedAt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value > 10_000_000_000 ? value / 1000 : value);
  }
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.floor(numeric > 10_000_000_000 ? numeric / 1000 : numeric);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

export { parsePositiveNumber };

export function parseNonNegativeNumber(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

/**
 * Drops null-valued provenance fields so only well-typed values (callers must
 * pre-narrow each field to its concrete type or null) land in quote.metadata.
 */
export function narrowMetadata<T>(fields: Record<string, T | null>): Record<string, T> {
  const result: Record<string, T> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value != null) result[key] = value;
  }
  return result;
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

export function getTokenAddressFromRecord(record: Record<string, unknown>): string | null {
  const value = record.address ?? record.tokenAddress ?? record.token_address;
  return typeof value === "string" && value.trim() ? normalizeAddressForKey(value) : null;
}

export async function fetchProviderJson(params: {
  provider: AddressPriceProviderKey;
  url: string;
  endpoint?: string;
  fetchLogUrl?: string;
  init?: RequestInit;
  candidateCount: number;
  signal?: AbortSignal;
}): Promise<{ json: unknown | null; diagnostic: PricingProviderAttemptDiagnostic }> {
  const baseDiagnostic = {
    source: params.provider as PricingProviderDiagnosticSource,
    stage: "primary" as const,
    endpoint: params.endpoint ?? endpointLabel(params.url),
    candidateCount: params.candidateCount,
  };

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
      }),
    };
  }

  const diagnostic = buildPricingProviderDiagnostic(baseDiagnostic, {
    status: response.status,
    ok: response.ok,
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

export function emptyProviderResult(
  provider: AddressPriceProviderKey,
  candidateCount: number,
  reason: PricingProviderRejectionReason,
): AddressPriceProviderRunResult {
  return {
    quotes: [],
    diagnostics: [{
      source: provider as PricingProviderDiagnosticSource,
      stage: "primary",
      endpoint: provider,
      status: null,
      ok: false,
      success: false,
      candidateCount,
      rejectionReasonCounts: { [reason]: candidateCount },
    }],
    rejectedTargets: { [reason]: candidateCount },
    successfulRequests: 0,
    attemptedRequests: 0,
  };
}

/** Initialize the mutable accumulators shared by every address-price provider run function. */
export function createProviderRunState(): {
  diagnostics: AddressPriceProviderRunResult["diagnostics"];
  quotes: AddressPriceQuote[];
  rejectedTargets: AddressPriceProviderRunResult["rejectedTargets"];
  successfulRequests: number;
  attemptedRequests: number;
} {
  return {
    diagnostics: [],
    quotes: [],
    rejectedTargets: {},
    successfulRequests: 0,
    attemptedRequests: 0,
  };
}
