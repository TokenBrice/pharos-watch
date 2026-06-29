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
  | "request-failed"
  | "invalid-payload";

export interface VaultsFyiTelemetry {
  enabled: boolean;
  hasKey: boolean;
  status: VaultsFyiRunStatus;
  skipReason: VaultsFyiSkipReason | null;
  requestCount: number;
  pageCount: number;
  creditsEstimated: number;
  creditsCap: number;
  monthlyCreditsEstimated: number | null;
  monthlyCreditsCap: number;
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
