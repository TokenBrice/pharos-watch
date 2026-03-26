# Documentation Audit Report

## Summary

- **Total loops executed**: 3
- **Total issues found and corrected**: 16 (Critical: 0, High: 4, Medium: 11, Low: 1)
- **Documents modified**: `AGENTS.md`, `CLAUDE.md`, `README.md`, `docs/api-reference.md`, `docs/architecture.md`, `docs/blacklist-tracker.md`, `docs/data-pipeline.md`, `docs/testing.md`, `docs/worker-infrastructure.md`, `src/app/about/page.tsx`
- **Documents created**: `agents/plans/historical/2026-03-26-admin-status-ux-overhaul.md`
- **Documents merged**: none
- **Documents deleted**: `docs/superpowers/plans/2026-03-26-admin-status-ux-overhaul.md`

## Loop-by-Loop Breakdown

### Loop 1

- **Issues found**: 15 (Critical: 0, High: 4, Medium: 10, Low: 1)

| File | Claim | Severity | Issue | Fix Applied |
|------|-------|----------|-------|-------------|
| `AGENTS.md` | Methodology update contract | Medium | The file only named a partial subset of methodology surfaces and could miss required `/methodology` + changelog work. | Broadened the rule to cover pricing pipeline, PSI, PegScore/DEWS, LiquidityScore, Report Cards, blacklist tracker, mint/burn flow, yield intelligence, and Chain Health. |
| `AGENTS.md` | Pre-push validation | Medium | `test:merge-gate` was described as a full-CI mirror instead of a deploy-surface-aware gate. | Rewrote the section to describe skip behavior, conditional Pages/worker checks, and the `prepare`/`core.hooksPath` caveat. |
| `CLAUDE.md` | Validation + methodology + docs corpus instructions | Medium | The file omitted lint from the completion bar, narrowed methodology update scope, and treated `/docs/` as the sole verified corpus. | Added lint to the validation rule, broadened the methodology contract, and pointed readers to `/docs/` plus `README.md`. |
| `CLAUDE.md` | Directory overview | Low | The route inventory read like an exhaustive list while omitting live routes. | Marked it as a representative route inventory instead of an exhaustive one. |
| `README.md` | Infrastructure cron summary | High | The cron block was materially out of sync with live triggers, omitting the hourly and four-hour yield lanes and missing Kinesis on the reserve lane. | Rewrote the affected cron bullets to match `worker/wrangler.toml` / `shared/lib/cron-jobs.ts`. |
| `README.md` | Product feature cadence and blacklist coverage | Medium | Peg tracking was described as continuous, blacklist tracking as real-time, and blacklist coverage omitted `PYUSD` and `USD1`. | Updated the feature copy to the live 15-minute and hourly cadences and the current tracked token set. |
| `README.md` | Data-source, docs, and deploy workflow summary | Medium | Provider lists lagged current DEX/benchmark sources, the docs shortlist omitted key entry docs, and the deployment summary overstated validate behavior / used the old Pages digest step. | Expanded the affected source rows, added missing docs links, and corrected the validate/pages-release workflow summary. |
| `docs/blacklist-tracker.md` | Sync contract and runtime guard | Medium | The doc still described the old positional function signature and the old outer timeout contract. | Updated the function contract to `SyncBlacklistOptions`, documented the caller shape, and corrected the runtime-guard timeout wording. |
| `docs/architecture.md` | API and indexable-route inventory | High | The architecture inventory omitted live `blacklist-summary` and `remediate-blacklist-amount-gaps` routes and left out sitemap-emitted route families. | Added the missing endpoint rows, handler files, and the omitted indexable route families. |
| `docs/testing.md` | Coverage note, test inventory, and workflow notes | Medium | The doc incorrectly tied the 66% full-suite threshold to CI, missed active test trees, used a stale “full list” command, and had several small workflow/path note drifts. | Corrected the CI wording, refreshed the inventory and command, fixed the stale file row, and cleaned up the workflow/ignore/threshold notes. |
| `docs/worker-infrastructure.md` | Runtime inventory and operational policy | High | The file had stale cron counts, incomplete `wrangler.toml` var prose, wrong connection-budget rows, incorrect public-health circuit logic, and a fictional shared alert/dedup policy. | Updated the counts, env-binding explanation, slot-budget rows, circuit-health note, error-policy section, and live progress producer list. |
| `docs/api-reference.md` | `GET /api/yield-history` response shape | High | The endpoint was first documented as an object envelope, then contradicted later as a top-level array. | Removed the contradictory array framing and kept the contract scoped to `{ current, history, methodology }` plus `YieldHistoryPoint`. |
| `docs/api-reference.md` | Chart, digest, liquidity, and status endpoint contracts | Medium | Multiple endpoint sections had stale cache/freshness semantics or undocumented fields (`stablecoin-charts`, `daily-digest`, `digest-archive`, `digest-snapshot`, `dex-liquidity`, `status`). | Corrected the response metadata, cache labels, field types, and documented `editionNumber`, `digestType`, and the real `priceSourceHealth` scope. |
| `src/app/about/page.tsx` | `/about/` FAQ structured data | Medium | The FAQ JSON-LD still claimed only `USDC/USDT/PAXG/XAUT` freeze tracking. | Updated the answer text to include `PYUSD` and `USD1` and to reflect freeze + blacklist coverage. |
| `docs/superpowers/plans/2026-03-26-admin-status-ux-overhaul.md` | Verified corpus boundary | Medium | A planning artifact lived inside `/docs/`, which is supposed to be the verified documentation corpus. | Moved the file to `agents/plans/historical/` and removed it from `/docs/`. |

### Loop 2

- **Issues found**: 1 (Critical: 0, High: 0, Medium: 1, Low: 0)

| File | Claim | Severity | Issue | Fix Applied |
|------|-------|----------|-------|-------------|
| `docs/data-pipeline.md` | Circuit-breaker health impact | Medium | The file repeated the old claim that any open circuit degrades `/api/health`. | Updated it to the live rule: public health only degrades on 3 or more open circuits. |

### Loop 3 (Terminal)

- **Issues found**: 0
- **Details**: Re-ran targeted stale-phrase searches plus `npm run check:doc-sync`, `npm run check:doc-counts`, and `git diff --check`; no additional Medium-or-higher documentation issues were found.

## Structural Changes

- Archived `docs/superpowers/plans/2026-03-26-admin-status-ux-overhaul.md` to `agents/plans/historical/2026-03-26-admin-status-ux-overhaul.md` because it is implementation history, not verified product/system documentation.

## Out-of-Scope Observations

- `src/lib/methodology-context.ts` appears to contain methodology wording that does not match the live `/methodology` copy and scoring behavior around missing exit-data handling. I did not edit it because it is outside the requested scope.

## Residual Risks

- I verified documentation claims against the checked-in repo, not against live production responses. Runtime-only drift outside the repository was not tested.
- Some code comments / connection-budget annotations outside the docs are internally inconsistent (for example certain cron connection hints). I corrected only claims that were directly contradicted by source-backed runtime behavior.
