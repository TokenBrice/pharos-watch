import type { ReserveSlice } from "./core";

export type {
  LiveReserveAdapterKey,
  LiveReserveEvidenceClass,
  LiveReserveFeedClass,
  LiveReserveFreshnessMode,
  LiveReserveInput,
  LiveReserveSnapshotMetadata,
  LiveReserveSourceModel,
  LiveReserveSemantics,
  LiveReserveSourceSharingMode,
  LiveReserveWarning,
  LiveReserveWarningEffect,
  LiveReservesConfig,
} from "../lib/live-reserve-adapters";

export type ReservePresentationMode =
  | "live"
  | "live-stale"
  | "curated-fallback"
  | "template-fallback"
  | "unavailable";

export interface ReserveSyncStateView {
  enabled: boolean;
  status: "ok" | "degraded" | "error" | "skipped";
  stale: boolean;
  bootstrap: boolean;
  lastAttemptedAt?: number;
  lastSuccessAt?: number;
  warnings?: string[];
  lastError?: string;
}

export interface StablecoinReservesResponse {
  stablecoinId: string;
  mode: ReservePresentationMode;
  reserves: ReserveSlice[];
  estimated: boolean;
  liveAt?: number;
  source?: string;
  displayUrl?: string;
  sync?: ReserveSyncStateView;
}
