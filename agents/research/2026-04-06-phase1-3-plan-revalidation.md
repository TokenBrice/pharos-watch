# Phase 1-3 Plan Revalidation Against Current Repo

Date: 2026-04-06  
Validated against `main` at `ee69994498ff8da6b3cdd7ff939550f5a492d9e2`

## Outcome

The phase1-3 execution plan remains broadly valid against current `main`.

No slice became obsolete. The main changes since the original audit are:

1. status-related code moved enough that `B1` should be narrower
2. hotspot governance files moved enough that `A1` should avoid large baseline conflicts
3. pricing-path characterization for `C3` now must include recent wrapper/NAV cases from `main`
4. `C6` candidate enrollment must reflect the current large-file set, not only the older audit snapshot

## Current Validation Summary

### Still active exactly as planned

- `A2` invalid-key limiter bug still exists in `worker/src/handlers/http/gates.ts:94-149`
  - invalid or rejected public API key requests still return `401` before `checkPublicApiRateLimit()` runs
- `A3` DEWS mint/burn baseline bug still exists
  - `worker/src/cron/compute-dews.ts` still builds `mintBurnMap` only from the 24h map
  - `worker/src/lib/dews.ts` still treats missing 24h values as unavailable flow data
- `A4` DEX sentinel + audit-log parsing issues still exist
  - `worker/src/cron/dex-liquidity/orchestrator-metadata.ts` still uses `{ cnt: 9999 }`
  - `worker/src/api/api-key-audit-log.ts` still does raw `JSON.parse(row.detail_json)`
- `A5` admin access cleanup is still valid
  - `src/lib/admin-access.ts` still exposes only `"ops-proxy"`
- `B2`, `C1`, `C2`, `C7` cycle-enforcement stream is still required
  - `scripts/check-shared-cycles.mjs` still checks only `shared/`
  - `madge` still reports 4 cycles under `worker/src`
- `B4`, `B6`, `C4`, `C5` hotspot decompositions are still justified
  - `worker/src/lib/api-keys.ts` is 840 lines
  - `worker/src/cron/sync-yield-data.ts` is 703 lines
  - `worker/src/cron/yield-sync/resolve.ts` is 791 lines
  - `worker/src/cron/compute-dews.ts` is 789 lines

### Still active but should be re-scoped slightly

- `A1` is still needed, but recent hotspot-baseline churn makes it safer to land docs/env/ignore fixes first
  - `README.md:114` still says `NEXT_PUBLIC_API_BASE_URL`
  - `docs/testing.md:203` still points to `agents/plans/2026-03-29-hotspot-decomposition-backlog.md`, but the actual file is under `agents/plans/historical/`
  - `.gitignore` still ignores only root `/.next/`; `worker/.next/` is visible in `git status`
  - `.env.example` still misses live worker bindings including `API_KEY_HASH_PEPPER`, `API_KEY_HASH_PEPPER_PREVIOUS`, `PUBLIC_API_AUTH_MODE`, `SITE_API_SHARED_SECRET_PREVIOUS`, `TELEGRAM_WEBHOOK_SECRET_PREVIOUS`, `CLOUDFLARE_D1_STATUS_API_TOKEN`, and `CLOUDFLARE_D1_DATABASE_ID`
- `B1` is still needed, but should stay focused
  - recent status degradation work already changed `shared/types/status.ts` and several admin/status surfaces
  - duplicated metadata coercion remains in `src/components/status/cron-metadata-summary.ts` and `src/components/status/telegram-bot-stats.tsx`
  - the slice should target shared metadata normalization, not reopen the broader status-state refactor

### Still active and now more important

- `B7` governance checks
  - current HEAD still contains the exact docs/env drift that this slice is meant to codify as checks
- `C3` price enrichment provider split
  - recent `main` commits changed pricing behavior around USDAI/PYUSD wrapper modeling and NAV-wrapper peg inheritance
  - the slice now needs stronger characterization coverage than originally implied
- `C6` hotspot enrollment automation
  - `scripts/lib/hotspot-ratchet.mjs` still uses a fixed `TARGET_FILES` list
  - current large omitted files include:
    - `worker/src/lib/api-keys.ts`
    - `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts`
    - `worker/src/cron/yield-sync/resolve.ts`
    - `worker/src/cron/compute-dews.ts`
    - `src/app/stability-index/client.tsx`
    - `src/components/stablecoin-detail/hero-card.tsx`
    - `worker/src/cron/yield-sync/sources-optional-protocols.ts`

## Concrete Plan Adjustments Applied

These changes were made to the execution artifacts after revalidation:

1. `A1` now explicitly notes that stale hotspot cleanup may be deferred into `B7`/`C6` if the baseline changes again before merge
2. `B1` now explicitly narrows to shared metadata normalization after the recent status refactor work
3. `C3` now explicitly requires characterization of the new wrapper/NAV pricing cases
4. `C6` now explicitly references the current omitted large-file set in HEAD
5. Added characterization ticket `CHAR-C3-01` for the provider-family split

## Commands Run For Revalidation

- `git log --oneline --decorate -n 12`
- `git log --stat --oneline -n 6`
- `git rev-parse HEAD`
- `npx --yes madge --circular --extensions ts,tsx --ts-config tsconfig.json worker/src`
- targeted `rg`, `sed`, and small Node checks for env drift, hotspot omissions, file sizes, and path validity

## Final Recommendation

Proceed with the current plan and control board, using the updated artifacts as the source of truth.

The most important execution discipline changes are:

1. treat tranche gates as merge gates, not branch-creation gates
2. land `A1` docs/env/ignore fixes before trying to mutate the hotspot baseline again
3. require `CHAR-C3-01` before `C3`
4. treat `C6` as current-HEAD enrollment work, not a replay of the older audit list
