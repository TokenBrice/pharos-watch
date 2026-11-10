# Adversarial verification of slim-pass findings (read-only)

A finder reviewed Pharos test files and proposed trims. Verify each finding independently against the code; you did not write it and it is not presumed correct. Work read-only (no npm, npx, vitest, tsc, builds).

Background: Pharos is a stablecoin analytics dashboard (Next.js static export + Cloudflare Worker + D1). The pass aims to cut CI wall time without losing detection. The `worker` and `src` Vitest projects isolate every file in its own process (re-importing its module graph); `node` runs `isolate: false`; `worker-shared` is the non-isolated worker pilot selected by `EXECUTABLE_TEST_PROJECTS` in `scripts/lib/critical-ownership.mts`.

Protected classes — a finding that removes the last coverage of any of these must be REJECTED: fail-closed/fail-open gates; data-integrity rules R1–R8 (`docs/architecture.md` ADR-28..35); security/auth/origin boundaries; SQL safety; public API response contracts/schemas; persistence/migration contracts; money/supply arithmetic; the last test exercising a production branch.

## How to verify each action

- DELETE / TRIM: open the cited covering test(s) and confirm they assert the same behaviour through the same production path with an equal-or-stronger assertion, or confirm a true tautology (asserts a mock's own return or a constant copied from source). Missing or weaker cover → PARTIAL or REJECTED.
- MERGE: confirm the target file exists, exercises the same production module, belongs to the same Vitest project and environment (worker vs worker-shared vs node vs src/jsdom), and that file-level `vi.mock` setups are compatible — incompatible mocks make the merge unsafe, say so. Unique cases must survive; merges that only move code are fine.
- DEMOTE: confirm the cost is real (spawn, workerd, full-registry evaluation, migration replay matrices, large loops) and that the named cheap PR-tier guard exists; if the nightly tier is red or absent, the case stays on the PR tier → PARTIAL naming what must change.
- CONVERT: confirm the check is source/doc/YAML text inspection and that the named receiving owner (ESLint rule, `scripts/ci/check-*.ts` guard, doc-sync) exists and runs for those files.
- DEPIN: confirm the pin is on curated/registry data that changes in routine data PRs (not a test-owned fixture) and that a stronger invariant is available.
- SPEEDUP: confirm the stated cost driver exists as described and that the cheaper setup keeps every assertion.

## Verdicts

CONFIRMED (as stated); PARTIAL (valid, but scope, target or numbers must change — give `corrected_scope`); REJECTED (wrong or unsafe — say why). Be strict; do not rubber-stamp. Keep `reason` under 350 characters.

Return JSON with one verdict per finding id, in the same order, matching the batch's ids:

```json
{"batch": "<same batch>", "verdicts": [{"id": "<finding id>", "verdict": "CONFIRMED|PARTIAL|REJECTED", "corrected_scope": "", "reason": ""}]}
```
