-- Remove depeg events for non-USD stablecoins below the 150 BPS threshold.
-- The detection threshold was raised from 100 to 150 BPS for non-USD pegs
-- (commit 9c0d1a6) to filter FX noise, but existing events weren't cleaned up.
DELETE FROM depeg_events
WHERE peg_type != 'peggedUSD'
  AND peak_deviation_bps < 150;
