# Test-value finder pass (read-only)

You review one batch of Pharos test files. Pharos is a stablecoin analytics dashboard (Next.js static export + Cloudflare Worker + D1). This phase produces a plan; nothing is implemented here, so precision beats volume. The orchestrator supplies the batch list — review every listed file. Apply the [rubric](rubric.md): protected classes, action definitions, nightly-tier limits and project costs.

## Rules

- Read-only: file reading, search and small read-only scripts; no npm, npx, vitest, tsc or builds.
- Production code lives in `src/`, `worker/src/`, `worker/scripts/`, `shared/lib/`, `shared/types/`, `functions/`, `scripts/`; tests are `*.test.ts(x)` files, either under `__tests__/` or colocated with the owning module. Helpers live in `shared/test-utils/`, `worker/src/test-helpers/`, `src/test-utils/` and siblings named `*.test-support.ts`.
- Tests that pin curated data (exact counts, rosters, addresses, digests, byte sizes, version strings) break routine data PRs and cause re-runs: prefer DEPIN.
- Never propose DEMOTE for a file the rubric's safety net protects; propose SPEEDUP. If a `ci:nightly-red` issue is open, defer every DEMOTE.

## Evidence Standard

- For DELETE/MERGE/TRIM answer the last-owner question: search for other tests exercising the same exported function or branch, and cite path plus test name of the covering test, or explain precisely why the case cannot fail independently (tautology).
- Read the production code under test before judging. Prefer fewer, high-confidence findings; mark confidence honestly.
- Estimate `cases_removed` (static `it`/`test` count, counting each `.each` row group as one) and `loc_removed`.

## Output

Return one JSON object. List only non-KEEP findings, highest value first (whole-file DELETE/MERGE and SPEEDUP of heavy files first, cap ~40 per batch); keep each `evidence` under 450 characters. `patterns` holds systemic issues seen across the batch (max 8, one sentence each); `speed_notes` holds concrete cost hotspots (max 8). `id` is stable within the batch: the verifier returns one verdict per id.

```json
{"batch": "<batch name>", "files_reviewed": 0, "keep_count": 0,
 "findings": [{"id": "", "file": "", "action": "DELETE|MERGE|TRIM|DEPIN|CONVERT|DEMOTE|SPEEDUP",
   "scope": "", "cases_removed": 0, "loc_removed": 0, "target": "", "evidence": "",
   "risk": "low|medium|high", "confidence": "high|medium|low"}],
 "patterns": [], "speed_notes": []}
```
