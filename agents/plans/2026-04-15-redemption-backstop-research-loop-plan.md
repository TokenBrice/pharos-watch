# Redemption Backstop Research Loop Plan - 2026-04-15

## Assumptions

- Do not promote capacity telemetry unless the adapter definition, emitted metadata, route config, docs, and freshness semantics all agree.
- Treat standalone `/api/redemption-backstops` accuracy as user-facing, even when report-card Safety Score already has an additional eligibility gate.
- Prefer root-cause guardrails over one-off config tweaks.

## Plan Review Loop

### Draft Plan

1. Fix shared config mutation so reviewed docs cannot leak across `expandIds()` groups.
2. Align adapter outputs with `LIVE_RESERVE_ADAPTER_DEFINITIONS`: remove unsupported capacity metadata from adapters whose capacity tier remains `none`.
3. Harden redemption telemetry validation for nested plus legacy fields.
4. Make live non-open route status fail closed in redemption snapshots.
5. Correct basis/provenance and public docs drift.
6. Add numeric/run-manifest guardrails and targeted tests.
7. Re-run audit. Promote coverage only if fewer than three minor concerns remain and sources are strong enough.

Review issues:

- Issue 1: The draft did not explicitly address unsupported adapter capacity metadata. Severity high. Fixed by adding step 2.
- Issue 2: The draft could have promoted `ussd-sonic-labs` too quickly. Severity medium. Fixed by deferring until contract/API source mapping is verified.
- Issue 3: The draft lacked a completed-run data-integrity guard. Severity minor. Fixed by adding step 6.
- Issue 4: The draft did not include public docs drift. Severity minor. Fixed by adding step 5.

### Reviewed Plan

1. Implement only invariant and accuracy fixes in this loop.
2. Do not promote `accountable`, `dola-inverse`, `m0`, `mento`, `re-metrics`, or `usdd-data-platform` to capacity telemetry yet.
3. Defer `ussd-sonic-labs`, `deuro-deuro`, and M0 extension coverage until route-specific source mapping is complete.
4. Validate with targeted tests, `check:redemption-backstops`, doc sync, lint, tests, worker type-check, and merge gate.

Remaining plan issues after review:

- Minor: `ussd-sonic-labs` remains a likely coverage expansion candidate, but the live reserve API source mapping is not yet proven.
- Minor: `deuro-deuro` bridge capacity looks implementable, but needs multi-bridge adapter support and token pricing review.

This satisfies the requested review-loop threshold: fewer than three remaining minor issues and no known major issue in the plan.

## Execution Checklist

- [x] Clone configs in `expandIds()` and add regression coverage for per-coin docs.
- [x] Remove unsupported capacity telemetry from no-capacity adapters.
- [x] Add adapter-output validation assertions for affected adapters.
- [x] Validate legacy and nested redemption telemetry independently.
- [x] Add clearer missing-capacity reason when a capable adapter omits amount fields.
- [x] Mark live paused/degraded/cohort-limited route statuses as impaired.
- [x] Let route family derive documented-bound capacity basis.
- [x] Update redemption methodology version and docs to `v3.96`.
- [x] Update API reference and UI methodology context for best-path effective exit.
- [x] Add fallback-ratio, score-cap, and completed-run integrity guards.
- [x] Run full validation.
- [ ] Push to `origin/main`.

## Re-Audit Result

The post-execution audit does not identify a safe additional implementation in this loop. Remaining opportunities are coverage research projects, not ready code changes:

- Verify USSD's dedicated proof/balance-sheet API mapping before using `frax-balance-sheet` capacity for Safety Score.
- Add dEURO StablecoinBridge capacity only after multi-bridge support and EUR stablecoin valuation are reviewed.
- Revisit Accountable/Mento/Re/M0/DOLA/USDD capacity semantics only with route-specific docs and denominators.
