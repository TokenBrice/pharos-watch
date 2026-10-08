import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";

export function reserveCompositionRow(now: number, overrides: { slices?: string; metadata?: string } = {}) {
  return { ...compositionDefaults(now), ...overrides };
}

function compositionDefaults(now: number) {
  return {
    stablecoin_id: "iusd-infinifi",
    slices: JSON.stringify([{ name: "Test Farm", pct: 100, risk: "low" }]),
    fetched_at: now,
    source: "infinifi",
    metadata: JSON.stringify({ freshnessMode: "not-applicable" }),
    adapter_source_model: "dynamic-mix",
    adapter_evidence_class: "independent",
    config_fingerprint: computeLiveReserveConfigFingerprint(WORKER_TRACKED_META_BY_ID.get("iusd-infinifi")!.liveReservesConfig!),
  };
}

export function reserveSyncRow(now: number, overrides: {
  last_attempted_at?: number;
  last_success_at?: number | null;
  last_status?: string;
  last_error?: string | null;
  metadata?: string;
} = {}) {
  return {
    stablecoin_id: "iusd-infinifi",
    adapter_key: "infinifi",
    config_fingerprint: computeLiveReserveConfigFingerprint(WORKER_TRACKED_META_BY_ID.get("iusd-infinifi")!.liveReservesConfig!),
    breaker_key: "live-reserves:infinifi",
    last_attempted_at: now,
    last_success_at: now,
    last_status: "ok",
    warning_count: 0,
    warnings: null,
    last_error: null,
    metadata: "{}",
    ...overrides,
  };
}
