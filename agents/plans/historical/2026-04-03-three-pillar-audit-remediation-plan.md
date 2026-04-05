# Three-Pillar Audit Remediation Plan

Date: 2026-04-03
Source audit: `agents/audits/2026-04-03-comprehensive-three-pillar-audit.md`
Status: complete

## Review outcome

The audit is directionally useful, but not every finding is current or worth implementing as written.

Validated and in scope:

- Worker correctness fixes around non-OK fetch handling, unsafe non-null assertions, and filter-then-assert patterns.
- Low-risk formatter and helper consolidation where the live code is genuinely duplicated.
- EVM selector centralization and Chainlink parser consolidation.
- Targeted maintainability improvements in Telegram dispatch and a few hotspot helpers.
- Test additions for the changed behaviors.

Stale or rejected as written:

- `R-M4` treasury `formatUsd` is not equivalent to `formatCompactUsd`; replacing it would change UI behavior.
- `S-L1` cron schedule alignment check already exists via `scripts/check-cron-schedule-sync.ts` and `npm run check:cron-sync`.
- Coverage findings (`Q-M9`, `Q-M10`, `Q-M11`) are useful prioritization signals, not discrete defects. They will be addressed with targeted tests for the remediated paths rather than a repo-wide coverage campaign in one sweep.
- Package pinning suggestions are only partially actionable. `@radix-ui/react-popover` looks inconsistent and can be normalized; `cmdk` / `react-tweet` exact pins may be intentional and will not be changed blindly.
- Large architectural recommendations like full pricing-pipeline progressive type refinement are too broad for a single remediation pass; the plan narrows them to concrete maintainability wins that do not destabilize the pipeline.

## Execution plan

### 1. Correctness and robustness

- Add explicit `response.ok` guards before parsing Sim balances payloads.
- Remove the `llamaRes!` parse path in stablecoin intake and replace it with an explicit guarded response variable.
- Guard weekly recap percentage math against zero starting market cap.
- Replace Jupiter, portfolio, peg heatmap, collectors-market, hero-card, and related filter-then-assert patterns with typed filters or `.flatMap()`.
- Add the defensive `keeper` guard in depeg duplicate merging.
- Replace env-var non-null assertions with narrowing helpers.
- Add the missing TronGrid `res.ok` guard before parsing.
- Guard admin probe request building when `adminAccess` is absent.

### 2. Shared helper consolidation

- Add shared signed-currency formatting in `shared/lib/format.ts` and replace local duplicates.
- Reuse shared `timeAgo()` in price transparency.
- Remove dead or zero-logic helpers: `EDITORIAL_TITLE_CLASS`, `formatChainUsd`, `formatBillions`, `formatMcap`.
- Replace per-call `Intl.NumberFormat` creation in yield history chart formatting with memoized module-level formatters.
- Consolidate bigint / decimal formatting helpers where the logic is duplicated.

### 3. Reserve-adapter and worker cleanup

- Extract duplicated EVM selectors into `worker/src/lib/evm-selectors.ts`.
- Unify the two Chainlink `latestRoundData` parsers on the signed-int256 implementation.
- Reuse shared bigint decimal formatting in reserve adapters instead of local `formatUnits` duplication where safe.
- Add isolate-lifetime documentation and bounded failure decay for public API rate-limit emergency state.

### 4. Telegram dispatch maintainability

- Extract the repeated subscriber-routing logic into a helper that handles specific-vs-global fanout consistently.
- Add the allowlist comment/guard around interpolated alert columns.
- Keep the public behavior unchanged and preserve existing queueing / breaker semantics.

### 5. Dependency and verification work

- Normalize the `@radix-ui/react-popover` version range.
- Move `viem` ownership to the worker workspace if the lockfile can be updated cleanly without collateral churn.
- Add targeted tests for the correctness fixes and newly centralized helpers.
- Run `npm run lint`, `npm test`, `npm run build`, `cd worker && npx tsc --noEmit`, and `npm run test:merge-gate`.

## Success criteria

- No remaining validated critical or high-severity issues from the audit.
- Shared helpers replace live duplicate implementations without UI regressions.
- Worker correctness changes are covered by tests.
- Validation suite passes locally.

## Implementation outcome

Status: complete

Implemented:

- Correctness fixes across Sim balances, intake fallback handling, weekly recap zero-division, TronGrid parsing, env narrowing, typed filter guards, and admin probe request building.
- Shared formatter consolidation for signed currency, abbreviated number parts, score-color mapping, `timeAgo()`, and yield chart formatter caching.
- Reserve-adapter cleanup through shared EVM selector helpers, shared Chainlink round-data parsing, and shared bigint decimal formatting.
- Telegram alert maintainability work via extracted routing/delivery helpers plus explicit alert-column allowlist validation.
- Additional degraded-signal surfacing in daily-digest risk collectors and DEX-liquidity persistence metadata so partial failures stop looking fully healthy.
- Dependency cleanup: `@radix-ui/react-popover` normalized to a caret range and `viem` moved to `worker/package.json`.
- Removal of the stale `EDITORIAL_TITLE_CLASS` export plus matching allowlist/doc cleanup.

Reviewed but intentionally not implemented:

- `R-M4` treasury formatter replacement remained rejected because it would alter current UI semantics.
- `R-L5` yield-detail signed-percent wrapper stayed local because the difference is a null-display convention, not duplicated business logic.
- Full pricing-pipeline type refinement, broad coverage campaigns, circuit-breaker table migration, and repo-wide cache JSON migration remain backlog-scale follow-ups rather than safe single-pass remediation work.

Validation completed:

- `npm run lint`
- `npm test`
- `npm run build`
- `cd worker && npx tsc --noEmit`
- `npm run test:merge-gate`
