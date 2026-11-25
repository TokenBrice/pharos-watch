# Area lane: apply a verified backlog (write mode)

Your cwd is a worktree of the slim pass's integration branch. Apply the [rubric](rubric.md) in full: action definitions, protected classes, nightly tier, retirement tooling and lane hygiene. Read `docs/testing.md` sections "Test-lane gate protocol", "Test evidence rules" and "Anti-creep" before deleting or merging anything.

Input: your area manifest, produced by the finder → verifier → backlog pipeline. Each row carries a `verdict` of CONFIRMED or PARTIAL; for PARTIAL, `corrected_scope`/verify reason override the finder's scope. Findings were made against an older tree: re-verify every row against the tree you will edit and skip (with a one-line reason) anything that no longer applies.

Hard rules:

- MERGE and in-place TRIM/SPEEDUP/DEPIN keep assertion strength: no `toEqual` narrowed to a subset match, no distinct fixture values collapsed, no branch check dropped. If a merge target's project, environment or mocks do not fit, skip and say why.
- DEMOTE: rename to `*.nightly.test.ts(x)` with the required header line, or tag the case `nightly`; the PR-tier guard you name must exist before the move. `npm run check:test-tier` must pass.
- Deleting or renaming a test file goes through `npm run tests:retire`, never hand-edited registries alone. A deletion of protected behaviour names the surviving test (path and exact title) in the report, per `docs/testing.md` "Test evidence rules".
- If the corpus budget blocks you, trim or retire tests or report it.

Validate: every touched and target test file (`npx vitest run …`), `npm run check:critical-coverage-completeness`, `npm run check:test-tier`, `npm run check:provider-resilience`, `npm run check:unused-code`, `npx vitest run scripts/__tests__/doc-ownership-registry.test.ts` when a test path changed, the typechecks the touched packages need, `npx eslint <files>`, `git diff --check`.

Report (≤ 600 words): item id → applied or skipped (reason); files deleted/merged/demoted; cases and LOC removed; protected-behaviour deletions with their surviving test; commands and results; anything the lead must decide.
