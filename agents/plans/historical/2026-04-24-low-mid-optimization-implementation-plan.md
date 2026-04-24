# 2026-04-24 Low/Mid Optimization Implementation Plan

## Assumptions

- No production data-source, methodology, scoring, or API shape changes are intended.
- Accessibility fixes should preserve the current visual design unless the existing behavior is actively hostile to keyboard or touch users.
- Validation scripts should fail on invalid catalog structure before generated artifacts or runtime code consume it.

## Plan

1. Record the reviewer-backed scope in `/agents`.
2. Patch UX/accessibility and frontend query/prefetch behavior.
3. Patch Worker/API runtime cleanup, CORS exposure, and conditional cache handling.
4. Patch shared data validation and CI/tooling guardrails.
5. Run focused local validation, then `npm run test:merge-gate`.
6. Spawn final GPT-5.5 high validation agents against the completed diff and address only verified findings.

## Implementation Checklist

- [x] Sortable headers use button controls.
- [x] Mobile touch targets and mobile filter visibility are corrected.
- [x] Stablecoin table rows no longer expose nested keyboard link semantics and virtual rows are memoized.
- [x] Query builders propagate cancellation signals.
- [x] Hover prefetch timers are cleaned up and duplicate pending prefetches are ignored.
- [x] Rate-limit prune work is flushed for routed returns and API-key usage timestamps update only after successful writes.
- [x] CORS exposes `Retry-After`; manual digest IDs use `crypto.randomUUID()`.
- [x] `/_site-data` bypasses Pages cache for conditional requests.
- [x] Stablecoin IDs, dependency references, reserve references, and contract deployments receive stricter validation.
- [x] Deploy-impact and validation-contract guardrails cover critical coverage runner drift.
- [x] Focused tests, Worker typecheck, data checks, merge gate, and subagent validation pass.

## Validation Note

`npm run test:merge-gate` was first run while the optimization diff was uncommitted, so the local merge-gate script reported zero changed files because it compares committed refs. The equivalent deploy-impact command set was run directly against the uncommitted diff: `validate:prebuild`, `build`, `seo:check`, `test:noncritical`, `coverage:critical`, Worker typechecks, focused tests, data checks, and `git diff --check`. After the branch gained the focused chains harbor contrast commit, `npm run test:merge-gate` was rerun and passed for that committed two-file diff.
