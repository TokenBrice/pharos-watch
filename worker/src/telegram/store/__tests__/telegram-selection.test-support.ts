export function makeSelectionSubscription(stablecoinId: string, dewsMinBand: string | null = null) {
  return {
    stablecoin_id: stablecoinId,
    alert_dews: 1,
    alert_depeg: 0,
    alert_safety: 0,
    dews_min_band: dewsMinBand,
    safety_mode: null,
    depeg_worsening_bps_step: null,
  };
}

export function makePendingSelectionRow(actionType: string, actionPayload: string, initiatorUserId: string | null = null) {
  return {
    action_type: actionType,
    action_payload: actionPayload,
    expires_at: Math.floor(Date.now() / 1000) + 60,
    initiator_user_id: initiatorUserId,
  };
}
