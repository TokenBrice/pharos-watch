import type { DdrResponse, DdrRow } from "@shared/types/depeg-resolver";
import type { DdrV2StoreContracts } from "../depeg-resolver-v2-contracts";

export interface ComputeDepegResolverV2Options {
  db: D1Database;
  signal?: AbortSignal;
  ddrRunId?: string;
  runAt?: number;
  slot?: string;
  stablecoinsCacheSafe?: boolean;
  depegPipelineHealthy?: boolean;
  syncCapabilities?: Record<string, unknown>;
  storeContracts?: DdrV2StoreContracts;
}

export type NormalizedComputeDepegResolverOptions =
  Required<
    Pick<
      ComputeDepegResolverV2Options,
      "db" | "ddrRunId" | "runAt" | "slot" | "stablecoinsCacheSafe" | "depegPipelineHealthy" | "syncCapabilities"
    >
  > &
  Pick<ComputeDepegResolverV2Options, "signal"> & { storeContracts: DdrV2StoreContracts };

export interface DdrEventDbRow {
  id: number;
  stablecoin_id: string;
  symbol: string;
  peg_type: string;
  direction: string;
  peak_deviation_bps: number;
  started_at: number;
  ended_at: number | null;
  recovery_price: number | null;
  peg_reference: number;
  source: string | null;
  confirmation_sources: string | null;
  pending_reason: string | null;
  provenance_replay_run_id: string | null;
  provenance_replay_version: string | null;
}

export interface CurrentDeviationMapResult {
  byCoin: Map<string, number | null>;
  healthy: boolean;
  degradedReason: string | null;
  dataAsOf: number | null;
}

export interface QueryRowsResult<T> {
  rows: T[];
  error: string | null;
}

export interface DdrPendingPromotionOutcomeRow {
  stablecoin_id: string;
  peg_type: string;
  direction: string;
  first_seen_at: number;
  outcome_at: number;
}

export type DdrDiagnosticResponse = Omit<DdrResponse, "rows"> & { rows: DdrRow[] };
export type DdrLineage = NonNullable<DdrResponse["_meta"]["lineage"]>;
