# Documentation Health Report — 2026-03-25

## Headline

- Audited assets discovered: 69
- Current verified `/docs/` files: 55
- Support docs audited outside `/docs/`: 6
- Current files updated: 35
- Working-artifact files archived out of `/docs/`: 8

## Issues Found

Issue groups remediated during this pass:

- Critical: 1
- Major: 24
- Minor: 10

### Critical

- Telegram webhook documentation and the registration script still described and generated the retired `?secret=` flow, while the live worker only accepted `X-Telegram-Bot-Api-Secret-Token`. The docs and `scripts/register-telegram-webhook.sh` now match the live handler and Telegram `secret_token` registration flow.

### Major

- Migration-squash drift: multiple docs still pointed at pre-squash migration files that no longer exist in the checked-in tree.
- Worker/public API rate-limit behavior was documented as isolate-local fallback; live code is fail-open on distributed limiter failure.
- Merge-gate / CI validation docs omitted `npm run check:cron-connections`.
- Route-contract drift on `/`, `/start/`, `/stablecoin/[id]/`, `/chains/`, `/chains/[chain]/`, `/coverage/`, and `/compare/`.
- Blacklist coverage docs lagged the live PYUSD and USD1 expansion.
- Digest docs missed weekly recap slug behavior and described the wrong editorial body typography.
- Supply snapshot docs overstated retention, omitted the 1-hour cooldown guard, and kept stale decimal examples.
- Data-flow / live-reserve docs understated the full hourly reserve lane.
- README and route maps lagged the protocol taxonomy routes and current worker env semantics.
- `/docs/` contained planning/spec artifacts that violated the repo rule that `/docs/` is the verified corpus.

### Minor

- Design references had shell/layout token drift after the sidebar/header refinements.
- Timeline docs needed version/date refreshes and migration-squash wording cleanup.
- Support docs (`CLAUDE.md`, migration rollback commands) had small but real workflow inaccuracies.

## Coverage Gaps Filled

- Added `/stablecoins/protocol/[protocol]/` to the route maps.
- Documented weekly digest snapshot slugs: `YYYY-MM-DD-weekly`.
- Documented `GET /api/blacklist-summary` and its frontend hook in the end-to-end flow map.
- Documented the hourly reserve lane's follow-on work: redemption backstops, Kinesis supply, and collateral-drift checks.
- Normalized migration references to the live `0000_baseline.sql` + `MANIFEST.md` model across the docs that previously referenced removed files.

## Structural Changes

- Archived 8 planning/spec artifacts from `docs/superpowers/**` into `/agents/**` so `/docs/` again matches the repo's "verified corpus" rule.
- Updated the main documentation entry points (`README.md`, `docs/README.md`) so route discovery and operational guidance match the live codebase.
- Kept untouched but verified: `AGENTS.md`, `shared/data/stablecoins/PROVENANCE_NOTES.md`, and `agents/process/cmux-browser.md`.

## File-Level Remediation Summary

- `README.md`: fixed migration-tree description, validation-gate command list, worker env classification, and protocol taxonomy route coverage.
- `docs/README.md`: added protocol taxonomy route coverage.
- `docs/api-reference.md`: corrected public API limiter behavior, Telegram webhook auth contract, and blacklist-supported symbols.
- `docs/architecture.md`: corrected migration-tree description, Telegram migration references, and indexable route-family coverage.
- `docs/worker-infrastructure.md`: corrected webhook auth wording, public API limiter semantics, module-level state description, baseline-migration references, and squash strategy section.
- `docs/worker-and-api-limits.md`: corrected public API limiter behavior.
- `docs/testing.md`: added `check:cron-connections` and updated merge-gate validation wording.
- `docs/deployment-process.md`: added `check:cron-connections` to local and CI validate descriptions.
- `docs/scripts.md`: added the cron-connection-budget checker and updated Telegram webhook registration behavior.
- `docs/blacklist-tracker.md`: updated live blacklist coverage and migration references to the post-squash tree.
- `docs/homepage.md`: removed the retired campaign callout contract and corrected section composition/order.
- `docs/start-page.md`: removed the retired fact-grid contract and corrected the hero/goal-grid description.
- `docs/stablecoin-detail-page.md`: corrected rendered section order, rail behavior, and the undocumented distribution section.
- `docs/chains-page.md`: corrected leaderboard hero metrics and profile table semantics.
- `docs/coverage-page.md`: corrected blacklist support, price headline semantics, and feature-snapshot wording.
- `docs/cemetery-and-compare.md`: corrected lowercase-symbol URL behavior for ambiguous tickers.
- `docs/report-cards-timeline.md`: advanced the changelog through v6.7 and added v6.6/v6.7 entries.
- `docs/design-language.md`: corrected live shell/layout details and digest typography guidance.
- `docs/design-tokens.md`: documented the frost-blue primitive accent alongside the hue families.
- `docs/telegram-alerts.md`: corrected webhook auth/registration behavior and baseline migration references.
- `scripts/register-telegram-webhook.sh`: switched webhook registration to Telegram `secret_token`.
- `docs/supply-snapshot.md`: documented cooldown/retention behavior, removed stale decimal examples, and normalized migration references.
- `docs/digest-pipeline.md`: corrected body typography, weekly slugs/API behavior, and baseline migration references.
- `docs/data-flow-map.md`: corrected blacklist API/hook coverage and the hourly reserve lane sequence.
- `docs/live-reserves.md`: documented the full shared hourly reserve lane.
- `docs/feedback-pipeline.md`: normalized feedback migration references to the baseline tree.
- `docs/depeg-detection.md`: normalized depeg migration references to the baseline tree.
- `docs/yield-intelligence.md`: normalized yield migration references to the baseline tree.
- `docs/redemption-backstops.md`: normalized redemption migration references to the baseline tree.
- `docs/mint-burn-flows.md`: normalized mint/burn migration references to the baseline tree.
- `docs/stability-index-timeline.md`: updated the methodology-version migration note for the baseline squash.
- `docs/liquidity-score-timeline.md`: updated the methodology-version migration note for the baseline squash.
- `docs/dews.md`: updated the blacklist activity signal coverage set.
- `CLAUDE.md`: corrected pre-push hook behavior.
- `worker/migrations/MANIFEST.md`: corrected rollback commands to the repo's actual Wrangler invocation pattern.

## Validation

Executed successfully:

- `npm run check:doc-counts`
- `npm run check:doc-sync`
- `npm run check:cron-sync`
- `npm run check:cron-connections`
- `npm run check:migrations`
- `bash -n scripts/register-telegram-webhook.sh`
- local markdown relative-link check across the audited documentation surface

## Remaining Concerns

- The current automated doc guards are strong on counts, methodology versions, and cron metadata, but they do not yet detect route-section order drift, webhook-auth-mode drift, or stale migration-file references. Those were the main classes of issues found in this audit.
- Future hygiene work should add targeted doc assertions for:
  - live route maps and major section order on route-contract docs
  - webhook auth mode / registration flow
  - post-squash migration reference hygiene
