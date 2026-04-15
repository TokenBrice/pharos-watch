export type PricingProviderDiagnosticSource = "binance" | "jupiter";

export interface PricingProviderAttemptDiagnostic {
  source: PricingProviderDiagnosticSource;
  stage: "primary" | "fallback" | "health-probe" | "depeg-confirmation";
  endpoint: string;
  status: number | null;
  ok: boolean;
  success: boolean;
  candidateCount?: number;
  responseRowCount?: number;
  matchedCount?: number;
  resolvedCount?: number;
  errorClass?: string;
  errorMessage?: string;
  snippet?: string;
}

const MAX_SNIPPET_CHARS = 240;

export function endpointLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return url.slice(0, MAX_SNIPPET_CHARS);
  }
}

export function errorClassFor(error: unknown): string {
  if (error instanceof DOMException && error.name) return error.name;
  if (error instanceof Error && error.name) return error.name;
  return typeof error;
}

export function errorMessageFor(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return sanitizeSnippet(raw);
}

function sanitizeSnippet(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_SNIPPET_CHARS);
}

export async function readResponseSnippet(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    const snippet = sanitizeSnippet(text);
    return snippet.length > 0 ? snippet : undefined;
  } catch {
    return undefined;
  }
}
