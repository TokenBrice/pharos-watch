# 2026-03-22 Documentation Health Report

Audit manifest: `agents/audits/2026-03-22-documentation-audit-manifest.md`

## Scope Summary

- Total audited items: `77`
  - canonical `/docs/` files: `54`
  - repo-adjacent docs: `3`
  - live `/methodology` and `/coverage` route source files: `20`
- Files changed in this pass: `35`
  - documentation/runtime docs updated: `33`
  - audit artifacts added: `2`

## Issues Found

Grouped discrepancy counts:

- Critical: `0`
- Major: `21`
- Minor: `18`

Major issues resolved:

1. CI/deploy documentation drifted from the live workflows. `README.md`, `docs/deployment-process.md`, `docs/testing.md`, and `docs/scripts.md` now match the current validate gate, Pages release path, worker-only UI smoke path, and workflow wiring.
2. Frontend runtime/env behavior was under-documented. `README.md`, `.env.example`, and `docs/architecture.md` now document `NEXT_PUBLIC_API_BASE`, `NEXT_PUBLIC_GA_ID`, production/preview host API resolution, and ownership of sitemap/robots/metadata helpers.
3. Privacy/telemetry docs overstated always-on GA behavior. `docs/privacy-page.md` and `src/app/privacy/page.tsx` now match the runtime gating in `src/app/layout.tsx` and the typed event catalog in `src/lib/analytics.ts`.
4. `GET /api/digest-snapshot` docs had the wrong cache profile and incomplete date format coverage. `docs/api-reference.md`, `docs/architecture.md`, and `docs/worker-infrastructure.md` now reflect the `archive` cache header and `YYYY-MM-DD-weekly` support.
5. Repo-adjacent operational references lagged the live schema/runtime. `README.md` now includes the published DEX challenger tables, and `worker/migrations/MANIFEST.md` now includes `0070_dex_price_challengers.sql`.
6. Route-contract coverage was incomplete. `docs/README.md`, `docs/about-page.md`, `docs/cemetery-and-compare.md`, `docs/chains-page.md`, and `docs/methodology-page.md` now cover the missing route-shell, static-generation, SEO, and update-rule contracts.
7. Live reserve docs were stale. `docs/live-reserves.md` now documents implemented fallback input retries, active-coin scope, and the real run-level status thresholds from `sync-live-reserves.ts`.
8. Mint/burn and digest docs overstated flight-to-quality behavior. `docs/mint-burn-flows.md` now distinguishes the public API's report-card-cache classification from the digest collector's current `SAFE_HAVEN_IDS` logic, and `docs/digest-pipeline.md` documents that same split plus the live recent-digests window.
9. Telegram webhook docs were internally inconsistent. `docs/telegram-alerts.md` and `docs/worker-infrastructure.md` now describe the real secret handling: header-first validation with legacy query fallback.
10. Feedback docs missed the mobile entry point and hardcoded the submission host. `docs/feedback-pipeline.md` now reflects `MobileUtilityDock` and the runtime `buildApiUrl("/api/feedback")` contract.
11. Depeg confirmation methodology drifted. `docs/depeg-detection.md` now documents pool challengers, the real pending/promotion lifecycle for low-confidence and extreme moves, and freshness headers based on latest successful `sync-stablecoins`.
12. DEWS docs were stale. `docs/dews.md` and `docs/api-reference.md` now reflect active-only API scope and the dedicated Telegram outbound alert path.
13. Timeline/reference docs lagged the version sources. `docs/pricing-pipeline-timeline.md` gained `v2.10`, and `docs/report-cards-timeline.md` now covers `v5.9` through `v6.0`.

Minor issues resolved:

- `docs/worker-infrastructure.md`, `docs/blacklist-tracker.md`, and `docs/mint-burn-flows.md` dropped vendor-plan/tier claims that are not repo-verifiable.
- `shared/data/stablecoins/PROVENANCE_NOTES.md` now explicitly marks its `.ts` filenames and line anchors as archival, not current-source references.
- `docs/documentation-map-2026-03-05.tsv` now explicitly labels itself as a high-level, non-canonical map and points to the current canonical entry docs.
- `docs/bluechip-ratings.md` now documents `_meta` freshness injection from `createCacheHandler()`.
- `docs/shadow-stablecoins.md` now reflects `ACTIVE_IDS` / `ACTIVE_STABLECOINS` as the public table inclusion boundary.
- `docs/classification.md` now reflects `ACTIVE_STABLECOINS` as the supplemental-asset source set.
- `docs/README.md` now includes the missing route-first coverage entries for `/`, `/about/`, `/coverage/`, `/methodology/`, `/portfolio/`, `/privacy/`, `/start/`, `/status/`, `/cemetery/`, and `/compare/`.
- `worker/migrations/MANIFEST.md` now avoids an account-plan-specific D1 Time Travel retention claim.

## Coverage Gaps Filled

- Added the missing `v2.10` Pricing Pipeline timeline entry.
- Added the missing `v5.9` Report Cards timeline entry and corrected the header to cover `v6.0`.
- Added the missing `0070_dex_price_challengers.sql` manifest row.
- Added `dex_price_challengers` and `dex_price_challenger_snapshots` to the README D1 inventory.
- Added the missing route-shell/SEO contracts for `/about/`, `/compare/`, and `/compare/[slug]/`.
- Added the missing public-route index coverage for the route-contract docs already present in `/docs/`.
- Added the missing proxy/header contract details for the Pages admin proxy.
- Added the missing frontend runtime/env and analytics contract notes.

## Structural Changes

- Created an explicit audit manifest and checked off every in-scope item.
- Kept the existing documentation hierarchy intact; no merge/split reorganization was needed after verification.
- Tightened archival labeling on non-canonical reference artifacts instead of leaving them to read like live exhaustive inventories.
- Normalized docs that had mixed repo-verified behavior with vendor-plan assumptions so they now match the repo's documentation policy in `docs/worker-and-api-limits.md`.

## Verification Performed

Mechanical/documentation checks:

- `npm run check:doc-counts`
- `npm run check:doc-sync`
- `npm run check:migrations`
- internal markdown-link existence pass
- repo-path existence scan for doc-referenced concrete file paths
- manual comparison against `.github/workflows/*.yml`, `shared/lib/*-version.ts`, `worker/migrations/*.sql`, route source files, and the relevant worker/frontend modules

Repo-required validation:

- `npm run lint`
- `npm test`
- `cd worker && npx tsc --noEmit`
- `npm run build`

All commands passed.

## Recommendations

The current automated doc guards are useful but still leave some drift vectors open. The highest-value follow-up checks would be:

1. methodology timeline docs containing the current version entry from each `shared/lib/*-version.ts` source
2. route-contract docs staying aligned with route metadata/indexability/static-param ownership
3. `worker/migrations/MANIFEST.md` staying complete relative to `worker/migrations/*.sql`
4. API docs asserting active-vs-tracked scope from the same shared registry constants the handlers use
