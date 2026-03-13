# Documentation Audit Report — 2026-03-13

Scope:

- Audited every file under `docs/` plus `README.md` for cross-consistency.
- Used direct source review for the page-shell, ops/status, deployment, scripts, and current-runtime surfaces.
- Used automated/reference checks for file-path existence, route coverage, methodology-version alignment, cron/config constants, and headline inventory counts.
- Verification commands run after edits: `npm run check:worker-boundary`, `npm run lint`, `npm test`, `npm run build`.

Notes:

- I am not inventing per-sentence claim counts. The table below records verification basis and issue counts instead.
- `docs/documentation-map-2026-03-05.tsv` is a historical artifact, not a canonical contract doc; I only verified the repository still contains it and that `docs/README.md` labels it as non-canonical.

## 1. Per-Document Verification Report

| Document | Status | Verification Basis | Issues Found | Fixed? |
|----------|--------|--------------------|--------------|--------|
| `docs/README.md` | Verified | Cross-checked index links against current docs set and topic coverage | 0 | n/a |
| `docs/about-page.md` | Verified | Checked section contract and source references against `src/app/about/page.tsx` | 0 | n/a |
| `docs/api-reference.md` | Verified | Cross-checked endpoint inventory against `shared/lib/api-endpoints.ts`, `worker/src/route-registry.ts`, `worker/src/router.ts`, and current admin-access flow | 0 | n/a |
| `docs/architecture.md` | Inaccurate | Checked curated tree and route inventory against repo structure and live route files | 2 | Yes |
| `docs/blacklist-tracker-timeline.md` | Verified | Checked current-version alignment against `shared/lib/blacklist-tracker-version.ts` | 0 | n/a |
| `docs/blacklist-tracker.md` | Verified | Checked file references, API path, and methodology-version linkage against current worker/frontend surfaces | 0 | n/a |
| `docs/bluechip-ratings.md` | Verified | Checked slug-count and sync/file references against `worker/src/lib/bluechip-slugs.ts`, `worker/src/cron/sync-bluechip.ts`, and frontend consumers | 0 | n/a |
| `docs/cemetery-and-compare.md` | Verified | Checked route/file references and dead-coin dataset source against `shared/lib/dead-stablecoins.ts` and current compare route files | 0 | n/a |
| `docs/classification.md` | Verified | Checked labels/source-of-truth claims against `shared/lib/classification.ts`, `shared/lib/stablecoins.ts`, and `shared/lib/peg-rates.ts` | 0 | n/a |
| `docs/coverage-page.md` | Verified | Checked route files and coverage-model references against `src/app/coverage/*` and `src/lib/coverage.ts` | 0 | n/a |
| `docs/data-flow-map.md` | Verified | Checked cron/API/hook map references against current file layout and route registry | 0 | n/a |
| `docs/data-pipeline.md` | Verified | Checked data-pipeline guardrail references against current cron/lib files and API behavior | 0 | n/a |
| `docs/depeg-detection.md` | Verified | Checked API, migrations, and methodology-version linkage against current worker/shared files | 0 | n/a |
| `docs/depeg-dews-timeline.md` | Verified | Checked current-version alignment against `shared/lib/depeg-dews-version.ts` | 0 | n/a |
| `docs/dependency-map.md` | Verified | Checked route/file references against current dependency-map page/component sources | 0 | n/a |
| `docs/deployment-process.md` | Verified | Checked CI sequence, smoke stages, and operator-origin references against `.github/workflows/deploy-cloudflare.yml` and package scripts | 0 | n/a |
| `docs/design-context.md` | Verified | Cross-checked against current repo-level design guidance and existing UI direction docs | 0 | n/a |
| `docs/design-language.md` | Verified | Spot-checked referenced components/patterns against current UI files and token system | 0 | n/a |
| `docs/design-tokens.md` | Verified | Checked token-layer/source file references against `src/styles/tokens/*.css` and JS token maps | 0 | n/a |
| `docs/dews.md` | Verified | Checked API path/component/source references and timeline/version linkage against current worker/shared/frontend files | 0 | n/a |
| `docs/dex-liquidity.md` | Verified | Checked version linkage and cron/discovery file references against current liquidity/discovery files | 0 | n/a |
| `docs/digest-pipeline.md` | Verified | Checked pipeline files, migrations, and frontend/archive references against current digest sources | 0 | n/a |
| `docs/documentation-map-2026-03-05.tsv` | Verified (artifact) | Verified presence and non-canonical status only | 0 | n/a |
| `docs/feedback-pipeline.md` | Verified | Checked feedback modal/button, endpoint, migration, and file references against current code | 0 | n/a |
| `docs/homepage.md` | Verified | Checked route shape, section order, callout behavior, and hook usage against `src/app/page.tsx`, `src/components/homepage-client.tsx`, `src/components/site-header.tsx`, `src/components/kpi-bar.tsx`, and homepage hooks | 0 | n/a |
| `docs/liquidity-score-timeline.md` | Verified | Checked current-version alignment against `shared/lib/liquidity-score-version.ts` | 0 | n/a |
| `docs/live-reserves.md` | Verified | Checked API path/file references and freshness-constant source against current worker/frontend files | 0 | n/a |
| `docs/methodology-page.md` | Verified | Checked route/source mapping files and methodology version-file references against current app/shared/worker files | 0 | n/a |
| `docs/mint-burn-flows-timeline.md` | Verified | Checked current-version alignment against `shared/lib/mint-burn-flow-version.ts` | 0 | n/a |
| `docs/mint-burn-flows.md` | Verified | Checked current methodology version and source file references against current shared/worker/frontend files | 0 | n/a |
| `docs/operator-origin-access.md` | Stale / Inaccurate | Checked current ops host split, Pages Functions proxy, status-host gating, and env usage against current code | 4 | Yes |
| `docs/redemption-backstops.md` | Verified | Checked configured-asset count and file references against `shared/lib/redemption-backstops.ts` and current worker/frontend files | 0 | n/a |
| `docs/report-cards-timeline.md` | Verified | Checked current-version alignment against `shared/lib/safety-score-version.ts` and changelog metadata | 0 | n/a |
| `docs/report-cards.md` | Verified | Checked current methodology version against `shared/lib/safety-score-version.ts` and scoring source file references against `shared/lib/report-cards.ts` | 0 | n/a |
| `docs/scripts.md` | Incomplete / Inaccurate | Checked package scripts, deploy workflow, and script implementations against repo root `scripts/` | 2 | Yes |
| `docs/shadow-stablecoins.md` | Verified | Checked tracked shadow count and boundary files against shared/worker sources | 0 | n/a |
| `docs/stability-index-timeline.md` | Verified | Checked current-version alignment against `shared/lib/stability-index-version.ts` | 0 | n/a |
| `docs/stability-index.md` | Verified | Checked methodology-version linkage and file references against current PSI sources | 0 | n/a |
| `docs/stablecoin-detail-page.md` | Verified | Checked route shape, section composition, fallback behavior sources, and detail-view-model references against current detail page files | 0 | n/a |
| `docs/start-page.md` | Verified | Checked route shape, content registry, callout-retirement handshake, and section order against `src/app/start/page.tsx`, `src/components/start-here-page.tsx`, `src/components/start-here-visit-marker.tsx`, and `src/lib/start-here-content.ts` | 0 | n/a |
| `docs/status-dashboard.md` | Verified | Checked ops-host gating, same-origin proxy flow, hooks, and backend contract references against current status frontend/functions/worker files | 0 | n/a |
| `docs/supply-snapshot.md` | Verified | Checked migrations, API paths, and helper-source references against current supply snapshot sources | 0 | n/a |
| `docs/telegram-alerts.md` | Verified | Checked migrations and worker webhook/dispatch file references against current Telegram files | 0 | n/a |
| `docs/testing.md` | Verified | Checked command list and CI workflow references against package scripts and boundary script | 0 | n/a |
| `docs/worker-and-api-limits.md` | Verified | Spot-checked current upstream/worker-limit references against current cron/lib call sites and deployment config | 0 | n/a |
| `docs/worker-infrastructure.md` | Verified | Checked cron-slot counts, route declarations, env surface, and admin access notes against `worker/wrangler.toml`, `shared/lib/cron-jobs.ts`, `worker/src/lib/cron-schedule.ts`, and auth/route files | 0 | n/a |
| `docs/yield-intelligence-timeline.md` | Verified | Checked current-version alignment against `shared/lib/yield-methodology-version.ts` | 0 | n/a |
| `docs/yield-intelligence.md` | Verified | Checked current methodology-version linkage, migrations, and file references against current yield sources | 0 | n/a |

### `architecture.md`

**Status:** 2 inaccurate

| # | Line/Section | Type | Doc Said | Code Says | Source File | Fixed? |
|---|--------------|------|----------|-----------|-------------|--------|
| 1 | `File Tree Guide` | Inaccurate | `functions/` appeared as if it lived under the `src/` subtree | `functions/` is a repo-root sibling used by Cloudflare Pages Functions | `functions/status/[[path]].ts:1-33`, `functions/api/admin/[[path]].ts:1-163` | Yes |
| 2 | `File Tree Guide` intro | Incomplete | Exhaustive inventory command omitted `functions` | Current repo inventory must include `functions` | `functions/status/[[path]].ts:1-33`, `functions/api/admin/[[path]].ts:1-163` | Yes |

**Changes applied**

- Moved the `functions/` block out of the `src/` subtree and documented it as a repo-root surface.
- Updated the inventory command to `rg --files src shared worker scripts data functions`.

### `operator-origin-access.md`

**Status:** 4 stale / inaccurate

| # | Line/Section | Type | Doc Said | Code Says | Source File | Fixed? |
|---|--------------|------|----------|-----------|-------------|--------|
| 1 | `Purpose` / phase framing | Stale | Pages Functions proxy and `/status` cutover were described as future “Phase 2” work | Proxy and host-aware `/status` behavior are already live in the current repo | `src/app/status/client.tsx:55-116`, `functions/status/[[path]].ts:19-32`, `functions/api/admin/[[path]].ts:121-163` | Yes |
| 2 | `Future-facing env placeholders` | Inaccurate | `OPS_UI_ORIGIN` / `OPS_API_ORIGIN` were described as future placeholders | Those bindings are actively consumed by the current Pages Functions host gate / proxy | `functions/status/[[path]].ts:15-21`, `functions/api/admin/[[path]].ts:54-60`, `121-146` | Yes |
| 3 | `Pages project bindings needed for Phase 2` | Inaccurate | `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_OPS_UI_AUD` were presented as required runtime config for the current proxy | The current proxy only requires `OPS_API_SERVICE_TOKEN_ID` and `OPS_API_SERVICE_TOKEN_SECRET`; the `CF_ACCESS_*` values remain reserved/unused there | `functions/api/admin/[[path]].ts:22-29`, `81-99` | Yes |
| 4 | `Cloudflare Account Setup` / `Rollback` | Stale | Multiple sections still referred to Phase 1 / later phases | Current docs now describe the live split-host setup without future-phase framing | `src/app/status/client.tsx:82-114`, `functions/api/admin/[[path]].ts:121-163`, `worker/wrangler.toml:14-17,51-53` | Yes |

**Changes applied**

- Rewrote the opening sections to describe the current operator-origin split rather than a future rollout.
- Split active origin bindings from reserved `CF_ACCESS_*` placeholders so the doc matches current runtime behavior.
- Updated the Pages Functions binding guidance to reflect the actual required service-token pair.
- Removed stale Phase 1 / Phase 2 / “later phases” language from setup and rollback guidance.

### `scripts.md`

**Status:** 2 inaccurate / incomplete

| # | Line/Section | Type | Doc Said | Code Says | Source File | Fixed? |
|---|--------------|------|----------|-----------|-------------|--------|
| 1 | `Script Inventory` / `CI-Critical Scripts` | Incomplete | Omitted `scripts/smoke-ops.mjs` | `test:smoke-ops` exists in package scripts and runs in CI as its own post-deploy job | `package.json:25-30`, `.github/workflows/deploy-cloudflare.yml:109-122`, `scripts/smoke-ops.mjs:1-92` | Yes |
| 2 | `check-worker-import-boundary.mjs` row | Inaccurate | Described only a one-way `worker/src/**` -> `src/lib/*` restriction | The script forbids any `worker/src/**` import of `src/**` and also forbids `src` / `shared` / `scripts` from importing `worker/src/**` | `scripts/check-worker-import-boundary.mjs:4-9`, `70-88` | Yes |

**Changes applied**

- Added `smoke-ops.mjs` to the inventory, CI-critical list, and operational notes, with its current inputs and checks.
- Corrected the worker-boundary script description to match the actual bidirectional rules.

## 2. Coverage Gap Analysis

### Undocumented Systems

| System/Feature | Complexity | Recommended Action |
|---------------|------------|--------------------|
| Repo-root Pages Functions (`functions/status/[[path]].ts`, `functions/api/admin/[[path]].ts`) | Medium | No new doc needed after this pass; coverage now lives in `docs/architecture.md`, `docs/status-dashboard.md`, `docs/operator-origin-access.md`, and `README.md` |
| Private ops smoke stage (`scripts/smoke-ops.mjs`) | Low | No new doc needed after this pass; coverage now lives in `docs/scripts.md`, `docs/testing.md`, `docs/deployment-process.md`, and `README.md` |

### New Documents Created

- None. Existing docs covered the live systems once the stale/incomplete sections above were corrected.

## 3. Cross-Consistency Report

### Cross-Document Conflicts

| Doc A | Doc B / Surface | Conflict | Resolution |
|-------|------------------|----------|------------|
| `docs/operator-origin-access.md` | `docs/status-dashboard.md`, `docs/api-reference.md`, live code | Operator-origin doc still described the proxy/status cutover as future work while status/api docs and code treated it as live | Rewrote operator-origin doc to describe the current split-host state |
| `docs/scripts.md` | `docs/testing.md`, `docs/deployment-process.md`, `package.json`, workflow | Scripts doc omitted `smoke-ops`, while testing/deployment/workflow/package all referenced it | Added `smoke-ops` inventory, CI note, and operational details |
| `docs/architecture.md` | repo tree, `README.md` | Architecture tree implied `functions/` lived under `src/` and omitted it from the inventory command | Moved `functions/` to repo root in the tree and updated inventory command; added root `functions/` block to `README.md` too |
| `README.md` | workflow / deployment docs | README deployment flow stopped at public UI smoke and omitted the private ops smoke stage and its variables/secrets | Added `smoke-ops` stage and required env/secrets to `README.md` |

### Terminology Standardization

- Replaced stale Phase 1 / Phase 2 framing in the operator-origin runbook with current-state language.
- Standardized the operator path as “same-origin `/api/admin/*` Pages Functions proxy” instead of future-tense rollout wording.
- Standardized the import-boundary description around the real roots: `src`, `shared`, `scripts`, and `worker/src`.

### README / Agent Guidance Check

- `README.md` now matches the live repo structure on the new root `functions/` surface.
- `README.md`, `docs/deployment-process.md`, `docs/testing.md`, and `docs/scripts.md` now agree on the existence of the `smoke-ops` deployment gate.
- The repo-level gotchas about classification source-of-truth, supply helpers, hook polling policy, and worker/shared boundary still match the current code (`shared/lib/classification.ts`, `shared/lib/supply.ts`, `src/hooks/use-api-query.ts`, `tsconfig.json`).

## 4. Summary Dashboard

Audited surfaces:

- `docs/`: 46 Markdown docs + 1 TSV artifact
- Cross-consistency check: `README.md`

Verification results:

| Surface | Files Audited | Files Changed | Issues Found | Issues Fixed |
|---------|---------------|---------------|--------------|--------------|
| `docs/` | 47 | 3 | 8 | 8 |
| `README.md` cross-consistency | 1 | 1 | 2 | 2 |
| Total | 48 | 4 | 10 | 10 |

Command verification:

- `npm run check:worker-boundary` — passed
- `npm run lint` — passed
- `npm test` — passed (`188` files, `1660` tests)
- `npm run build` — passed
