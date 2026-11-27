-- rollout-safety: backward-compatible
-- Track confirmed re-escalation on long-running (>30d) open depeg events:
-- anchor ratchets upward only, and a two-sample candidate window prevents single-wick spam.
ALTER TABLE depeg_events ADD COLUMN peak_escalated_at INTEGER;
ALTER TABLE depeg_events ADD COLUMN peak_escalation_anchor_bps INTEGER;
ALTER TABLE depeg_events ADD COLUMN peak_escalation_candidate_at INTEGER;
ALTER TABLE depeg_events ADD COLUMN peak_escalation_candidate_seen_at INTEGER;
