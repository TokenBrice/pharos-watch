# Phase 4 D4 Resolved: Mint/Burn Legacy Sync-Key Removal

Date: 2026-04-28
Plan: `agents/plans/2026-04-28-audit-remediation-implementation-plan.md`
Finding: R001 / C002

D4 was originally deferred because the local non-interactive shell could not fetch a Wrangler auth token. After interactive login was restored, the remote D1 deployed-state checks succeeded and the compatibility fallback was removed.

## Wrangler Verification

Commands and results:

- `cd worker && npx wrangler whoami`
  - Authenticated as `me@tokenbrice.com` for account `Me@tokenbrice.com's Account` (`a8e445f07ec0022391b6b090c6ce01c2`).
- `cd worker && npx wrangler d1 list`
  - The account exposes one configured D1 database for this repo: `stablecoin-db` (`8f3f54ca-e035-4cdf-9ec5-a4fbbe48b27a`, version `production`).
  - No separate preview D1 database was present in Wrangler or `worker/wrangler.toml`; preview Worker environments use the same `stablecoin-db` binding unless a separate database is added later.
- `cd worker && npx wrangler d1 migrations list stablecoin-db --remote`
  - Result: `No migrations to apply!`
- `cd worker && npx wrangler d1 execute stablecoin-db --remote --json --command "SELECT COUNT(*) AS legacy_count FROM mint_burn_sync_state WHERE config_key LIKE '%:%';"`
  - Result: `legacy_count = 0`, `changed_db = false`, `rows_read = 143`, `rows_written = 0`.
- `cd worker && npx wrangler d1 execute stablecoin-db --remote --json --command "SELECT * FROM d1_migrations ORDER BY id DESC LIMIT 20;"`
  - Result included `0093_cleanup_legacy_mint_burn_sync_keys.sql`, id `102`, applied at `2026-04-08 15:55:51`.
- `cd worker && npx wrangler d1 execute stablecoin-db --remote --json --command "SELECT COUNT(*) AS migration_0093_count FROM d1_migrations WHERE name = '0093_cleanup_legacy_mint_burn_sync_keys.sql' OR name LIKE '%0093%mint%burn%sync%keys%';"`
  - Result: `migration_0093_count = 1`.

## Source Resolution

- Removed `legacyMintBurnConfigKey()` from `worker/src/lib/mint-burn-pipeline/sync-state.ts`.
- Removed dual-read/max fallback from `readMintBurnSyncStateBatch()`.
- Kept canonical sync-state keys in the form `chainId-contractAddress`.
- Kept historical migration `worker/migrations/0093_cleanup_legacy_mint_burn_sync_keys.sql`.
- Removed legacy-only tests and rewrote sync resume coverage around canonical keys.
