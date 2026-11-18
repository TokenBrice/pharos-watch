-- rollout-safety: backward-compatible
ALTER TABLE mint_burn_scan_coverage ADD COLUMN writer_epoch TEXT;
