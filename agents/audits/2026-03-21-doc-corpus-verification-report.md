# 2026-03-21 Doc Corpus Verification Report

## Scope

This pass focused on code-backed drift in route maps, source inventories, cron schedules, registry/source-of-truth references, and README/doc cross-consistency. The worktree was already dirty when the audit started; unrelated user edits in other docs and worker files were preserved.

## Corpus-Wide Drift Scans

- File-reference scan across `README.md` and all `docs/*.md` found no additional actionable stale code-path references after the fixes above. Verified spot checks included the scheduled entrypoint split (`worker/src/handlers/scheduled.ts` plus `worker/src/handlers/scheduled/*.ts`) and the JSON-backed stablecoin registry (`shared/data/stablecoins/*.json` via `shared/lib/stablecoins/index.ts`).
- Route and export policy scan confirmed the trailing-slash public URL contract comes from `next.config.ts` (`output: "export"`, `trailingSlash: true`). Mixed placeholder notation such as `/compare/[slug]` vs `/compare/[slug]/` remains in docs, but maps to the same exported route family and was treated as notation, not a code-backed defect.
- Repo guards stayed green after the doc fixes:
  - `npm run check:doc-counts`
  - `npm run check:cron-sync`

## Per-Document Verification Report

## README.md

**Status:** 1 incomplete

### Issues Found

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|---|---|---|---|---|---|
| 1 | `Data Sources` table | Incomplete | Source table omitted live pricing/liquidity inputs now used in production | Pricing path includes Kraken, Bitstamp, Jupiter, direct DEX APIs, and Chainlink-backed overlays/reserve reads | `worker/src/cron/enrich-prices.ts`, `worker/src/cron/sync-fx-rates.ts`, `src/app/about/page.tsx` | Yes |

### Changes Applied

- Added `Kraken`, `Bitstamp`, `Jupiter Price API`, grouped direct DEX APIs, and `Chainlink` to the README data-source table so it matches the live pricing/liquidity/reference stack. Ground truth: `worker/src/cron/enrich-prices.ts:18-28`, `worker/src/cron/enrich-prices.ts:269-295`, `worker/src/cron/enrich-prices.ts:744-745`, `worker/src/cron/sync-fx-rates.ts:637-705`, `src/app/about/page.tsx:36-51`.

## docs/README.md

**Status:** 1 incomplete

### Issues Found

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|---|---|---|---|---|---|
| 1 | `Public Route Coverage` | Incomplete | Route-first lookup table had `/compare/[slug]/` but omitted `/compare/` and `/cemetery/` | Both `/compare/` and `/cemetery/` are real public routes with the same primary doc | `src/app/compare/page.tsx`, `src/app/cemetery/page.tsx` | Yes |

### Changes Applied

- Added `/cemetery/` and `/compare/` to the route lookup table. Ground truth: `src/app/cemetery/page.tsx:13-18`, `src/app/compare/page.tsx:8-16`.

## docs/architecture.md

**Status:** 1 inaccurate

### Issues Found

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|---|---|---|---|---|---|
| 1 | File tree comment for `snapshot-supply.ts` | Inaccurate | Framed the 08:00 UTC run as the primary path | `snapshot-supply` is registered on the quarter-hourly trigger; 08:00 UTC is the safety-net fallback | `shared/lib/cron-jobs.ts`, `worker/src/handlers/scheduled/quarter-hourly.ts`, `worker/src/handlers/scheduled/daily-0800.ts` | Yes |

### Changes Applied

- Updated the `snapshot-supply.ts` file-tree note to reflect the quarter-hourly primary path and 08:00 UTC fallback. Ground truth: `shared/lib/cron-jobs.ts:213-220`, `worker/src/handlers/scheduled/quarter-hourly.ts:37-54`, `worker/src/handlers/scheduled/daily-0800.ts:15-18`.

## docs/classification.md

**Status:** 1 inaccurate

### Issues Found

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|---|---|---|---|---|---|
| 1 | Opening registry/source-of-truth paragraph | Inaccurate | Treated category `.ts` files under `shared/lib/stablecoins/` as the tracked metadata source of truth | The live registry is loaded from `shared/data/stablecoins/*.json` through `shared/lib/stablecoins/index.ts` + `schema.ts` | `shared/lib/stablecoins/index.ts`, `shared/lib/stablecoins/schema.ts` | Yes |

### Changes Applied

- Repointed the doc to the JSON-backed registry and loader modules. Ground truth: `shared/lib/stablecoins/index.ts:1-24`, `shared/lib/stablecoins/schema.ts:1-80`.

## docs/data-flow-map.md

**Status:** 2 inaccurate / 2 incomplete

### Issues Found

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|---|---|---|---|---|---|
| 1 | `Stablecoin core list + prices` row | Incomplete | Omitted active production sources such as Kraken, Bitstamp, Jupiter, gold-api.com, and Chainlink overlays | All are part of the current pricing/reference path | `worker/src/cron/enrich-prices.ts`, `worker/src/cron/sync-fx-rates.ts` | Yes |
| 2 | `Stablecoin detail summaries + market-cap charts` row | Incomplete | Listed only `usePrefetchStablecoin` / `useStablecoinCharts` | The detail surface is anchored by `useStablecoinDetailViewModel()` | `src/app/stablecoin/[id]/client.tsx` | Yes |
| 3 | `Daily digest` row | Inaccurate | Reduced the digest input surface to Anthropic + PSI context | The digest consumes broader cached Pharos market/state context before the Anthropic call | `worker/src/cron/daily-digest.ts`, `worker/src/cron/daily-digest/collectors.ts` | Yes |
| 4 | `Scheduling Backbone` 5-minute / 08:05 rows | Inaccurate | Claimed the 5-minute Telegram slot handled cemetery announcements | Cemetery/tracked/pre-launch notices are appended on the 08:05 digest path, not the 5-minute subscriber-alert cron | `worker/src/handlers/scheduled/five-minute-telegram.ts`, `worker/src/handlers/scheduled/daily-0805.ts` | Yes |

### Changes Applied

- Expanded the stablecoin source row to match the live pricing/reference stack. Ground truth: `worker/src/cron/enrich-prices.ts:18-28`, `worker/src/cron/enrich-prices.ts:269-295`, `worker/src/cron/enrich-prices.ts:312-323`, `worker/src/cron/enrich-prices.ts:744-745`, `worker/src/cron/sync-fx-rates.ts:637-705`.
- Added `useStablecoinDetailViewModel` to the detail-surface hook mapping. Ground truth: `src/app/stablecoin/[id]/client.tsx:85-92`.
- Clarified that the digest prompt uses cached Pharos context beyond PSI alone. Ground truth: `worker/src/cron/daily-digest.ts:20-34`, `worker/src/cron/daily-digest.ts:533-573`, `worker/src/cron/daily-digest/collectors.ts:35-814`.
- Moved cemetery/tracked/pre-launch notices off the 5-minute lane and onto the 08:05 digest lane in the scheduling map. Ground truth: `worker/src/handlers/scheduled/five-minute-telegram.ts:1-19`, `worker/src/handlers/scheduled/daily-0805.ts:1-46`.

## docs/scripts.md

**Status:** 1 inaccurate

### Issues Found

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|---|---|---|---|---|---|
| 1 | `scripts/check-doc-counts.mjs` row | Inaccurate | Listed `shared/lib/stablecoins/*.ts` inputs as the count authority | The script now reads `shared/data/stablecoins/*.json` and `canonical-order.json` | `scripts/check-doc-counts.mjs` | Yes |

### Changes Applied

- Updated the script inventory row to match the actual JSON-backed inputs. Ground truth: `scripts/check-doc-counts.mjs:26-41`, `scripts/check-doc-counts.mjs:80`.

## docs/shadow-stablecoins.md

**Status:** 1 inaccurate

### Issues Found

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|---|---|---|---|---|---|
| 1 | Registry-boundary paragraph | Inaccurate | Referred to tracked stablecoin metadata as `shared/lib/stablecoins/` modules | The tracked registry now resolves through `shared/lib/stablecoins/index.ts`, backed by JSON assets | `shared/lib/stablecoins/index.ts` | Yes |

### Changes Applied

- Updated the boundary note to point at the current tracked registry. Ground truth: `shared/lib/stablecoins/index.ts:1-24`.

## docs/supply-snapshot.md

**Status:** 1 inaccurate

### Issues Found

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|---|---|---|---|---|---|
| 1 | `Cron Schedule` | Inaccurate | Marked `0 8 * * *` as the primary schedule and `*/15` as a retry path | The quarter-hourly chain is the primary execution path after a safe stablecoins-cache write; 08:00 UTC is the safety-net fallback | `shared/lib/cron-jobs.ts`, `worker/src/handlers/scheduled/quarter-hourly.ts`, `worker/src/handlers/scheduled/daily-0800.ts` | Yes |

### Changes Applied

- Rewrote the schedule bullets to match the real primary/fallback execution model and named the two scheduled handlers explicitly. Ground truth: `shared/lib/cron-jobs.ts:213-220`, `worker/src/handlers/scheduled/quarter-hourly.ts:37-54`, `worker/src/handlers/scheduled/daily-0800.ts:15-18`.

## docs/worker-infrastructure.md

**Status:** 1 inaccurate / 1 incomplete

### Issues Found

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|---|---|---|---|---|---|
| 1 | Env table `TELEGRAM_CHAT_ID` | Inaccurate | Described only digest posts and cemetery announcements | The same creds also drive weekly recap posting, and the appended notices now cover cemetery + tracked + pre-launch deltas | `worker/src/lib/runtime-credentials.ts`, `worker/src/cron/weekly-recap.ts`, `worker/src/cron/daily-digest.ts` | Yes |
| 2 | Trigger 10 table | Incomplete | Listed `sync-bluechip`, `daily-digest`, and `discovery-scan`, but omitted `weekly-recap` | `weekly-recap` is a real scheduled job chained after `daily-digest` on the 08:05 slot | `worker/src/handlers/scheduled/daily-0805.ts`, `shared/lib/cron-jobs.ts` | Yes |

### Changes Applied

- Updated `TELEGRAM_CHAT_ID` usage text to reflect both daily and weekly channel posts plus appended notice types. Ground truth: `worker/src/lib/runtime-credentials.ts:19-24`, `worker/src/cron/weekly-recap.ts:125-128`, `worker/src/cron/weekly-recap.ts:251-263`.
- Added `weekly-recap` to the Trigger 10 job table and clarified that it reuses the digest lane rather than increasing peak concurrency. Ground truth: `worker/src/handlers/scheduled/daily-0805.ts:1-46`, `shared/lib/cron-jobs.ts:306-315`.

## Coverage Gap Analysis

### Undocumented Systems

| System/Feature | Complexity | Recommended Action |
|---|---|---|
| None that clearly crossed the “new dedicated doc required” bar in this pass | — | Existing docs already cover the page surfaces, worker runtime, scripts, operator access, and major methodologies |

### New Documents Created

- None

## Cross-Consistency Report

### Cross-Document Conflicts

| Doc A | Doc B | Conflict | Resolution |
|---|---|---|---|
| `docs/data-flow-map.md` | `docs/worker-infrastructure.md` / digest docs | 5-minute Telegram lane was described as carrying cemetery announcements | Normalized the schedule to subscriber alerts on the 5-minute lane and digest appendices on the 08:05 digest lane |
| `docs/supply-snapshot.md` | `docs/architecture.md` / `docs/worker-infrastructure.md` / `shared/lib/cron-jobs.ts` | Snapshot supply primary/fallback schedule was reversed | Normalized docs to quarter-hourly primary path with 08:00 UTC safety-net fallback |
| `docs/classification.md` / `docs/shadow-stablecoins.md` / `docs/scripts.md` | current registry loader | Tracked stablecoin metadata still described as `.ts`-file-backed | Normalized references to the JSON-backed registry under `shared/data/stablecoins/*.json` |
| `README.md` | `docs/about-page.md` / `docs/data-flow-map.md` / pricing code | README source inventory lagged the live pricing/reference stack | Added the missing active sources to the README table |

### Terminology Standardization

- Normalized “primary schedule” vs “safety-net fallback” for `snapshot-supply`.
- Normalized “cemetery / tracked / pre-launch notices” as digest appendices on the 08:05 lane rather than generic Telegram announcements.
- Normalized “tracked stablecoin registry” to the JSON-backed loader path instead of the retired category-file description.

## Verification Results

| Check | Result | Notes |
|---|---|---|
| `npm run check:doc-counts` | Pass | Count guard matches current docs after fixes |
| `npm run check:cron-sync` | Pass | Shared cron metadata still matches `worker/wrangler.toml` |
| `cd worker && npx tsc --noEmit` | Pass | Worker type-check clean |
| `npm run build` | Pass | Next.js static export completed successfully |
| `npm run lint` | Pass with warning | Existing warning: `worker/src/cron/__tests__/yield-resolve.test.ts:487` unused `result` variable |
| `npm test` | Fail (unrelated) | Existing expectation drift in `shared/lib/__tests__/stablecoins.test.ts:21-24` (`usdMajorAsset` now parses to 28, test still expects 29) |

## Summary Dashboard

| Document | Claims Checked | Verified | Issues Found | Issues Fixed |
|---|---:|---:|---:|---:|
| `README.md` | targeted | targeted | 1 | 1 |
| `docs/README.md` | targeted | targeted | 1 | 1 |
| `docs/architecture.md` | targeted | targeted | 1 | 1 |
| `docs/classification.md` | targeted | targeted | 1 | 1 |
| `docs/data-flow-map.md` | targeted | targeted | 4 | 4 |
| `docs/scripts.md` | targeted | targeted | 1 | 1 |
| `docs/shadow-stablecoins.md` | targeted | targeted | 1 | 1 |
| `docs/supply-snapshot.md` | targeted | targeted | 1 | 1 |
| `docs/worker-infrastructure.md` | targeted | targeted | 2 | 2 |
| TOTAL FIXED | — | — | 13 | 13 |
