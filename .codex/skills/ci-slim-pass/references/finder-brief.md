# Test-value finder pass (read-only)

You review one batch of Pharos test files. Pharos is a stablecoin analytics dashboard (Next.js static export + Cloudflare Worker + D1). This phase produces a plan; nothing is implemented here, so precision beats volume. The orchestrator supplies the batch list — review every listed file.

## Rules

- Work read-only from the repository: no npm, npx, vitest, tsc or builds. Read tools and small read-only scripts only.
- Production code lives in `src/`, `worker/src/`, `worker/scripts/`, `shared/lib/`, `shared/types/`, `functions/`, `scripts/`; tests are `*.test.ts(x)` files, either under `__tests__/` or colocated with the owning module. Helpers live in `shared/test-utils/`, `worker/src/test-helpers/`, `src/test-utils/` and siblings named `*.test-support.ts`.
- Per-file overhead dominates CI: the `worker` and `src` Vitest projects isolate files in their own process, so each file re-imports its module graph; the `node` project and the classified `worker-shared` pilot run `isolate: false`, and `node-isolated` keeps the node exceptions (see `EXECUTABLE_TEST_PROJECTS` in `scripts/lib/critical-ownership.mts` and the project list in `vitest.config.mts`). A file in a non-isolated project does not pay the fork cost, but it also must keep the eligibility rules (no `vi.mock`/hoisted module factories, no unrestored globals or env writes) that put it there. Deleting or merging whole files, and dropping heavy imports, saves more than deleting single cases.
- Files that open `shared/test-utils/latest-schema-sqlite.ts` restore the per-run migrated template built by `scripts/test/prepare-latest-schema-sqlite-template.ts`; they replay migrations in-process only on a cache miss (or when a migration-inventory test uses the uncached creator). Tests that pin curated data (exact counts, rosters, addresses, digests, byte sizes, version strings) break routine data PRs and cause re-runs.

## Protected classes

Never propose DELETE/TRIM for these unless an equal-or-stronger test elsewhere provably covers the same behaviour — cite path and exact test title:

- fail-closed/fail-open gates; data-integrity rules R1–R8 (`docs/architecture.md` ADR-28..35)
- security/auth/origin/access boundaries, secret handling, SQL safety
- public API response contracts/schemas, persistence/migration contracts, money/supply arithmetic
- the only test exercising a production branch or exported behaviour

## Actions (pick one per finding, whole file or partial scope)

- KEEP — do not list; count it.
- DELETE — tautological (asserts what a mock returns), restates a constant/config literal, tests trivial wiring/re-exports, tests a retired feature, or is fully duplicated by another test (cite it).
- MERGE — overlaps another file; fold the surviving unique cases into the named target file (cuts per-file import overhead).
- TRIM — keep the file but remove named redundant cases, describe blocks or table rows (for example repeated rows hitting one branch; keep boundary rows).
- DEPIN — brittle exact pin on curated/registry data; replace it with an invariant assertion (name the invariant).
- CONVERT — source-text or doc-text inspection (readFileSync of `.ts`/`.md`/`.yml` then regex or includes) that belongs in an ESLint rule, an existing `scripts/ci/check-*.ts` guard, doc-sync, or nowhere.
- DEMOTE — valuable but expensive and rarely failing (full-registry evaluation, workerd/wrangler spawn, migration-replay matrices, whole-tree scans, property/fuzz loops); move it to the nightly full-suite tier and name the cheap test that still guards the contract on PRs. A tier that is red or does not exist yet keeps the case on the PR tier and the finding deferred.
- SPEEDUP — keep every case but make the file cheaper: imports the full registry/catalog or a huge module graph for one assertion; SQLite where a pure function suffices; real timers/sleeps; repeated heavy setup in `beforeEach` that could be `beforeAll`; giant inline fixtures. Say exactly what to change.

## Evidence standard

- For DELETE/MERGE/TRIM answer the last-owner question: grep for other tests exercising the same exported function or branch, and cite path plus test name of the covering test, or explain precisely why the case cannot fail independently (tautology).
- Read the production code under test before judging. Prefer fewer, high-confidence findings; mark confidence honestly.
- Estimate `cases_removed` (static `it`/`test` count, counting each `.each` row group as one) and `loc_removed`.

## Output

Return JSON matching `finder-schema.json`. List only non-KEEP findings, highest value first (whole-file DELETE/MERGE and SPEEDUP of heavy files first, cap ~40 per batch); keep each `evidence` under 450 characters. `patterns` holds systemic issues seen across the batch (max 8, one sentence each); `speed_notes` holds concrete cost hotspots (max 8).
