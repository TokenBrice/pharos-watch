-- rollout-safety: backward-compatible
-- Repair persisted Tape methodology source URLs emitted before the projector
-- used the shared public changelog path constants.

UPDATE tape_events
SET source_url = '/methodology/liquidity-score-changelog/'
WHERE type = 'methodology.bumped:liquidity-score'
  AND source_table = 'methodology:liquidity-score'
  AND source_url = '/methodology/liquidity-changelog/';

UPDATE tape_events
SET source_url = '/methodology/stability-index-changelog/'
WHERE type = 'methodology.bumped:stability-index'
  AND source_table = 'methodology:stability-index'
  AND source_url = '/methodology/psi-changelog/';
