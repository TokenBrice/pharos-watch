# Documentation Audit — 2026-03-10

Scope: `/docs/` plus cross-consistency checks against `README.md`, `AGENTS.md`, `CLAUDE.md`, and the referenced mint/burn runbook in `agents/process/`.

Method: code-first verification against the live repository. I treated code and runtime configuration as the source of truth: `worker/wrangler.toml`, `shared/lib/cron-jobs.ts`, `worker/src/handlers/scheduled.ts`, feature modules under `worker/src/cron/` and `worker/src/api/`, shared metadata under `shared/lib/`, and filesystem inventories for migrations and documentation targets.

Counting note: `Claims Checked` below means material claim groups, counted from headings, bullet items, numbered steps, table rows, and standalone code-linked statements.

## 1. Per-Document Verification Report

## api-reference.md

**Status:** 579 verified / 2 inaccurate / 0 stale / 0 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | `GET /api/bluechip-ratings` intro | Inaccurate | Updated daily at `08:00 UTC` | Bluechip sync runs on the `5 8 * * *` slot | `worker/wrangler.toml:31-42`, `worker/src/handlers/scheduled.ts:413-417` | Yes |
| 2 | `GET /api/daily-digest` intro | Inaccurate | Produced daily at `08:00 UTC` | Daily digest runs on the `5 8 * * *` slot | `worker/wrangler.toml:31-42`, `worker/src/handlers/scheduled.ts:413-430` | Yes |

### Changes Applied
- Updated the Bluechip and daily-digest timing notes to `08:05 UTC` to match the live daily B trigger.

## architecture.md

**Status:** 64 verified / 3 inaccurate / 0 stale / 3 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | `API Endpoints` table | Incomplete | Omitted discovery-candidate admin routes | Router exposes discovery candidate list + dismiss handlers | `worker/src/api/discovery.ts:1-71`, `worker/src/router.ts:156-160` | Yes |
| 2 | `Telegram Subsystem Tables` | Incomplete | Omitted `telegram_pending_alerts` | Overflow queue table exists and is used by dispatch cron | `worker/migrations/0060_telegram_pending_alerts.sql:1-13`, `worker/src/cron/dispatch-telegram-alerts.ts:287-398` | Yes |
| 3 | `Telegram Subsystem Tables` note | Inaccurate | Implied the Telegram tables all came from `0054_telegram_subscribers.sql` | `0054` creates subscriber/subscription/disambiguation; `0060` adds pending alerts | `worker/migrations/0054_telegram_subscribers.sql:1-27`, `worker/migrations/0060_telegram_pending_alerts.sql:1-13` | Yes |
| 4 | `Telegram Alert Cron Job` | Inaccurate | `dispatch-telegram-alerts` runs on `*/15` and `0 8` | It runs on the dedicated 5-minute trigger | `shared/lib/cron-jobs.ts:9-18`, `worker/src/handlers/scheduled.ts:393-400` | Yes |
| 5 | `worker/migrations/` tree note | Inaccurate | `60 total` | There are 63 SQL migration files | `worker/migrations/0031a_mint_burn_v2.sql:1`, `worker/migrations/0056_dex_discovery_staging.sql:1`, `worker/migrations/0060_telegram_pending_alerts.sql:1` | Yes |
| 6 | Worker file tree | Incomplete | Missing `worker/src/cron/discovery-scan.ts` and `worker/src/api/discovery.ts`; daily comments still reflected the old schedule split | Both files exist; `sync-bluechip` and `daily-digest` run at `08:05 UTC` | `worker/src/cron/discovery-scan.ts:1-80`, `worker/src/api/discovery.ts:1-71`, `worker/src/handlers/scheduled.ts:413-430` | Yes |

### Changes Applied
- Added a curated-endpoints note pointing readers to `docs/api-reference.md` for the exhaustive contract.
- Added discovery-candidate routes to the endpoint table.
- Fixed the Telegram subsystem table inventory and migration note.
- Corrected the Telegram alert cron schedule, migration-file count, and worker tree coverage for discovery, Bluechip, digest, and Telegram alert files.

## blacklist-tracker-timeline.md

**Status:** 38 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## blacklist-tracker.md

**Status:** 190 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## bluechip-ratings.md

**Status:** 49 verified / 1 inaccurate / 0 stale / 0 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | Overview schedule | Inaccurate | Daily at `0 8 * * *` | Runs on `5 8 * * *` | `shared/lib/cron-jobs.ts:17-18`, `worker/src/handlers/scheduled.ts:415-416` | Yes |

### Changes Applied
- Updated the schedule line to the actual 08:05 UTC heavy daily slot.

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

**Status:** 32 verified / 1 inaccurate / 0 stale / 1 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | `Yield intelligence` row | Incomplete | Listed only `useYieldRankings` / Yield page | Detail UI also uses `useYieldHistory` on stablecoin pages | `src/hooks/use-yield-history.ts:1-11`, `src/components/yield-detail-section.tsx:5-9` | Yes |
| 2 | `Scheduling Backbone` | Inaccurate | Still described the pre-split 4-slot scheduler and old job placement | Live worker has 9 trigger slots with isolated blacklist, mint/burn, discovery, Telegram, and split daily A/B slots | `worker/wrangler.toml:31-42`, `shared/lib/cron-jobs.ts:9-18`, `worker/src/handlers/scheduled.ts:183-430` | Yes |

### Changes Applied
- Added the missing yield-history consumer path.
- Rewrote the scheduling-backbone section to match the live 9-trigger scheduler.

## data-pipeline.md

**Status:** 93 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## depeg-detection.md

**Status:** 132 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## depeg-dews-timeline.md

**Status:** 53 verified / 0 inaccurate / 0 stale / 0 incomplete

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

**Status:** 42 verified / 0 inaccurate / 0 stale / 0 incomplete

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

**Status:** 57 verified / 0 inaccurate / 0 stale / 0 incomplete

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

**Status:** 114 verified / 1 inaccurate / 0 stale / 0 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | Discovery-cron schedule references | Inaccurate | Discovery cron described as `3,23,43 * * * *` | DEX discovery runs on `6,26,46 * * * *` | `shared/lib/cron-jobs.ts:11-13`, `worker/src/handlers/scheduled.ts:343-347` | Yes |

### Changes Applied
- Corrected every discovery-cron schedule reference to the dedicated `6,26,46 * * * *` trigger.

## digest-pipeline.md

**Status:** 108 verified / 2 inaccurate / 0 stale / 0 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | Generation schedule | Inaccurate | Daily at `08:00 UTC` / `0 8 * * *` | Daily at `08:05 UTC` / `5 8 * * *` | `worker/wrangler.toml:31-42`, `worker/src/handlers/scheduled.ts:413-430` | Yes |
| 2 | Dependency note | Inaccurate | Digest is chained after `snapshot-psi` | The digest runs on a separate 08:05 trigger after the 08:00 snapshot slot | `worker/src/handlers/scheduled.ts:404-430` | Yes |

### Changes Applied
- Updated the schedule and dependency notes to the actual 08:05 UTC daily B trigger.
- Adjusted the timeout note to reference the correct slot.

## documentation-map-2026-03-05.tsv

**Status:** 6 verified / 1 inaccurate / 0 stale / 0 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | `agents/runbooks/` row | Inaccurate | Operator runbooks live in `agents/runbooks/` | The referenced runbook lives in `agents/process/` | `agents/process/mint-burn-ingestion.md:1-8` | Yes |

### Changes Applied
- Updated the location map to the real `agents/process/` path.

## feedback-pipeline.md

**Status:** 88 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## liquidity-score-timeline.md

**Status:** 41 verified / 0 inaccurate / 0 stale / 0 incomplete

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

## mint-burn-flows-timeline.md

**Status:** 60 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## mint-burn-flows.md

**Status:** 338 verified / 2 inaccurate / 1 stale / 0 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | `Cron Schedule` critical lane | Inaccurate | Critical lane runs on `3,23,43 * * * *` | Critical lane runs on `4,24,44 * * * *` | `shared/lib/cron-jobs.ts:11-14`, `worker/src/handlers/scheduled.ts:271-284` | Yes |
| 2 | `Cron Schedule` slot sharing | Inaccurate | Critical mint/burn shares the primary slot with blacklist + DEX discovery | Blacklist, mint/burn critical, DEX discovery, and mint/burn extended each use separate isolated triggers | `shared/lib/cron-jobs.ts:11-18`, `worker/src/handlers/scheduled.ts:244-377` | Yes |
| 3 | `Operator runbook` | Stale | `agents/runbooks/mint-burn-ingestion.md` | Runbook lives at `agents/process/mint-burn-ingestion.md` | `agents/process/mint-burn-ingestion.md:1-8` | Yes |

### Changes Applied
- Corrected the critical-lane cron expression.
- Rewrote the trigger-mode note to reflect the live isolated-trigger model.
- Updated the runbook path.

## report-cards-timeline.md

**Status:** 114 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## report-cards.md

**Status:** 164 verified / 0 inaccurate / 0 stale / 0 incomplete

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

**Status:** 72 verified / 1 inaccurate / 0 stale / 0 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | `Digest Integration` | Inaccurate | Daily digest runs at `08:00 UTC` and is chained off `snapshot-psi` | Digest runs on the separate `08:05 UTC` trigger after the `08:00 UTC` snapshot slot | `worker/src/handlers/scheduled.ts:404-430` | Yes |

### Changes Applied
- Rewrote the digest-integration note to the actual 08:05 follow-on trigger model.

## status-dashboard.md

**Status:** 188 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## supply-snapshot.md

**Status:** 107 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## telegram-alerts.md

**Status:** 98 verified / 1 inaccurate / 0 stale / 1 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | `Files` list | Incomplete | Omitted `worker/migrations/0060_telegram_pending_alerts.sql` | Pending-alert queue migration exists and is required for overflow delivery | `worker/migrations/0060_telegram_pending_alerts.sql:1-13` | Yes |
| 2 | `D1 Schema` intro | Inaccurate | `0054_telegram_subscribers.sql` creates the full table set | `0054` creates 3 tables; `0060` adds `telegram_pending_alerts` | `worker/migrations/0054_telegram_subscribers.sql:1-27`, `worker/migrations/0060_telegram_pending_alerts.sql:1-13` | Yes |

### Changes Applied
- Added the missing migration file to the file index.
- Split the schema intro between the `0054` base migration and the `0060` overflow-queue migration.

## testing.md

**Status:** 294 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## worker-and-api-limits.md

**Status:** 142 verified / 0 inaccurate / 0 stale / 0 incomplete

### Issues Found
None.

### Changes Applied
None.

## worker-infrastructure.md

**Status:** 362 verified / 2 inaccurate / 0 stale / 0 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | Trigger 9 connection-budget note | Inaccurate | The 5-minute offset was described relative to Trigger 7 | The relevant offset is from Trigger 8 (`0 8 * * *`) to Trigger 9 (`5 8 * * *`) | `worker/wrangler.toml:31-42`, `worker/src/handlers/scheduled.ts:404-430` | Yes |
| 2 | `sync-bluechip` section | Inaccurate | `sync-bluechip` schedule was `0 8 * * *` | `sync-bluechip` runs on `5 8 * * *` | `shared/lib/cron-jobs.ts:17-18, 189-220`, `worker/src/handlers/scheduled.ts:415-416` | Yes |

### Changes Applied
- Corrected the trigger-offset explanation for the daily digest dependency.
- Updated the `sync-bluechip` schedule to the 08:05 UTC heavy daily slot.

## yield-intelligence.md

**Status:** 185 verified / 2 inaccurate / 0 stale / 0 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | `sync-yield-data` schedule note | Inaccurate | `Trigger 3` | `sync-yield-data` is on Trigger 6 (`10,40 * * * *`) | `worker/wrangler.toml:35-38`, `worker/src/handlers/scheduled.ts:378-390` | Yes |
| 2 | `fetch-tbill-rate` schedule note | Inaccurate | `Trigger 4` | `fetch-tbill-rate` is on Trigger 8 (`0 8 * * *`) | `worker/wrangler.toml:39-41`, `worker/src/handlers/scheduled.ts:404-410` | Yes |

### Changes Applied
- Corrected both trigger-number references to the live scheduler numbering.

## 2. Coverage Gap Analysis

### Undocumented Systems
| System/Feature | Complexity | Recommended Action |
|---------------|-----------|-------------------|
| None requiring a new canonical doc | — | No new `/docs` files created. The current corpus already covers the major frontend pages, worker subsystems, scoring models, pipelines, scripts, and status/admin surfaces. |

### New Documents Created
- None.

## 3. Cross-Consistency Report

### Cross-Document Conflicts
| Doc A | Doc B | Conflict | Resolution |
|-------|-------|----------|------------|
| `README.md` | `docs/worker-infrastructure.md` | README still described the old 4-slot scheduler and wrong job placement | Updated README to the live 9-trigger topology from `worker/wrangler.toml` and `worker/src/handlers/scheduled.ts` |
| `README.md` | `shared/lib/stablecoins.ts`, `shared/lib/dead-stablecoins.ts`, `worker/migrations/*.sql` | README counts drifted: tracked stablecoins, cemetery entries, migration files | Updated README to 156 tracked stablecoins, 80 dead stablecoins, and 63 SQL migration files |
| `AGENTS.md` / `CLAUDE.md` | `docs/worker-infrastructure.md` | Topic-reference summary still said `4 triggers, 20 named runtime jobs` | Normalized both references to `9 trigger slots, 21 named runtime jobs` |
| `docs/architecture.md` | `docs/telegram-alerts.md` | Architecture omitted `telegram_pending_alerts` and treated `0054` as the only Telegram migration | Added the queue table and split the migration note across `0054` and `0060` |
| `docs/stability-index.md` | `docs/digest-pipeline.md` | Stability Index still described the old chained-after-snapshot digest flow | Standardized both docs on the separate 08:05 UTC digest trigger |
| `README.md` / `docs/mint-burn-flows.md` / `docs/documentation-map-2026-03-05.tsv` | `agents/process/mint-burn-ingestion.md` | Runbook references still pointed to the removed `agents/runbooks/` path | Updated all references to `agents/process/mint-burn-ingestion.md` and fixed the runbook schedule line itself |

### Terminology Standardization
- Standardized cron topology wording to `9 trigger slots` and `21 named runtime jobs`.
- Standardized daily scheduling to the split `08:00 UTC` light slot vs `08:05 UTC` heavy slot.
- Standardized the Telegram alert job description to `dedicated 5-minute trigger`.
- Standardized migration wording to `63 SQL migration files` rather than implying the highest migration id equals the file count.

## 4. Summary Dashboard

| Document | Claims Checked | Verified | Issues Found | Issues Fixed |
|----------|---------------:|---------:|-------------:|-------------:|
| api-reference.md | 581 | 579 | 2 | 2 |
| architecture.md | 70 | 64 | 6 | 6 |
| blacklist-tracker-timeline.md | 38 | 38 | 0 | 0 |
| blacklist-tracker.md | 190 | 190 | 0 | 0 |
| bluechip-ratings.md | 50 | 49 | 1 | 1 |
| cemetery-and-compare.md | 47 | 47 | 0 | 0 |
| classification.md | 38 | 38 | 0 | 0 |
| data-flow-map.md | 34 | 32 | 2 | 2 |
| data-pipeline.md | 93 | 93 | 0 | 0 |
| depeg-detection.md | 132 | 132 | 0 | 0 |
| depeg-dews-timeline.md | 53 | 53 | 0 | 0 |
| dependency-map.md | 77 | 77 | 0 | 0 |
| deployment-process.md | 42 | 42 | 0 | 0 |
| design-language.md | 207 | 207 | 0 | 0 |
| design-tokens.md | 57 | 57 | 0 | 0 |
| dews.md | 92 | 92 | 0 | 0 |
| dex-liquidity.md | 115 | 114 | 1 | 1 |
| digest-pipeline.md | 110 | 108 | 2 | 2 |
| documentation-map-2026-03-05.tsv | 7 | 6 | 1 | 1 |
| feedback-pipeline.md | 88 | 88 | 0 | 0 |
| liquidity-score-timeline.md | 41 | 41 | 0 | 0 |
| methodology-page.md | 28 | 28 | 0 | 0 |
| mint-burn-flows-timeline.md | 60 | 60 | 0 | 0 |
| mint-burn-flows.md | 341 | 338 | 3 | 3 |
| report-cards-timeline.md | 114 | 114 | 0 | 0 |
| report-cards.md | 164 | 164 | 0 | 0 |
| scripts.md | 55 | 55 | 0 | 0 |
| shadow-stablecoins.md | 41 | 41 | 0 | 0 |
| stability-index-timeline.md | 36 | 36 | 0 | 0 |
| stability-index.md | 73 | 72 | 1 | 1 |
| status-dashboard.md | 188 | 188 | 0 | 0 |
| supply-snapshot.md | 107 | 107 | 0 | 0 |
| telegram-alerts.md | 100 | 98 | 2 | 2 |
| testing.md | 294 | 294 | 0 | 0 |
| worker-and-api-limits.md | 142 | 142 | 0 | 0 |
| worker-infrastructure.md | 364 | 362 | 2 | 2 |
| yield-intelligence.md | 187 | 185 | 2 | 2 |
| TOTAL | 4456 | 4431 | 25 | 25 |

## Verification Evidence

- `npm run build` — passed.
- `npm test` — passed (`152` files, `1464` tests).
- `cd worker && npx tsc --noEmit` — passed.
