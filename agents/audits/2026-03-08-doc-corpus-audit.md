# Documentation Corpus Audit — 2026-03-08

Scope: markdown documents under `docs/`, plus cross-consistency checks against `README.md`, `AGENTS.md`, and `CLAUDE.md`.

Method: code-first verification against the live repository. I also re-checked the Cloudflare platform-limit rows that had drifted from current vendor docs. Historical timeline docs are called out separately because their commit-by-commit claims are not fully re-verifiable from the live tree alone.

## 1. Per-Document Verification Report

## api-reference.md

**Status:** 1 inaccurate / 2 incomplete / 1 ambiguous

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | `GET /api/stability-index` intro | Inaccurate | PSI described as tracked-coin aggregate | PSI cron filters by `PSI_ELIGIBLE_IDS` (tracked + shadow) | `worker/src/cron/stability-index.ts:26-43`, `shared/lib/psi-eligible.ts:4-7` | Yes |
| 2 | Public endpoint inventory | Incomplete | No `/api/og/*` coverage | Router serves `/api/og/stablecoin/:id`, `/api/og/safety-scores`, `/api/og/depeg`, `/api/og/stability-index` | `worker/src/router.ts:319-321`, `worker/src/api/og.tsx:104-424` | Yes |
| 3 | `/api/status` example counters | Ambiguous | Example numbers could be read as tracked-count constants | `totalStablecoins` is the current raw stablecoins-cache payload length | `worker/src/api/status.ts:642-645` | Yes |

### Changes Applied
- Clarified that PSI uses the PSI-eligible universe, not only the public tracked set.
- Added a dedicated `/api/og/*` section with supported routes, content type, cache behavior, and failure modes.
- Added an explicit note that the `/api/status` example counts are illustrative and come from the current cache payload size.

## architecture.md

**Status:** 2 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | API endpoint table | Incomplete | `/api/og/*` omitted | Router exposes dynamic OG image routes | `worker/src/router.ts:319-321`, `worker/src/api/og.tsx:398-425` | Yes |
| 2 | Worker API file tree | Incomplete | `worker/src/api/og.tsx` omitted | File exists and backs `/api/og/*` | `worker/src/api/og.tsx` | Yes |

### Changes Applied
- Added `GET /api/og/*` to the endpoint table.
- Added `worker/src/api/og.tsx` to the worker API file tree.

## blacklist-tracker-timeline.md

**Status:** Historical / partially unverifiable from live tree

### Verification Notes
- Current changelog route and referenced live modules still exist.
- Historical milestone text was not re-audited against git history in this pass.

### Changes Applied
- None.

## blacklist-tracker.md

**Status:** Verified

### Verification Notes
- Contract/config coverage and sync flow remain aligned with `worker/src/lib/blacklist-contracts.ts` and `worker/src/cron/sync-blacklist.ts`.
- Public API surface still matches `worker/src/api/blacklist.ts`.

### Changes Applied
- None.

## cemetery-and-compare.md

**Status:** Verified

### Verification Notes
- Cemetery data sources still align with `shared/lib/dead-stablecoins.ts`.
- Compare page contracts still align with `src/app/compare/` and related hooks/components.

### Changes Applied
- None.

## classification.md

**Status:** Verified

### Verification Notes
- Classification flags and label/color ownership still live in `shared/lib/classification.ts` and `shared/lib/stablecoins.ts`.

### Changes Applied
- None.

## data-flow-map.md

**Status:** 3 inaccurate / 1 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | PSI row | Inaccurate | PSI described as using depeg/liquidity context | PSI reads stablecoins cache, active depegs, and DEWS stress breadth | `worker/src/cron/stability-index.ts:26-79` | Yes |
| 2 | Yield row | Incomplete | Yield row listed only DefiLlama pools + risk-free rate | Yield sync also uses on-chain `eth_call` sources and CoinGecko price fallback | `worker/src/cron/sync-yield-data.ts:94-163,389-461`, `worker/src/cron/yield-config.ts:278-299` | Yes |
| 3 | `*/15` schedule row | Incomplete | Telegram alert dispatch omitted | Quarter-hourly slot includes `dispatch-telegram-alerts` | `worker/src/handlers/scheduled.ts:169-174` | Yes |
| 4 | `0 8` schedule row | Incomplete | Safety snapshot and daily Telegram pass omitted | Daily slot includes `snapshot-safety-grade-history` and `dispatch-telegram-alerts-daily` | `worker/src/handlers/scheduled.ts:289-299` | Yes |

### Changes Applied
- Corrected the PSI input description.
- Expanded the yield-source summary.
- Aligned both schedule summaries with the actual scheduler.

## data-pipeline.md

**Status:** Verified

### Verification Notes
- Stablecoin sync stages, cache-validation rules, and shared stablecoins-cache loader usage still align with `worker/src/cron/sync-stablecoins.ts` and `worker/src/lib/stablecoins-cache.ts`.

### Changes Applied
- None.

## depeg-detection.md

**Status:** Verified

### Verification Notes
- Two-stage detection/confirmation flow remains aligned with `worker/src/cron/detect-depegs.ts`, `worker/src/cron/confirm-pending-depegs.ts`, and `shared/lib/peg-score.ts`.

### Changes Applied
- None.

## depeg-dews-timeline.md

**Status:** Historical / partially unverifiable from live tree

### Verification Notes
- Current methodology-route references remain valid.
- Historical milestone text was not re-audited against git history in this pass.

### Changes Applied
- None.

## dependency-map.md

**Status:** Verified

### Verification Notes
- Dependency-map selection and rendering rules remain aligned with `src/app/dependency-map/client.tsx` and report-card dependency data.

### Changes Applied
- None.

## deployment-process.md

**Status:** Verified

### Verification Notes
- Deploy workflow references still line up with `.github/workflows/deploy-cloudflare.yml` and the repo scripts it invokes.

### Changes Applied
- None.

## design-language.md

**Status:** 1 stale

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | Header verification stamp | Stale | Re-verified on March 7 and framed as deployed-site baseline | This audit re-verified the current codebase baseline on March 8 | Audit scope | Yes |

### Changes Applied
- Updated the header to describe the codebase-backed UI baseline and refreshed the verification date to March 8, 2026.

## design-tokens.md

**Status:** Verified

### Verification Notes
- Token layering still matches `src/styles/tokens/primitives.css`, `src/styles/tokens/semantic.css`, and the bridge variables in `src/app/globals.css`.

### Changes Applied
- None.

## dews.md

**Status:** Verified

### Verification Notes
- DEWS signal set, tracked/public API boundary, and storage behavior still align with `worker/src/cron/compute-dews.ts` and `worker/src/api/stress-signals.ts`.

### Changes Applied
- None.

## dex-liquidity.md

**Status:** Verified

### Verification Notes
- Pool-source stack, fingerprint dedupe, sentinel-row behavior, and scoring references still align with `worker/src/cron/dex-liquidity/*`.

### Changes Applied
- None.

## digest-pipeline.md

**Status:** Verified

### Verification Notes
- Digest generation/storage/distribution flow and model choice still align with `worker/src/cron/daily-digest.ts`.

### Changes Applied
- None.

## feedback-pipeline.md

**Status:** Verified

### Verification Notes
- Feedback endpoint behavior, env usage, and GitHub routing still align with `worker/src/api/feedback.ts`.

### Changes Applied
- None.

## liquidity-score-timeline.md

**Status:** Historical / partially unverifiable from live tree

### Verification Notes
- Current methodology-route references remain valid.
- Historical milestone text was not re-audited against git history in this pass.

### Changes Applied
- None.

## methodology-page.md

**Status:** Verified

### Verification Notes
- Methodology page source-map references still point at live modules and current changelog routes.

### Changes Applied
- None.

## mint-burn-flows-timeline.md

**Status:** Historical / partially unverifiable from live tree

### Verification Notes
- Current methodology-route references remain valid.
- Historical milestone text was not re-audited against git history in this pass.

### Changes Applied
- None.

## mint-burn-flows.md

**Status:** Verified

### Verification Notes
- Ethereum-only contract coverage, scoring, shared ingestion pipeline, and API contracts still align with `worker/src/lib/mint-burn-contracts.ts`, `worker/src/lib/mint-burn-pipeline/*`, `worker/src/cron/sync-mint-burn.ts`, `worker/src/api/mint-burn-flows.ts`, and `worker/src/api/mint-burn-events.ts`.

### Changes Applied
- None.

## report-cards-timeline.md

**Status:** Historical / partially unverifiable from live tree

### Verification Notes
- Current methodology-route references remain valid.
- Historical milestone text was not re-audited against git history in this pass.

### Changes Applied
- None.

## report-cards.md

**Status:** 1 stale

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | Stress-test recomputation count | Stale | `~229 cards (151 tracked + 78 cemetery)` | Public tracked set is now 156, so recomputation envelope is `~234 cards (156 tracked + 78 cemetery)` | `shared/lib/stablecoins.ts` (counted entries), `shared/lib/dead-stablecoins.ts` (78 cemetery entries) | Yes |

### Changes Applied
- Updated the recomputation-size example to the current tracked/cemetery totals.

## scripts.md

**Status:** Verified

### Verification Notes
- Script inventory still matches the current `scripts/` directory, and the CI/deploy usage notes still line up with package scripts and workflow usage.

### Changes Applied
- None.

## shadow-stablecoins.md

**Status:** New / verified

### Verification Notes
- Added to document the previously undocumented shadow-asset boundary used by PSI, DEWS, depeg backfill, and supply-history backfill.
- Verified against `shared/lib/shadow-stablecoins.ts:3-14`, `shared/lib/psi-eligible.ts:4-7`, `worker/src/cron/snapshot-supply.ts:2,51-62`, `worker/src/cron/stability-index.ts:26-43`, `worker/src/cron/compute-dews.ts`, and `src/components/stablecoin-table-logic.ts`.

### Changes Applied
- New document created.

## stability-index-timeline.md

**Status:** Historical / partially unverifiable from live tree

### Verification Notes
- Current methodology-route references remain valid.
- Historical milestone text was not re-audited against git history in this pass.

### Changes Applied
- None.

## stability-index.md

**Status:** 1 inaccurate / 1 stale

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | Input data table, total market cap | Inaccurate | Total market cap described as tracked-only | PSI sums the stablecoins cache filtered by `PSI_ELIGIBLE_IDS` | `worker/src/cron/stability-index.ts:26-43`, `shared/lib/psi-eligible.ts:4-7` | Yes |
| 2 | Digest integration note | Stale | Referred to a “Sonnet prompt” | Digest job now uses the Anthropic prompt path backed by `claude-opus-4-6` | `worker/src/cron/daily-digest.ts:986,991` | Yes |

### Changes Applied
- Corrected the total-market-cap input description.
- Updated the digest integration wording to remove the stale Sonnet reference.

## status-dashboard.md

**Status:** Verified

### Verification Notes
- Status synthesis, probe history, admin auth, and page wiring still align with `worker/src/api/status.ts`, `worker/src/api/status-history.ts`, and `src/app/status/`.

### Changes Applied
- None.

## supply-snapshot.md

**Status:** 2 inaccurate / 1 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | Intro + pipeline step 4 | Inaccurate | Snapshot described as tracked-only | Snapshot filters by `PSI_ELIGIBLE_STABLECOINS` | `worker/src/cron/snapshot-supply.ts:2,51-62`, `shared/lib/psi-eligible.ts:4-7` | Yes |
| 2 | Current entry count | Inaccurate | `153 entries: 151 tracked + 2 shadow` | Current PSI-eligible set is `158 entries: 156 tracked + 2 shadow` | `shared/lib/stablecoins.ts` (counted entries), `shared/lib/shadow-stablecoins.ts:5-14` | Yes |
| 3 | File index | Incomplete | Omitted PSI/shadow registry modules | Snapshot/backfill boundary depends on `shared/lib/psi-eligible.ts` and `shared/lib/shadow-stablecoins.ts` | `shared/lib/psi-eligible.ts:4-7`, `shared/lib/shadow-stablecoins.ts:5-14` | Yes |

### Changes Applied
- Reframed the snapshot scope as PSI-eligible.
- Updated the current eligibility counts.
- Added the missing shared registry files to the file index.

## telegram-alerts.md

**Status:** Verified

### Verification Notes
- Webhook commands, D1 subscription tables, quarter-hourly dispatch, and daily chained pass still align with `worker/src/api/telegram-webhook.ts`, `worker/src/cron/dispatch-telegram-alerts.ts`, and `worker/src/handlers/scheduled.ts:293-299`.

### Changes Applied
- None.

## testing.md

**Status:** 1 inaccurate

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | Cron test inventory for `snapshot-supply.test.ts` | Inaccurate | “valid insert for tracked assets” | Snapshot supply is keyed off the PSI-eligible registry | `worker/src/cron/snapshot-supply.ts:2,51-62` | Yes |

### Changes Applied
- Updated the test-inventory wording from tracked assets to PSI-eligible assets.

## worker-and-api-limits.md

**Status:** 4 inaccurate

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says / Vendor Says | Source File | Fixed? |
|---|-------------|------|----------|--------------------------|-------------|--------|
| 1 | Cloudflare cron CPU row | Inaccurate | “Up to 15 min” without schedule-dependent default | Current Cloudflare default depends on cron frequency; repo additionally sets `cpu_ms = 5000` | `worker/wrangler.toml:18-37`, Cloudflare docs rechecked 2026-03-08 | Yes |
| 2 | Cloudflare cron-trigger cap row | Inaccurate | Old `5 max` per-worker trigger cap | Repo uses 4 cron expressions; Cloudflare removed the old per-worker cap | `worker/wrangler.toml:31-37`, Cloudflare docs rechecked 2026-03-08 | Yes |
| 3 | Cloudflare subrequest default row | Inaccurate | Default shown as `1,000` | Current Workers Standard default is `10,000` | Cloudflare docs rechecked 2026-03-08 | Yes |
| 4 | Anthropic model/timeout row | Inaccurate | `claude-sonnet-4-6`, 60-second timeout | `claude-opus-4-6`, 120-second timeout | `worker/src/cron/daily-digest.ts:986,991` | Yes |

### Changes Applied
- Updated the Cloudflare runtime-limit rows that had drifted from current platform docs.
- Updated the digest model and timeout to the current code values.

## worker-infrastructure.md

**Status:** 2 inaccurate / 1 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | Cron scheduling intro | Inaccurate | Old per-worker 5-trigger cap guidance | Repo declares 4 cron expressions; old cap no longer applies | `worker/wrangler.toml:31-37`, Cloudflare docs rechecked 2026-03-08 | Yes |
| 2 | Daily trigger table | Inaccurate | Daily Telegram pass named `dispatch-telegram-alerts` | Daily chained run logs as `dispatch-telegram-alerts-daily` | `worker/src/handlers/scheduled.ts:293-299` | Yes |
| 3 | Telegram-alert bot notes | Incomplete | Daily pass not named distinctly | Quarter-hourly and daily alert passes are separate cron-run names | `worker/src/handlers/scheduled.ts:169-174,293-299` | Yes |

### Changes Applied
- Replaced the stale trigger-cap guidance.
- Corrected the daily Telegram-dispatch job name and related descriptive text.

## yield-intelligence.md

**Status:** Verified

### Verification Notes
- Tiered APY resolution, deterministic overrides, auto-discovery rules, T-bill fetch, and cache/API behavior remain aligned with `worker/src/cron/sync-yield-data.ts`, `worker/src/cron/yield-config.ts`, and `worker/src/cron/fetch-tbill-rate.ts`.

### Changes Applied
- None.

## 2. Coverage Gap Analysis

### Undocumented Systems
| System/Feature | Complexity | Recommended Action |
|---------------|-----------|-------------------|
| Shadow stablecoins / PSI eligibility boundary | Medium | New doc created: `docs/shadow-stablecoins.md` |
| `/api/og/*` public image surface | Low | Folded into `docs/api-reference.md` and `docs/architecture.md` instead of creating a standalone doc |
| Historical timeline docs as a corpus | Medium | Separate git-history audit if you want every historical claim re-verified commit-by-commit |

### New Documents Created
- `docs/shadow-stablecoins.md` — documents the shadow-asset registry, PSI eligibility boundary, and public-UI exclusion rules.

## 3. Cross-Consistency Report

### Cross-Document Conflicts
| Doc A | Doc B | Conflict | Resolution |
|-------|-------|----------|------------|
| `README.md` | `worker/src/handlers/scheduled.ts` | README scheduler summary omitted Telegram alert dispatch and the daily safety-grade/Telegram pass | README infrastructure summary updated |
| `AGENTS.md` / `CLAUDE.md` | `shared/lib/stablecoins.ts` | Top-level tracked-stablecoin count drifted from 148 to 156 | Both files updated to 156 and linked to the new shadow doc |
| `docs/supply-snapshot.md` | `docs/stability-index.md` | PSI-eligible/shadow boundary described in one place but not the other | Both docs now use the same PSI-eligible terminology |
| `docs/api-reference.md` | `docs/architecture.md` | Public `/api/og/*` surface undocumented in both | Added to both docs |
| `docs/data-flow-map.md` | `docs/worker-infrastructure.md` | Scheduler summaries diverged on Telegram dispatch and daily safety snapshot sequencing | Both now match `worker/src/handlers/scheduled.ts` |

### Terminology Standardization
- Normalized PSI scope wording to `PSI-eligible` where the code uses tracked plus shadow assets.
- Normalized the daily Telegram pass name to `dispatch-telegram-alerts-daily`.
- Removed the stale “Sonnet prompt” wording in PSI docs and aligned it with the current Anthropic digest path.

### README / AGENTS / CLAUDE Alignment
- `README.md`: fixed freeze-tracker coin list (`EURC`) and aligned scheduler summary with the live scheduler.
- `AGENTS.md`: updated tracked-stablecoin count and added `docs/shadow-stablecoins.md` to the doc reference list.
- `CLAUDE.md`: updated tracked-stablecoin count and added `docs/shadow-stablecoins.md` to the doc reference list.

## 4. Summary Dashboard

Note: I did not fabricate a sentence-by-sentence “claims checked” integer. The dashboard below tracks document-level audit outcomes and fixes, which are the reliable numbers from this pass.

| Document Group | Documents | Issues Found | Issues Fixed |
|---------------|-----------|-------------|-------------|
| Docs updated in this pass | `api-reference.md`, `architecture.md`, `data-flow-map.md`, `design-language.md`, `report-cards.md`, `stability-index.md`, `supply-snapshot.md`, `testing.md`, `worker-and-api-limits.md`, `worker-infrastructure.md` | 18 | 18 |
| New docs added in this pass | `shadow-stablecoins.md` | 1 coverage gap | 1 |
| Verified docs with no changes | 19 markdown docs | 0 | 0 |
| Historical timeline docs | 6 markdown docs | 0 live-tree discrepancies found; historical claims not fully re-audited against git history | 0 |
| TOTAL | 36 audited markdown outcomes (35 docs + 1 new-doc gap closure) | 19 | 19 |

## Verification Run

- `npm run build` — passed
- `npm run lint` — passed with 9 pre-existing warnings in unrelated frontend files
- `npm test` — passed (`137` test files, `1305` tests)
- `cd worker && npx tsc --noEmit` — passed
