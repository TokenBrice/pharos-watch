# Documentation Health Report — 2026-03-19

## Scope

- Audited manifest items: 61
- Core entry-point docs: 2
- `/docs/` corpus items: 53
- Auxiliary project docs outside `/docs`: 3
- Runtime documentation surfaces audited against live code: 3

Manifest: `agents/audits/2026-03-19-documentation-audit-manifest.md`

## Findings Summary

- Critical: 0
- Major: 12
- Minor: 4

## Major Issues Remediated

1. `docs/testing.md`
   - The documented validate gate had drifted from `.github/workflows/validate-ci.yml`.
   - Restored `check:cron-sync`, `check:doc-counts`, and `check:duplicate-exports`.
   - Corrected the ops smoke-test/auth wording and documented the separate CodeQL workflow.

2. `docs/deployment-process.md`
   - The deploy workflow description omitted checks that now run in the shared validate gate.
   - Added the missing validate steps so the deploy narrative matches CI.

3. `docs/api-reference.md` and `docs/worker-infrastructure.md`
   - Admin-auth behavior was stale.
   - Updated both docs to match the current Cloudflare Access JWT flow in `worker/src/lib/auth.ts` and `worker/src/lib/jwt-verify.ts`.

4. `docs/worker-infrastructure.md` and `worker/migrations/MANIFEST.md`
   - Worker env/migration references had drifted from live code and checked-in migrations.
   - Corrected Access env usage, migration count wording, the rollback-runbook link, and the missing `0069_chain_supply_history.sql` manifest row.

5. `README.md`, `docs/architecture.md`, and `docs/data-flow-map.md`
   - The public `/status/` surface and the Access-gated `/admin/` surface were described inconsistently.
   - Updated the corpus to reflect the live split: public read-only `/status/`, private `/admin/`, admin-only `/api/status*`.

6. `docs/coverage-page.md`, `docs/homepage.md`, `docs/start-page.md`, and `docs/shadow-stablecoins.md`
   - Several route docs still described public counts and page universes in terms of `TRACKED_STABLECOINS` where the live UI uses `ACTIVE_STABLECOINS`.
   - Updated those contracts to match the current implementation.

7. `docs/homepage.md`
   - The homepage URL/filter contract and section-order description were stale.
   - Added the live `grade` query param and the `UpcomingStablecoinsSection` insertion point.

8. `docs/stablecoin-detail-page.md`
   - The detail-page route contract no longer matched the live section order.
   - Corrected the liquidity-before-flows order, documented the extra `flow-history` section, and added the pre-launch `PreLaunchDetail` branch.

9. `docs/about-page.md`
   - The documented source roster lagged behind `DATA_SOURCE_GROUPS` in `src/app/about/page.tsx`.
   - Updated the reserve-transparency and DEX-source notes to include the live provider set.

10. `docs/mint-burn-flows.md`
   - Mint/burn contract-coverage counts were stale versus `worker/src/lib/mint-burn-contracts.ts`.
   - Corrected the documented scope to `84` configs across `83` stablecoin IDs (`7` critical, `77` extended).

11. `docs/report-cards.md`
   - Stress-test working-set sizing had drifted from the live tracked + cemetery sets.
   - Corrected the snapshot size to `248` cards (`166` tracked + `82` cemetery).

12. `docs/documentation-map-2026-03-05.tsv` and `docs/superpowers/*`
   - The legacy map contained dead references, and `/docs/` still held non-canonical planning/spec artifacts.
   - Removed the dead map rows and archived the `docs/superpowers` draft plan/spec into `/agents/` so `/docs/` stays a verified corpus.

## Minor Issues Remediated

1. `docs/coverage-page.md`
   - Updated the route-shell wording to the current `createClientFeaturePage(...)` wrapper and documented the page FAQ JSON-LD.

2. `docs/chains-page.md`
   - Added the leaderboard FAQ JSON-LD note emitted by `src/app/chains/page.tsx`.

3. `docs/start-page.md`
   - Added the route metadata contract (`buildPageMetadata`, canonical path, and OG image).

4. `docs/architecture.md`
   - Corrected route/file comments that still implied the public `/status/` surface was Access-gated and that `worker/src/lib/auth.ts` used the old admin-key model.

## Coverage Gaps Filled

- Added the missing CodeQL workflow coverage to the testing/CI docs.
- Added missing route-shell documentation for:
  - `/coverage/` FAQ JSON-LD
  - `/chains/` FAQ JSON-LD
  - `/start/` metadata
- Removed non-canonical planning/spec files from `/docs/` and archived them under `/agents/`.

## Structural Changes

- Added `agents/audits/2026-03-19-documentation-audit-manifest.md`
- Added this health report
- Archived:
  - `docs/superpowers/plans/2026-03-18-multi-dex-api-integration.md` -> `agents/plans/historical/2026-03-18-multi-dex-api-integration.md`
  - `docs/superpowers/specs/2026-03-18-multi-dex-api-integration-design.md` -> `agents/specs/2026-03-18-multi-dex-api-integration-design.md`
- Pruned dead entries from `docs/documentation-map-2026-03-05.tsv`

## Verification

Passed:

- `npm run check:doc-counts`
- `npm run check:cron-sync`
- `npm run lint` (`0` errors, existing warnings remain)
- `npm test`
- `npm run build`
- `cd worker && npx tsc --noEmit`

## Remaining Concerns

- The worktree already contains unrelated local changes outside this docs audit, including OG-image work and some pre-existing documentation edits. Those were preserved.
- `npm run lint` still reports pre-existing warnings across scripts, frontend code, shared code, and worker code. The documentation changes in this audit did not introduce lint errors.
