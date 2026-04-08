-- rollout-safety: backward-compatible

-- Remove legacy sync state rows in stablecoinId:chainId:address format.
-- Canonical keys use chainId-contractAddress format (no colon separators).
DELETE FROM mint_burn_sync_state WHERE config_key LIKE '%:%';
