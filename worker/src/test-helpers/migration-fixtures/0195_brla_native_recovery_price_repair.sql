-- rollout-safety: backward-compatible
-- BRLA event 90509 opened from a native BRLA/BRL quote against a 1.0
-- reference, but the pre-v6.096 recovery path stored the USD primary price.
-- No same-domain recovery observation was retained, so clear the mixed-unit
-- value instead of inventing a native quote after the fact.

UPDATE depeg_events
SET recovery_price = NULL
WHERE id = 90509
  AND stablecoin_id = 'brla-brla-digital'
  AND symbol = 'BRLA'
  AND peg_type = 'peggedREAL'
  AND direction = 'below'
  AND peak_deviation_bps = -150
  AND started_at = 1783600469
  AND ended_at = 1783601364
  AND start_price = 0.984969
  AND peak_price = 0.984969
  AND recovery_price = 0.1918020523709537
  AND peg_reference = 1
  AND source = 'live'
  AND close_reason = 'recovered-primary';
