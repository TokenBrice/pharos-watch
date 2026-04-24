# Data Pipeline Audit Plan - 2026-04-24

## Scope

Audit Pharos data collection and processing for data correctness, accuracy, and user-facing freshness clarity.

## Assumptions

- Prefer surgical fixes with strong local validation over broad pipeline rewrites.
- Treat the current documented two-source supply model as intentional: DefiLlama primary, CoinGecko/supplemental fallback, no manual supply overrides.
- Commit each coherent improvement once tests pass.

## Success Criteria

- Identify concrete correctness or clarity gaps with file-level evidence.
- Implement only high effort/reward fixes that reduce stale, malformed, or ambiguous data exposure.
- Add or update tests/docs for changed API behavior.
- Leave the worktree clean after committed slices.

## Initial Opportunity Queue

1. Add freshness headers to historical supply-derived public endpoints that currently return array payloads without `_meta`.
2. Reconcile specialist-agent findings against the current code and keep only minimal, verifiable fixes.
3. Stop when remaining findings are speculative, high-risk, or low return for this pass.

## Validation Plan

- Targeted Vitest suites for touched API handlers.
- Relevant docs/checks when API contract text changes.
- `npm run test:merge-gate` before final handoff if deploy-impacting changes are committed.
