# Area lane: apply a verified backlog (write mode)

Your cwd is a worktree of the slim pass's integration branch. Read `AGENTS.md` (root rules apply in full) and, for every file you touch, run `npm run agent:route -- --file <path>` and read the returned anchors and scoped `AGENTS.md`. Read `docs/testing.md` sections "Test-lane gate protocol", "Test evidence rules" and "Anti-creep" before deleting or merging anything.

Input: your area manifest, produced by the finder → verifier → backlog pipeline. Each row carries a `verdict` of CONFIRMED or PARTIAL; for PARTIAL, `corrected_scope`/verify reason override the finder's scope. Findings were made against an older tree: re-verify every row against the tree you will edit and skip (with a one-line reason) anything that no longer applies.

Actions: MERGE (move the unique cases into the named target file in the same Vitest project, delete the source file), DELETE (tautology/duplicate/retired), TRIM (remove the named redundant cases or rows), DEPIN (replace an exact curated-data pin with the named derived invariant), CONVERT (move a source/doc/YAML text check into the named owner — ESLint rule, existing `scripts/ci/check-*.ts` guard or doc-sync — or delete it when that owner already enforces it), SPEEDUP (same assertions, cheaper setup).

Hard rules:

- Never remove the last PR-tier coverage of a protected class: fail-closed/fail-open gates; data-integrity rules R1–R8 (`docs/architecture.md` ADR-28..35); security/auth/origin boundaries; SQL safety; public API response contracts/schemas; persistence/migration contracts; money/supply arithmetic; the only test of a production branch. When in doubt, keep the case.
- MERGE moves cases intact (assertions unchanged); merged files must share the Vitest project and environment and compatible `vi.mock` setups — if they do not, skip and say why. Never create a new test file.
- Deleting or renaming a test file: update every registry that names it (`scripts/lib/critical-test-files.mts`, `scripts/lib/critical-coverage.mjs` ownership, `scripts/lib/provider-resilience-registry.mjs`, `docs/doc-ownership.json` testOwnership, docs/skills that cite it) in the same change, and run `npm run check:critical-coverage-completeness` plus `npx vitest run scripts/__tests__/doc-ownership-registry.test.ts`. A deletion of protected behaviour names the surviving test (path and exact title) in the report, per `docs/testing.md` "Test evidence rules".
- No production-code change except removing an export that only a deleted test used (then `npm run check:unused-code` must stay green).
- Do not commit, push or create branches/worktrees; do not touch `agents/`. Never apply the `test-budget-override` label (owner-only); if the corpus budget blocks you, trim or retire tests or report it.

Validate: every touched and target test file (`npx vitest run …`), `npm run check:critical-coverage-completeness`, `npm run check:unused-code`, the typechecks the touched packages need, `npx eslint <files>`, `git diff --check`.

Report (≤ 600 words): item id → applied or skipped (reason); files deleted/merged; cases and LOC removed; protected-behaviour deletions with their surviving test; commands and results; anything the lead must decide.
