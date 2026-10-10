-- rollout-safety: backward-compatible
-- data-migration: reviewed
-- Freeze projectors previously persisted CHAIN_META display names. All nine
-- blacklist chains have canonical IDs equal to their lowercased display names.
-- Keep event identity, source clocks, title and payload display names unchanged.
UPDATE tape_events
SET chain = lower(chain)
WHERE source_table = 'blacklist_events'
  AND type IN ('freeze.blocked', 'freeze.unblocked', 'freeze.destroyed')
  AND chain IN ('Ethereum', 'Arbitrum', 'Base', 'Optimism', 'Polygon',
                'Avalanche', 'BSC', 'Gnosis', 'Tron');
