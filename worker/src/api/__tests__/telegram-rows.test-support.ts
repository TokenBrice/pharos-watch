import type { SubscriptionRow } from "../telegram-webhook-shared";

export function makeSubscriptionRow(stablecoinId: string, overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    stablecoin_id: stablecoinId,
    alert_dews: 1,
    alert_depeg: 0,
    alert_safety: 0,
    alert_launch: 0,
    alert_reserve: 0,
    dews_min_band: null,
    safety_mode: null,
    depeg_worsening_bps_step: null,
    ...overrides,
  };
}

export function pendingRowFromForget(options: {
  initiator_user_id?: string | null;
  expires_at?: number;
  action_type?: string;
} = {}) {
  return {
    action_type: options.action_type ?? "forget-confirm",
    action_payload: "{}",
    alert_types: "[]",
    resolved_ids: "[]",
    ambiguous_ticker: "",
    candidates: "[]",
    remaining_tickers: "[]",
    expires_at: options.expires_at ?? Math.floor(Date.now() / 1000) + 60,
    initiator_user_id: options.initiator_user_id ?? null,
  };
}

export function makeBulkPendingRow(
  payload: { kind: "subscribe" | "unsubscribe"; presetIds: string[]; coinIds: string[]; alertTypes?: string[]; subscribeAll?: boolean; unsubscribeAll?: boolean },
  options: { expires_at: number; initiator_user_id: string | null },
) {
  return {
    action_type: "confirm-bulk",
    action_payload: JSON.stringify(payload),
    alert_types: "[]",
    resolved_ids: "[]",
    ambiguous_ticker: "",
    candidates: "[]",
    remaining_tickers: "[]",
    ...options,
  };
}
