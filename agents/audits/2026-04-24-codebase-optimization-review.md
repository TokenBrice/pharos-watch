# 2026-04-24 Codebase Optimization Review

## Scope

Five GPT-5.5 high-reasoning review agents audited the repository for low and medium effort opportunities across UX/accessibility, frontend data performance, Worker/API runtime behavior, shared data integrity, and test/tooling maintainability.

## Success Criteria

- Implement the accepted low and medium effort opportunities without changing product methodology or data-source semantics.
- Keep changes surgical and aligned with existing components, hooks, Worker helpers, and validation scripts.
- Add or update focused tests where behavior or guardrails change.
- Validate with targeted local checks, `npm run test:merge-gate`, and a final independent subagent review of the resulting diff.

## Accepted Opportunities

### UX And Accessibility

- Convert sortable table headers from focusable table cells into real button controls while preserving `aria-sort`.
- Increase mobile touch targets for compact help and navigation controls without changing desktop density.
- Remove row-level keyboard-link behavior from stablecoin table rows so nested links and pinned controls own keyboard focus.
- Memoize stablecoin virtual rows and stabilize parent navigation callbacks to reduce avoidable row work.
- Expose Peg filters in the mobile filter panel.
- Give longform scrollspy pills and API reference mobile navigation a mobile-safe hit target.
- Add a minimum table width to the chains leaderboard so numeric columns keep their scan pattern on narrow screens.
- Keep the chains nautical chart annotations and logos readable on the dark scene in both light and dark themes.
- Improve active upcoming-phase pill contrast in light mode.

### Frontend Data And Runtime Performance

- Pass TanStack Query cancellation signals through shared API query builders.
- Clean up stablecoin hover prefetch timers on unmount and avoid scheduling duplicate pending prefetches.

### Worker/API Runtime

- Ensure rate-limit prune promises are flushed through `ctx.waitUntil()` for early routed returns.
- Avoid suppressing API-key usage writes when the D1 write fails.
- Expose `Retry-After` through CORS for rate-limited clients.
- Preserve conditional request behavior for `/_site-data` by bypassing the Pages cache path when validators are present.
- Use `crypto.randomUUID()` for manual admin digest request IDs.

### Shared Data Integrity

- Reuse a stablecoin ID schema for active catalog IDs and canonical order entries.
- Validate dependency and reserve `coinId` references against known stablecoin IDs in `check:stablecoin-data`.
- Validate contract deployment chain keys, duplicate deployment entries, and EVM address shape in `check:stablecoin-data`.

### Tooling And CI Maintainability

- Classify critical coverage runner changes as deploy-impacting guardrail changes.
- Add a root Worker typecheck script and use package scripts in validation contracts.
- Add CI parity coverage for critical coverage baseline entries.

## Reclassified Out Of This Pass

- Centralizing all stablecoin catalog source descriptors is useful, but it touches data ingestion contracts and generated artifact expectations across several commands. It should be handled as a dedicated catalog-source model change.
- Deferring lower-homepage chart hydration until viewport entry needs browser-performance validation and is easy to overfit; it is better as a focused rendering-performance pass.
- Debouncing homepage search URL writes changes observable browser-history timing and should be paired with dedicated interaction tests.
- Method-level API key mutation metadata is worthwhile, but it crosses route metadata and admin-auth policy shape; this pass keeps the current route-level contract.
- Archive retention rules for `/agents` process files are process policy, not code behavior. They belong in a separate repo-hygiene decision.

## Validation Plan

- Focused unit/component tests for query builders, table behavior, Worker CORS/admin/API-key behavior, site-data proxy behavior, and deploy-change classification.
- Data/tooling checks: `npm run check:stablecoin-data`, critical coverage parity tests, Worker typecheck.
- Full pre-push gate: `npm run test:merge-gate`.
- Final GPT-5.5 high subagent validation of the diff with explicit accept/reject handling.
