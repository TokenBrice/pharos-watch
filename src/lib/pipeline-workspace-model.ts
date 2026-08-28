import type { StatusResponse, StatusSectionKey } from "@shared/types";
import { pickInitialMode, type WorkspaceSeverity } from "@/lib/status/workspace-mode";
import { buildPipelineModeSummaries } from "@/lib/pipeline-workspace-mode-summary-builder";

export const PIPELINE_MODES = [
  { id: "quality", label: "Quality" },
  { id: "markets", label: "Markets" },
  { id: "reserves", label: "Reserves" },
  { id: "yield", label: "Yield" },
  { id: "storage", label: "Storage" },
  { id: "integrity", label: "Integrity" },
] as const;

export type PipelineMode = (typeof PIPELINE_MODES)[number]["id"];
export type PipelineSeverity = WorkspaceSeverity;

export const PIPELINE_STATE_META: Record<PipelineSeverity, { label: string; className: string }> = {
  healthy: { label: "Healthy", className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
  watch: { label: "Watch", className: "bg-amber-500/15 text-amber-800 dark:text-amber-300" },
  critical: { label: "Critical", className: "bg-red-500/15 text-red-700 dark:text-red-300" },
  unknown: { label: "Unknown", className: "bg-muted text-muted-foreground" },
};

export interface PipelineModeSummary {
  id: PipelineMode;
  label: string;
  issueCount: number;
  severity: PipelineSeverity;
}

export interface PipelineLoaderError {
  mode: PipelineMode;
  label: string;
  rawKey: StatusSectionKey;
  code: string;
  message: string;
}

export interface PipelineQualityRow {
  id: "missing-prices" | "blacklist-gaps" | "onchain-divergences" | "stale-onchain";
  label: string;
  rawCode: string;
  currentValue: string;
  eligiblePopulation: string;
  warningThreshold: string;
  staleThreshold: string;
  state: PipelineSeverity;
  stateDetail: string;
  trend: string;
}

export interface PipelineQualityModel {
  rows: PipelineQualityRow[];
  activeDepegs: {
    currentValue: string;
    detail: string;
    rawCode: string;
    unavailable: boolean;
  };
}

export interface PipelineIntegrityRow {
  id: string;
  label: string;
  rawCode: string;
  state: PipelineSeverity;
  currentValue: string;
  detail: string;
}

export interface PipelineIntegrityModel {
  publicationRows: PipelineIntegrityRow[];
  dependencyRows: PipelineIntegrityRow[];
  controlRows: PipelineIntegrityRow[];
  issueCount: number;
  severity: PipelineSeverity;
}

const PIPELINE_ERROR_META: Partial<Record<StatusSectionKey, { mode: PipelineMode; label: string }>> = {
  priceSourceHealth: { mode: "markets", label: "Price source health" },
  liquidityHealth: { mode: "markets", label: "Liquidity health" },
  coingeckoPriceDiff: { mode: "markets", label: "CoinGecko comparison" },
  reserveComposition: { mode: "reserves", label: "Reserve composition" },
  mintBurnReconciliation: { mode: "reserves", label: "Mint/burn reconciliation" },
  reserveDrift: { mode: "reserves", label: "Reserve drift" },
  classificationWarnings: { mode: "reserves", label: "Classification warnings" },
  yieldHealth: { mode: "yield", label: "Yield health" },
  d1Usage: { mode: "storage", label: "D1 usage" },
  publicationHealth: { mode: "integrity", label: "Publication health" },
  dependencyHealth: { mode: "integrity", label: "Dependency health" },
};

export function collectPipelineLoaderErrors(data: StatusResponse): PipelineLoaderError[] {
  return (Object.entries(data.sectionErrors) as Array<[StatusSectionKey, StatusResponse["sectionErrors"][StatusSectionKey]]>)
    .flatMap(([rawKey, error]) => {
      const meta = PIPELINE_ERROR_META[rawKey];
      if (!meta || !error) return [];
      return [{ ...meta, rawKey, code: error.code, message: error.message }];
    })
    .sort((left, right) => {
      const modeOrder = PIPELINE_MODES.findIndex((mode) => mode.id === left.mode)
        - PIPELINE_MODES.findIndex((mode) => mode.id === right.mode);
      return modeOrder || left.label.localeCompare(right.label);
    });
}

export { buildPipelineQualityModel } from "@/lib/pipeline-workspace-quality-builder";
export { buildPipelineIntegrityModel } from "@/lib/pipeline-workspace-integrity-builder";
export { buildPipelineModeSummaries } from "@/lib/pipeline-workspace-mode-summary-builder";

export function deriveInitialPipelineMode(data: StatusResponse): PipelineMode {
  return pickInitialMode(buildPipelineModeSummaries(data), PIPELINE_MODES, "quality");
}
