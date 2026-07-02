import {
  getCircuitRecord,
  recordOutcomeSafe,
  shouldAttemptFetch,
} from "./circuit-breaker";
import {
  errorClassFor,
  errorMessageFor,
  readResponseSnippet,
  type PricingProviderAttemptDiagnostic,
  type PricingProviderDiagnosticSource,
  type PricingProviderRejectionReason,
} from "./pricing-provider-diagnostics";
import { cancelResponseBodyQuietly } from "./response-body";

export interface PricingProviderDiagnosticBase {
  source: PricingProviderDiagnosticSource;
  stage: PricingProviderAttemptDiagnostic["stage"];
  endpoint: string;
  candidateCount?: number;
}

export function buildPricingProviderDiagnostic(
  base: PricingProviderDiagnosticBase,
  overrides?: Partial<Omit<PricingProviderAttemptDiagnostic, "source" | "stage" | "endpoint">>,
): PricingProviderAttemptDiagnostic {
  return {
    ...base,
    status: overrides?.status ?? null,
    ok: overrides?.ok ?? false,
    success: overrides?.success ?? false,
    ...overrides,
  };
}

export function buildNoCandidatesDiagnostic(
  base: PricingProviderDiagnosticBase,
): PricingProviderAttemptDiagnostic {
  return buildPricingProviderDiagnostic(base, {
    status: null,
    ok: true,
    success: true,
    candidateCount: 0,
  });
}

export function buildBlockedProviderDiagnostic(
  base: PricingProviderDiagnosticBase,
  errorMessage: string,
): PricingProviderAttemptDiagnostic {
  return buildPricingProviderDiagnostic(base, {
    status: null,
    ok: false,
    success: false,
    errorClass: "blocked",
    errorMessage,
    rejectionReasonCounts: { blocked: 1 },
  });
}

export function buildCapSkipDiagnostic(
  provider: { source: PricingProviderDiagnosticSource; label: string },
  cappedTargets: number,
): PricingProviderAttemptDiagnostic {
  return {
    source: provider.source,
    stage: "primary",
    endpoint: `${provider.source}:request-cap`,
    status: null,
    ok: true,
    success: true,
    candidateCount: cappedTargets,
    errorClass: "cap",
    errorMessage: `Skipped ${cappedTargets} ${provider.label} target${cappedTargets === 1 ? "" : "s"} after request cap`,
  };
}

export async function recoverProviderOnNoCandidates(params: {
  db?: D1Database;
  circuitSource: string;
  diagnostic: PricingProviderDiagnosticBase;
  diagnostics: PricingProviderAttemptDiagnostic[];
}): Promise<void> {
  if (!params.db) return;
  const record = await getCircuitRecord(params.db, params.circuitSource);
  if (record.state === "closed") return;
  params.diagnostics.push(buildNoCandidatesDiagnostic(params.diagnostic));
  await recordOutcomeSafe(params.db, params.circuitSource, true);
}

export async function isProviderCircuitAllowed(params: {
  db?: D1Database;
  circuitSource: string;
  diagnostic: PricingProviderDiagnosticBase;
  diagnostics?: PricingProviderAttemptDiagnostic[];
  errorMessage: string;
}): Promise<boolean> {
  const allowed = params.db ? await shouldAttemptFetch(params.db, params.circuitSource) : true;
  if (!allowed && params.diagnostics) {
    params.diagnostics.push(buildBlockedProviderDiagnostic(params.diagnostic, params.errorMessage));
  }
  return allowed;
}

export async function applyNonOkProviderDiagnostic(
  diagnostic: PricingProviderAttemptDiagnostic,
  response: Response | null | undefined,
  options?: {
    noResponseErrorMessage?: string;
    noResponseReason?: PricingProviderRejectionReason;
  },
): Promise<PricingProviderAttemptDiagnostic> {
  if (!response) {
    return {
      ...diagnostic,
      status: null,
      ok: false,
      success: false,
      errorClass: "no-response",
      ...(options?.noResponseErrorMessage ? { errorMessage: options.noResponseErrorMessage } : {}),
      rejectionReasonCounts: { [options?.noResponseReason ?? "upstream-error"]: 1 },
    };
  }

  const snippet = await readResponseSnippet(response);
  if (!snippet) {
    await cancelResponseBodyQuietly(response);
  }

  return {
    ...diagnostic,
    status: response.status,
    ok: false,
    success: false,
    ...(snippet ? { snippet } : {}),
    rejectionReasonCounts: { "non-ok": 1 },
  };
}

export function responseFromBufferedBody(result: { response: Response; body: string }): Response {
  return new Response(result.body, {
    status: result.response.status,
    statusText: result.response.statusText,
    headers: result.response.headers,
  });
}

export function applyJsonParseFailureDiagnostic(
  diagnostic: PricingProviderAttemptDiagnostic,
  error: unknown,
): PricingProviderAttemptDiagnostic {
  return {
    ...diagnostic,
    success: false,
    errorClass: errorClassFor(error),
    errorMessage: errorMessageFor(error),
    rejectionReasonCounts: { "malformed-json": 1 },
  };
}

export function applyInvalidShapeDiagnostic(
  diagnostic: PricingProviderAttemptDiagnostic,
  errorMessage: string,
): PricingProviderAttemptDiagnostic {
  return {
    ...diagnostic,
    errorClass: "invalid-shape",
    errorMessage,
    rejectionReasonCounts: { "invalid-shape": 1 },
  };
}

export async function recordProviderOutcomeSafe(params: {
  db?: D1Database;
  circuitSource: string;
  attempted: number;
  successful: number;
  recordWhenNoAttempts?: boolean;
}): Promise<void> {
  if (!params.db) return;
  if (params.attempted <= 0 && !params.recordWhenNoAttempts) return;
  await recordOutcomeSafe(params.db, params.circuitSource, params.successful > 0);
}
