# Slim-pass rubric (shared by every phase brief)

Every finder, verifier, lane, reviewer and long-pole brief applies this page; a brief adds only its role's delta. The named source files and `docs/testing.md` win over it.

## Protected Classes

Never remove the last PR-tier coverage of any of these; when unsure, keep the case:

- fail-closed/fail-open gates; data-integrity rules R1–R8 (`docs/architecture.md` ADR-28..35)
- security/auth/origin/access boundaries, secret handling, SQL safety
- public API response contracts/schemas, persistence/migration contracts, money/supply arithmetic
- the only test exercising a production branch or exported behaviour

Removal is allowed only when an equal-or-stronger test provably covers the same behaviour through the same production path: cite its path and exact test title.

## Actions

- **KEEP** — count it, do not list it.
- **DELETE** — tautological (asserts what a mock returns), restates a constant/config literal, tests trivial wiring/re-exports or a retired feature, or is fully duplicated by a cited test.
- **MERGE** — overlaps another file: move the unique cases intact (assertions unchanged) into the named target, which must share the Vitest project, environment and compatible `vi.mock` setup; then delete the source file. Never create a test file.
- **TRIM** — keep the file; remove named redundant cases, describe blocks or table rows. Keep boundary rows.
- **DEPIN** — replace an exact pin on curated/registry data that routine data PRs change with the named derived invariant. Not for a test-owned fixture.
- **CONVERT** — source/doc/YAML text inspection moves into its named owner (ESLint rule, an existing `scripts/ci/check-*.ts` guard, doc-sync), or is deleted when that owner already enforces it.
- **DEMOTE** — valuable, expensive and rarely failing (full-registry evaluation, workerd/wrangler spawn, migration-replay matrices, whole-tree scans, property/fuzz loops): move to the nightly tier and name the PR-tier test or guard that still proves the behaviour.
- **SPEEDUP** — same assertions, cheaper setup: drop a full-registry or huge-graph import used for one assertion, a pure function instead of SQLite, fake timers, `beforeAll` for repeated heavy setup, a smaller fixture with the same branch coverage.

## Nightly Tier

[Nightly test tier](../../../../docs/testing.md#nightly-test-tier) and `scripts/lib/nightly-test-tier.mts` own it. A demoted file is `*.nightly.test.ts(x)` with the header `// Nightly tier: PR coverage retained by <repo-relative path>`; a demoted case carries the `nightly` tag. `npm run check:test-tier` rejects a demotion inside the PR-tier safety net: the always-run and critical test lists (including any test importing an enrolled critical source), provider-resilience tests, declared test ownership and the docs-owner commands. Those files are sped up in place instead. Nothing moves while a `ci:nightly-red` issue is open.

## Vitest Projects And File Cost

`EXECUTABLE_TEST_PROJECTS` in `scripts/lib/critical-ownership.mts` and `vitest.config.ts` own the project list; [Worker shared](../../../../docs/testing.md#worker-shared-non-isolated-project) owns the non-isolated worker rules. `worker` and `src` isolate every file in its own process, so each file re-imports its module graph: deleting or merging whole files and dropping heavy imports saves more than deleting single cases. `node` and `worker-shared` run `isolate: false`; a file there pays no fork cost but must stay eligible (no `vi.mock`/hoisted module factories, no unrestored globals or env writes). `node-isolated`, `worker-threads` and `WORKER_SHARED_ISOLATED_OVERRIDES` hold the exceptions.

Files that open `shared/test-utils/latest-schema-sqlite.ts` restore a per-run migrated template and replay migrations only on a cache miss.

## Retiring Or Renaming A Test File

`npm run tests:retire -- <test paths> [--replacement <path>]` prints the registry edits a deletion needs, then `--write` applies them ([Retiring tests](../../../../docs/testing.md#retiring-tests)); `RETIREMENT_REGISTRIES` in `scripts/maintenance/retire-tests.ts` is the enrolled list. Apply its hand-fix list and fill its evidence table in the same commit. A refusal means a protected or last-owner path: supply a replacement or keep the file, never a waiver.

## Corpus Budget And Labels

[Test corpus budget](../../../../docs/testing.md#test-corpus-budget): ceilings only move down. `npm run check:test-corpus-budget -- --base=origin/main` is the authoring check and `npm run test-corpus:update` lowers ceilings after a trim. Never apply the owner-only `test-budget-override` label.

## Lane Hygiene

Write lanes and fix lanes work in a worktree of the wave's integration branch: read `AGENTS.md`, route each touched file with `npm run agent:route -- --file <path>`, make the smallest change, keep `git diff --check` clean, and do not commit, push, create branches/worktrees or touch `agents/`. No production-code change except removing an export only a deleted test used. Read-only roles run no npm, npx, vitest, tsc or builds: file reading, search and small read-only scripts only.
