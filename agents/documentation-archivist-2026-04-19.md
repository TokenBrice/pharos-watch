# Documentation Archivist Audit - 2026-04-19

Scope: verify `/docs/`, README, `/about/`, `/methodology/`, and `/about/api/` against code as source of truth.

Process:

1. Inventory docs, routes, API endpoint definitions, cron schedules, and package scripts.
2. Run repository doc checks.
3. Use read-only subagents for independent documentation slices.
4. Patch docs from verified discrepancies.
5. Validate, commit, push, and repeat with a deeper verification pass until the verification phase returns fewer than 3 actionable documentation errors.

Loop 1 verification findings applied:

- `docs/homepage.md`: corrected Start Here callout/KPI bar ordering. The wrapper becomes `lg:contents`, so DOM order remains callout before KPI bar at all breakpoints when the callout renders.
- `docs/coverage-page.md`: added current `Data n/a` and `Impaired` matrix labels, and corrected Dependency Map coverage to use report-card dependency graph edges with static graph fallback.
- `docs/stablecoin-detail-page.md`: corrected `useInfiniteDepegEvents()` hook semantics and the blacklist section rendering gate.
- `docs/privacy-page.md`: added Telegram alert subscription storage to the route content contract.
- `docs/chain-health.md`: added a dedicated Chain Health Score feature/methodology doc and linked it from the docs index.
- `docs/doc-ownership.json`: linked Chain Health methodology changes to the new dedicated doc.
- `docs/data-pipeline.md`: added `usdnr-nerona` to authoritative price inheritance and corrected frontend freshness thresholds to `FRESHNESS_RATIOS`.
- `docs/digest-pipeline.md`: removed a stale collector count, separated queued admin digest triggers from scheduled channel metadata, expanded delivery statuses, and corrected weekly timeout wording.
- `docs/feedback-pipeline.md`: documented feedback body normalization and defanging before GitHub issue creation.
- `docs/telegram-alerts.md`: corrected launch snapshot handling as best-effort rather than part of the stale-snapshot seed gate.
- `docs/yield-intelligence.md`: replaced the fixed `yield_history` row-volume estimate with source-aware hourly semantics.
- `docs/blacklist-tracker.md` and `docs/blacklist-tracker-timeline.md`: corrected amount-source values, amount-recovery batch/scope, Gnosis safety margin, and BRZ catch-up cadence.
- `docs/dews.md`, `docs/depeg-detection.md`, `docs/dex-liquidity.md`, and `docs/depeg-dews-timeline.md`: corrected DEX trust freshness, DEWS stale-liquidity write behavior, blacklist signal coverage source, pending-depeg low-confidence promotion, Binance CEX scope, orphan cleanup, and depeg-event limit handling.
- `docs/report-cards.md`, `/methodology` copy, scoring changelog copy, and `docs/api-reference.md`: corrected active/cemetery report-card counts, liquidity pool-quality copy, promoted DEX bridge scope, consensus tiebreak order, and raw redemption `effectiveExitScore` semantics.
- `README.md`: added missing D1 tables and Worker rotation secrets to the top-level infrastructure inventory.
- `AGENTS.md`, `src/AGENTS.md`, and `shared/AGENTS.md`: updated shared import, TypeScript target, and hook polling guidance to match current configs.
- `docs/documentation-map-2026-03-05.tsv`: moved operator runbook ownership to `docs/runbooks/` and classified `agents/process/` as agent process docs.
- `docs/agent-code-map.md`: regenerated with `node scripts/generate-agent-code-map.mjs`.
- `docs/testing.md`: corrected duplicate-export guard wording and critical coverage file inventory.
- `docs/data-flow-map.md`: corrected `useApiQuery` freshness semantics and documented current polling exceptions.
- `docs/worker-infrastructure.md` and `docs/architecture.md`: corrected enforced cron connection-budget scope, weekly recap timeout, and `batchExecute()` return type.
- `docs/status-dashboard.md`: clarified the missing-price threshold count as historical and noted the current 180-active set.

Machine checks before edits:

- `npm run check:doc-sync`: passed
- `npm run check:doc-counts`: passed
- `npm run check:doc-source-paths`: passed
- `npm run check:verified-doc-links`: passed

Loop 2 verification findings applied:

- `shared/lib/*version*.ts`: normalized methodology `effectiveAt` values so UTC date resolution matches the displayed changelog `date` fields.
- `src/app/chains/page.tsx` and `src/lib/methodology-context.ts`: corrected Chain Health FAQ inputs and Peg Score minimum-history hint.
- `.env.example`, `README.md`, `src/app/about/page.tsx`, `docs/data-flow-map.md`, `docs/data-pipeline.md`, and `docs/yield-intelligence.md`: corrected API-base comments, source rosters, CEX freshness semantics, DEX transport classification, Treasury.gov benchmark fallback, and deterministic on-chain yield reader coverage.
- `docs/worker-infrastructure.md`, `docs/design-tokens.md`, and runbooks: removed stale live-reserve adapter enumeration, narrowed chart-token companion claims, documented primitive-token exceptions, and split stablecoins-cache/on-chain monitor symptoms from unrelated stale or mint/burn states.
- `docs/api-reference.md`: added blacklist amount-source enum values and suppression reason, corrected report-card `baseScore`/dependency/raw-input fields, and documented `collateralFromLive`.
- `README.md`: marked `api_request_source_stats` as legacy/schema-retained and added the transport-smoke deployment gate.

Loop 3 verification findings applied:

- `shared/lib/*version*.ts`: preserved date-correct, monotonic intra-day `effectiveAt` windows so same-day methodology releases remain reachable.
- `docs/api-reference.md`: clarified that public blacklist rows filter out non-null `suppressionReason`.
- `docs/yield-intelligence.md`: corrected the Treasury.gov XML URL and added the FRED-to-Treasury fallback to the benchmark cron description.
- `docs/scripts.md`, `docs/design-language.md`, `docs/status-dashboard.md`, `docs/operator-origin-access.md`, and `docs/funding-page.md`: corrected deploy diff notation, digest title typography, Price Source Health placement, Pages proxy env bindings, funding display fallback, and cost-review placement.
- Shared code comments in status/funding types were updated where they pointed to stale plan paths or stale UI placement.
