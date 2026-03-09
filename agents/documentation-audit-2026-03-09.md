# Documentation Audit — 2026-03-09

Audit scope: `/docs/` plus cross-consistency checks against `README.md`, `AGENTS.md`, and `CLAUDE.md`.

Counting note: the summary dashboard uses **material claim groups** (headings, table rows, bullet items, numbered steps, and code-linked statements) rather than raw sentence counts.

## 1. Per-Document Verification Report

## api-reference.md

**Status:** 557 verified / 6 inaccurate / 0 stale / 0 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | L362-L369, depeg methodology example | Inaccurate | Current depeg/dews version examples were `4.4` | Runtime exports `currentVersion: "4.5"` | `shared/lib/depeg-dews-version.ts:7` | Yes |
| 2 | L420-L427, peg-summary methodology example | Inaccurate | Current depeg/dews version examples were `4.4` | Runtime exports `currentVersion: "4.5"` | `worker/src/api/peg-summary.ts:269` | Yes |
| 3 | L1350-L1407, stress-signals methodology examples | Inaccurate | Current/stored methodology examples used `4.4` | Stress-signals envelopes use `DEPEG_DEWS_METHODOLOGY_VERSION = 4.5` | `worker/src/api/stress-signals.ts:109` | Yes |
| 4 | L385, `DepegEvent.peakDeviationBps` | Inaccurate | “always positive” | Signed value is stored and returned | `worker/src/lib/depeg-helpers.ts:95`, `worker/src/cron/detect-depegs.ts:139` | Yes |
| 5 | L790, digest snapshot example | Inaccurate | `direction: "below"` with `peakDeviationBps: 150` | Signed below-peg values are negative | `worker/src/cron/detect-depegs.ts:139` | Yes |
| 6 | L399 example wording | Ambiguous | `versionLabel` example still implied `v4.4` semantics | Latest label is `v4.5` | `shared/lib/depeg-dews-version.ts:7` | Yes |

### Changes Applied
- Updated all depeg/peg-summary/stress-signals methodology examples to `v4.5` based on the shared version module and API envelopes.
- Corrected `peakDeviationBps` to documented signed semantics and aligned the digest-snapshot example with a negative below-peg value.

## architecture.md

**Status:** 65 verified / 2 inaccurate / 0 stale / 0 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | Title + `## Full File Tree` | Ambiguous | Document claimed an exhaustive “Full File Tree” | The tree is architecture-significant but not exhaustive (for example, `/src/app/telegram/page.tsx` exists outside the listed subset) | `src/app/telegram/page.tsx:1` | Yes |
| 2 | L337 | Inaccurate | `worker/migrations/` had `59 total` | Repository currently has 60 SQL migrations | `worker/migrations/0057_dex_staging_quality_metadata.sql:1` | Yes |

### Changes Applied
- Renamed the contract to “Curated File Tree” and added an explicit exhaustive-inventory fallback command.
- Updated the migration count to 60.

## depeg-dews-timeline.md

**Status:** 51 verified / 0 inaccurate / 0 stale / 2 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | L3 header coverage | Incomplete | Timeline ended at `v4.4` on 2026-03-02 | Shared changelog now starts at `currentVersion: "4.5"` dated 2026-03-09 | `shared/lib/depeg-dews-version.ts:7` | Yes |
| 2 | Top of file | Incomplete | No `v4.5` entry | `v4.5` documents trusted DEX-price gating and UI trust thresholds | `shared/lib/depeg-dews-version.ts:10` | Yes |

### Changes Applied
- Extended the coverage line to `v4.5`.
- Added the missing `v4.5` timeline entry from the shared changelog source.

## liquidity-score-timeline.md

**Status:** 39 verified / 0 inaccurate / 0 stale / 2 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | L3 header coverage | Incomplete | Timeline ended at `v3.3` | Shared changelog current version is `v3.4` | `shared/lib/liquidity-score-version.ts:6` | Yes |
| 2 | Top of file | Incomplete | No `v3.4` entry | `v3.4` adds retained-pool recomputation and trusted staged-price hardening | `shared/lib/liquidity-score-version.ts:9` | Yes |

### Changes Applied
- Extended the coverage line to `v3.4`.
- Added the missing `v3.4` entry using the shared liquidity methodology changelog.

## mint-burn-flows-timeline.md

**Status:** 58 verified / 0 inaccurate / 0 stale / 2 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | L3 header coverage | Incomplete | Timeline ended at `v4.5` | Shared changelog current version is `v4.6` | `shared/lib/mint-burn-flow-version.ts:6` | Yes |
| 2 | Top of file | Incomplete | No `v4.6` entry | `v4.6` adds safe-frontier advancement and counted-history alignment | `shared/lib/mint-burn-flow-version.ts:9` | Yes |

### Changes Applied
- Extended the coverage line to `v4.6`.
- Added the missing `v4.6` entry from the shared mint/burn methodology changelog.

## testing.md

**Status:** 290 verified / 2 inaccurate / 0 stale / 2 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | L70 config excerpt | Inaccurate | Vitest exclude example omitted `worktrees/**` | Vitest excludes both `.worktrees/**` and `worktrees/**` | `vitest.config.ts:20` | Yes |
| 2 | L202 frontend test inventory | Inaccurate | `peg-scoring.test.ts` targeted `src/lib/peg-scoring.ts` | Test imports `@shared/lib/peg-score` and `src/lib/peg-stability.ts` | `src/lib/__tests__/peg-scoring.test.ts:3` | Yes |
| 3 | L517 ignored paths | Incomplete | ESLint ignore list omitted `worktrees/` and `.codex-autorunner/` | Flat config ignores both paths | `eslint.config.mjs:9` | Yes |
| 4 | L521-L533 schema list | Incomplete | Runtime-validation list omitted `MintBurnEventsResponseSchema` | Hook validates mint/burn events with that schema | `src/hooks/use-mint-burn-flows.ts:143` | Yes |

### Changes Applied
- Synced the Vitest excerpt with the real config.
- Corrected the peg-scoring test target modules.
- Expanded ESLint ignore-path documentation.
- Added the missing mint/burn-events schema to the validation inventory.

## worker-infrastructure.md

**Status:** 337 verified / 0 inaccurate / 0 stale / 1 ambiguous

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | L3 overview | Ambiguous | “20 primary cron jobs” | Runtime exposes 20 named job labels, but one (`dispatch-telegram-alerts-daily`) is an extra runtime label outside `CRON_JOB_DEFINITIONS` | `worker/src/handlers/scheduled.ts:279`, `worker/src/handlers/scheduled.ts:296` | Yes |

### Changes Applied
- Normalized wording to “20 named runtime jobs” to match the actual scheduled handler behavior.

## blacklist-tracker-timeline.md

**Status:** 38 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## blacklist-tracker.md

**Status:** 186 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## cemetery-and-compare.md

**Status:** 47 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## classification.md

**Status:** 38 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## data-flow-map.md

**Status:** 26 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## data-pipeline.md

**Status:** 84 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## depeg-detection.md

**Status:** 120 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## dependency-map.md

**Status:** 77 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## deployment-process.md

**Status:** 41 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## design-language.md

**Status:** 207 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## design-tokens.md

**Status:** 55 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## dews.md

**Status:** 92 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## dex-liquidity.md

**Status:** 111 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## digest-pipeline.md

**Status:** 110 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## feedback-pipeline.md

**Status:** 82 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## methodology-page.md

**Status:** 28 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## mint-burn-flows.md

**Status:** 335 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## report-cards-timeline.md

**Status:** 114 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## report-cards.md

**Status:** 158 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## scripts.md

**Status:** 55 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## shadow-stablecoins.md

**Status:** 41 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## stability-index-timeline.md

**Status:** 36 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## stability-index.md

**Status:** 73 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## status-dashboard.md

**Status:** 153 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## supply-snapshot.md

**Status:** 106 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## telegram-alerts.md

**Status:** 96 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## worker-and-api-limits.md

**Status:** 141 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

Verified note: code-backed repo limits and throttle constants were checked against the referenced runtime files. The document already warns that third-party quota/pricing notes must be re-verified against vendor docs before spend-sensitive changes.

## yield-intelligence.md

**Status:** 174 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## 2. Coverage Gap Analysis

### Undocumented Systems

| System/Feature | Complexity | Recommended Action |
|---------------|-----------|-------------------|
| Bluechip ratings sync + cache/API/frontend usage | Medium | Create a dedicated doc so the public endpoint and daily sync path are not only described indirectly in larger infra docs |
| Stablecoin detail-page assembly and fallback logic | Medium | Optional future doc if onboarding pain appears; current coverage is spread across architecture, supply-snapshot, depeg, liquidity, and report-card docs |
| Shared endpoint registry + strict contract smoke system | Medium | Optional future doc if more external integrators depend on the API contract layer |

### New Documents Created

- `docs/bluechip-ratings.md` — documents the 17-coin Bluechip slug map, the daily `sync-bluechip` cron, the `bluechip-ratings` cache key, the public API contract, and the frontend consumers.

## 3. Cross-Consistency Report

### Cross-Document Conflicts

| Doc A | Doc B | Conflict | Resolution |
|-------|-------|----------|------------|
| `docs/architecture.md` | `AGENTS.md`, `CLAUDE.md` | Architecture doc claimed “Full File Tree” even though the tree is curated | Renamed the architecture contract to “Curated File Tree” and updated the agent references |
| `docs/worker-infrastructure.md` | `AGENTS.md`, `CLAUDE.md` | Cron count wording drifted (`19 primary jobs`, `20 primary jobs`) | Standardized on “20 named runtime jobs” based on `worker/src/handlers/scheduled.ts` |
| `README.md` | `worker/src/handlers/scheduled.ts` | README omitted `sync-dex-discovery` from the 20-minute cron slot | Added DEX discovery to the README infrastructure diagram |
| `README.md` | `docs/architecture.md` | Both still said 59 migrations | Updated both to 60 migrations |
| `/docs` corpus | codebase | No dedicated Bluechip subsystem doc despite public endpoint + daily sync | Added `docs/bluechip-ratings.md` and linked it from agent guidance |

### Terminology Standardization

- “Full file tree” -> “Curated file tree” where the document is intentionally architecture-focused rather than exhaustive.
- “20 primary jobs” / “19 primary jobs” -> “20 named runtime jobs”.
- Depeg `peakDeviationBps` terminology standardized to signed semantics across the API docs.

## 4. Summary Dashboard

| Document | Claims Checked | Verified | Issues Found | Issues Fixed |
|----------|---------------:|---------:|-------------:|-------------:|
| `api-reference.md` | 563 | 557 | 6 | 6 |
| `architecture.md` | 67 | 65 | 2 | 2 |
| `blacklist-tracker-timeline.md` | 38 | 38 | 0 | 0 |
| `blacklist-tracker.md` | 186 | 186 | 0 | 0 |
| `bluechip-ratings.md` | 50 | 50 | 0 | 0 |
| `cemetery-and-compare.md` | 47 | 47 | 0 | 0 |
| `classification.md` | 38 | 38 | 0 | 0 |
| `data-flow-map.md` | 26 | 26 | 0 | 0 |
| `data-pipeline.md` | 84 | 84 | 0 | 0 |
| `depeg-detection.md` | 120 | 120 | 0 | 0 |
| `depeg-dews-timeline.md` | 53 | 51 | 2 | 2 |
| `dependency-map.md` | 77 | 77 | 0 | 0 |
| `deployment-process.md` | 41 | 41 | 0 | 0 |
| `design-language.md` | 207 | 207 | 0 | 0 |
| `design-tokens.md` | 55 | 55 | 0 | 0 |
| `dews.md` | 92 | 92 | 0 | 0 |
| `dex-liquidity.md` | 111 | 111 | 0 | 0 |
| `digest-pipeline.md` | 110 | 110 | 0 | 0 |
| `feedback-pipeline.md` | 82 | 82 | 0 | 0 |
| `liquidity-score-timeline.md` | 41 | 39 | 2 | 2 |
| `methodology-page.md` | 28 | 28 | 0 | 0 |
| `mint-burn-flows-timeline.md` | 60 | 58 | 2 | 2 |
| `mint-burn-flows.md` | 335 | 335 | 0 | 0 |
| `report-cards-timeline.md` | 114 | 114 | 0 | 0 |
| `report-cards.md` | 158 | 158 | 0 | 0 |
| `scripts.md` | 55 | 55 | 0 | 0 |
| `shadow-stablecoins.md` | 41 | 41 | 0 | 0 |
| `stability-index-timeline.md` | 36 | 36 | 0 | 0 |
| `stability-index.md` | 73 | 73 | 0 | 0 |
| `status-dashboard.md` | 153 | 153 | 0 | 0 |
| `supply-snapshot.md` | 106 | 106 | 0 | 0 |
| `telegram-alerts.md` | 96 | 96 | 0 | 0 |
| `testing.md` | 294 | 290 | 4 | 4 |
| `worker-and-api-limits.md` | 141 | 141 | 0 | 0 |
| `worker-infrastructure.md` | 338 | 337 | 1 | 1 |
| `yield-intelligence.md` | 174 | 174 | 0 | 0 |
| **TOTAL** | **4290** | **4271** | **19** | **19** |

## Verification Commands

- `npm run lint`
- `npm test`
- `cd worker && npx tsc --noEmit`
- `npm run build`

Results:
- All four commands completed successfully on 2026-03-09.
