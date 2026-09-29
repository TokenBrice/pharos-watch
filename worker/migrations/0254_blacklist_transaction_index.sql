-- rollout-safety: backward-compatible
-- NULL retains the fail-closed order verdict until a confirmed block is read.
ALTER TABLE blacklist_events ADD COLUMN transaction_index INTEGER CHECK (transaction_index IS NULL OR transaction_index >= 0);
