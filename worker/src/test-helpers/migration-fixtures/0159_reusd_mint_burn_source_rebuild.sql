-- rollout-safety: backward-compatible
-- 0159: Rebuild Re Protocol reUSD mint/burn history after switching from
-- vault Deposited/InstantRedemptionRouted events to canonical token Transfer
-- events. The old vault rows cannot be distinguished from canonical rows once
-- inserted because mint_burn_events stores tx/log identity, not source contract,
-- so purge the affected coin/chain and reset the legacy vault cursors plus
-- both possible token cursor formats for a clean backfill from the checked-in
-- startBlock. Older vault rows used numeric EVM chain IDs, while the active
-- mintBurnConfigKey() uses the internal chain ID (`ethereum`) prefix.

DELETE FROM mint_burn_hourly
WHERE stablecoin_id = 'reusd-re-protocol'
  AND chain_id = 'ethereum';

DELETE FROM mint_burn_events
WHERE stablecoin_id = 'reusd-re-protocol'
  AND chain_id = 'ethereum';

DELETE FROM mint_burn_sync_state
WHERE config_key IN (
  '1-0x4691c475be804fa85f91c2d6d0adf03114de3093',
  '1-0x8aeb9453ef22cb38abc7a3af9c208f65c1bfe31e',
  '1-0x5086bf358635b81d8c47c66d1c8b9e567db70c72',
  'ethereum-0x4691c475be804fa85f91c2d6d0adf03114de3093',
  'ethereum-0x8aeb9453ef22cb38abc7a3af9c208f65c1bfe31e',
  'ethereum-0x5086bf358635b81d8c47c66d1c8b9e567db70c72'
);
