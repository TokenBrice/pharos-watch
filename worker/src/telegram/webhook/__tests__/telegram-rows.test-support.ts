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
