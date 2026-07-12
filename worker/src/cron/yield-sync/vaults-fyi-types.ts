import type { ResolvedYieldCandidate } from "./types";

export type VaultsFyiRunStatus = "ok" | "skipped" | "partial" | "failed";

export type VaultsFyiSkipReason =
  | "disabled"
  | "no-key"
  | "credit-cap"
  | "provider-quota"
  | "circuit-open"
  | "unauthorized"
  | "invalid-config"
  | "credit-ledger-corrupt"
  | "request-failed"
  | "invalid-payload";

export interface VaultsFyiTelemetry {
  enabled: boolean;
  hasKey: boolean;
  consumptionMode: "disabled" | "probe-only" | "rankable";
  consumptionReason: "source-disabled" | "rankable-allowlist-empty" | "rankable-allowlist-configured";
  status: VaultsFyiRunStatus;
  skipReason: VaultsFyiSkipReason | null;
  requestCount: number;
  pageCount: number;
  pageCapReached: boolean;
  creditsEstimated: number;
  creditsCap: number;
  creditCapReached: boolean;
  monthlyCreditsEstimated: number | null;
  monthlyCreditsReserved: number | null;
  monthlyCreditsCap: number;
  monthlyCreditsForecast: number | null;
  monthlyUnthrottledForecast: number | null;
  monthlyBudgetUtilization: number | null;
  monthlyBudgetWarning: boolean;
  monthlyRunsRemaining: number | null;
  monthlyLedgerState: "unavailable" | "missing" | "valid" | "corrupt";
  coverageBudgetState: "unavailable" | "within-budget" | "warning" | "throttled" | "exhausted";
  rawVaultCount: number;
  rankableCandidateCount: number;
  auditOnlyCount: number;
  malformedDropCount: number;
  unsupportedChainCount: number;
  identityMissCount: number;
  sizeGateDropCount: number;
  warningDropCount: number;
  durationMs: number;
  budgetMs: number;
  budgetExhausted: boolean;
  dropExamples: string[];
}

export interface VaultsFyiSourceResult {
  candidates: ResolvedYieldCandidate[];
  telemetry: VaultsFyiTelemetry;
}

export interface ParsedRankableVault {
  network: string;
  vaultId: string;
}
