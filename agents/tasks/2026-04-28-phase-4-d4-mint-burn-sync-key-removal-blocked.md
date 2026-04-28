# Phase 4 D4 Blocked: Mint/Burn Legacy Sync-Key Removal

Date: 2026-04-28
Plan: `agents/plans/2026-04-28-audit-remediation-implementation-plan.md`
Finding: R001 / C002

D4 was intentionally deferred. Required deployed-state verification could not be completed from the local non-interactive shell: `npx wrangler d1 migrations list stablecoin-db --remote` failed with `Failed to fetch auth token: 400 Bad Request`. `printenv | rg '^CLOUDFLARE|^WRANGLER'` found no Cloudflare/Wrangler token, so `CLOUDFLARE_API_TOKEN` is required before running remote D1 verification.

No source changes were made for D4. Keep `worker/src/lib/mint-burn-pipeline/sync-state.ts` legacy sync-key fallback in place until production and preview D1 verification confirms migration `0093_cleanup_legacy_mint_burn_sync_keys.sql` is applied and `SELECT COUNT(*) AS legacy_count FROM mint_burn_sync_state WHERE config_key LIKE '%:%';` returns 0 for both environments.

Next owner: rerun the D4 wrangler migration and legacy-row checks for production and preview with a valid token, record exact results in the PR, then remove `legacyMintBurnConfigKey()`, the dual-read/max fallback, and legacy-only tests.
