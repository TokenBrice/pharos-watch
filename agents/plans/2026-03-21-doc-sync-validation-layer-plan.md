# 2026-03-21 Doc Sync Validation Layer Plan

## Objective

Add a small validation layer that catches factual drift between code and documentation for high-risk metric docs, without introducing generated fragments, AST extraction, or source-code injection into docs/TSX.

This layer should complement the existing agent-authored documentation workflow, not replace it.

## Why This Approach

The repo already succeeds with narrow sync guards:

- `scripts/check-doc-counts.mjs` for count drift
- `scripts/check-cron-schedule-sync.ts` for cron drift

The same pattern fits metric documentation better than a general code-to-doc extraction system:

- long-form methodology prose should stay human/agent-authored
- exact values should be machine-validated
- validation should fail fast in CI when docs drift
- docs should not gain generated partials or injection markers

## Non-Goals

- No `docs/_generated/`
- No markdown fragment injection
- No edits to `src/app/methodology/methodology-sections.tsx`
- No generic AST evaluator
- No attempt to auto-generate rationale, examples, or narrative explanations

## Initial Scope

Phase 1 should cover only high-value, low-ambiguity facts that are already documented as exact values.

### 1. Methodology version sync

Validate current-version labels in:

- `docs/report-cards.md`
- `docs/dews.md`
- `docs/pricing-pipeline.md`
- `docs/stability-index.md`
- `docs/redemption-backstops.md`
- `docs/mint-burn-flows.md`

Against canonical version modules in:

- `shared/lib/safety-score-version.ts`
- `shared/lib/depeg-dews-version.ts`
- `shared/lib/pricing-pipeline-version.ts`
- `shared/lib/stability-index-version.ts`
- `shared/lib/redemption-backstop-version.ts`
- `shared/lib/mint-burn-flow-version.ts`

### 2. Report-cards exact formula values

Validate in `docs/report-cards.md`:

- overall methodology version
- dimension weights
- peg multiplier exponent
- no-liquidity penalty
- grade thresholds

Against:

- `shared/lib/report-cards.ts`
- `shared/lib/safety-score-version.ts`

### 3. Depeg threshold table

Validate in `docs/depeg-detection.md`:

- USD threshold
- non-USD threshold
- confirmation supply threshold
- pending min age
- pending expiry
- secondary threshold ratio
- primary price max age
- extreme move threshold
- DEX freshness
- DEX depeg TVL threshold

Against:

- `worker/src/lib/constants.ts`

### 4. DEWS exact weights and current version

Validate in `docs/dews.md`:

- current methodology version
- signal weights
- threat-band numeric ranges

Against:

- `worker/src/lib/dews.ts`
- `shared/lib/classification.ts`
- `shared/lib/depeg-dews-version.ts`

Note: threat-band colors should be checked only if the doc states exact hex values.

### 5. Liquidity score component weights

Validate in `docs/dex-liquidity.md`:

- TVL depth weight
- volume activity weight
- pool quality weight
- durability weight
- pair diversity weight
- durability sub-component weights

Against:

- `worker/src/cron/dex-liquidity/pool-helpers.ts`
- `shared/lib/liquidity-score-version.ts`

### 6. Worker/API enforced limits

Validate in `docs/worker-and-api-limits.md`:

- public API rate limit
- feedback rate limit
- circuit open threshold
- circuit probe interval
- cron trigger count only if already sourced from existing cron metadata

Against:

- `worker/src/handlers/http.ts`
- `worker/src/api/feedback.ts`
- `worker/src/lib/circuit-breaker.ts`
- `shared/lib/cron-jobs.ts`

## Out of Scope for Phase 1

- `docs/api-reference.md` example payload version strings
- migration-schema documentation
- broad prose consistency checks
- changelog/timeline completeness
- validation of claims that are intentionally qualitative
- files whose wording changes too often to support stable parsing

Those can be added later only if a concrete drift pattern appears.

## Recommended Implementation Shape

Use one new script:

- `scripts/check-doc-sync.ts`

Run it with:

- `tsx scripts/check-doc-sync.ts`

Add package script:

- `"check:doc-sync": "tsx scripts/check-doc-sync.ts"`

Add it to the shared validate gate after:

- `npm run check:cron-sync`
- `npm run check:doc-counts`

Recommended ordering in `package.json` / CI:

1. `check:cron-sync`
2. `check:doc-counts`
3. `check:doc-sync`

This keeps all doc-verification gates grouped together.

## Script Design

Keep the script explicit and table-driven, similar to `check-doc-counts.mjs`.

### Inputs

- raw markdown from target docs
- imported canonical constants/version labels from TS modules
- small extractor helpers for specific docs

### Output behavior

- exit `0` when all checks pass
- exit `1` on any mismatch
- print a concise failure per mismatch
- print the expected canonical value and the value found in docs
- fail when an expected pattern is missing, unless the check is marked optional

### Internal structure

Suggested sections:

1. Load docs
2. Resolve canonical values from code
3. Run doc-specific checks
4. Aggregate failures
5. Print remediation summary

Suggested helper model:

```ts
interface CheckFailure {
  file: string;
  label: string;
  expected: string | number;
  found: string | number | null;
  detail?: string;
}
```

## Parsing Strategy

Prefer narrow, doc-specific parsing over a generic markdown parser.

Examples:

- methodology version:
  - regex on `Current methodology version`
  - regex on `## Overall Grade (vX.Y)` for `docs/report-cards.md`
- simple numeric tables:
  - regex row match by constant label
- exact weights:
  - regex row match by component/signal name

Avoid over-generalization. Each supported doc should have its own small parser function when needed.

## Canonical Value Strategy

Prefer direct imports for stable exported values:

- version labels from `shared/lib/*-version.ts`
- DEWS weights/bands from `worker/src/lib/dews.ts` if exported
- threat-band labels/colors from `shared/lib/classification.ts` if needed

Prefer direct code parsing only when the value is not exported and introducing an export would be unnecessary churn.

For Phase 1, modest targeted source parsing is acceptable for:

- non-exported depeg threshold literals in `worker/src/lib/constants.ts`
- non-exported circuit-breaker constants in `worker/src/lib/circuit-breaker.ts`

If a value becomes important across multiple consumers, promote it to an export instead of duplicating parsing logic.

## Recommended Small Refactors Before or During Implementation

These are optional but useful if they reduce script fragility:

### 1. Export DEWS weights

Current DEWS weights live in a private `WEIGHTS` object inside `worker/src/lib/dews.ts`.

Recommended change:

- export a read-only `DEWS_SIGNAL_WEIGHTS`

Reason:

- lets docs and tests consume the same canonical values
- avoids regex parsing internal code

### 2. Export circuit-breaker thresholds

Current values are private constants in `worker/src/lib/circuit-breaker.ts`.

Recommended change:

- export `CIRCUIT_OPEN_THRESHOLD`
- export `CIRCUIT_PROBE_INTERVAL_SEC`

Reason:

- these are already documented as public repo-enforced limits
- exporting them reduces validator brittleness

### 3. Export depeg thresholds only if reuse expands

Do not refactor `worker/src/lib/constants.ts` solely for the validator unless it materially improves clarity. The current file is already the source of truth and easy to parse narrowly.

## Failure Message Examples

Good failure output should look like:

```text
FAIL docs/report-cards.md — safety methodology version: found v5.8, expected v5.9
FAIL docs/dews.md — signal weight "yield": found 0.10, expected 0.05
FAIL docs/worker-and-api-limits.md — circuit probe interval: found 15 min, expected 30 min
```

At the end:

```text
3 doc sync check(s) failed.
Update docs to match code or change the canonical source intentionally.
```

## Verification

Implementation should be considered complete only when all of the following pass:

- `npm run check:cron-sync`
- `npm run check:doc-counts`
- `npm run check:doc-sync`
- `npm run lint`
- `npm test`

If the script is added to the validate gate, also update:

- `docs/testing.md`

Potentially also:

- `docs/scripts.md` if that doc enumerates developer/CI scripts

## Rollout Plan

### Phase 1

Land the validator with the six scope areas above.

### Phase 2

After one or two real drift incidents, evaluate whether to add:

- `docs/api-reference.md` exact limit/version checks
- pricing pipeline source-weight checks
- additional methodology docs

Only add checks for facts that demonstrably drift.

## Acceptance Criteria

1. The repo gains one new small validation script, not a new doc-generation subsystem.
2. Known exact-value drift in the scoped docs is detected automatically.
3. The validator uses explicit code-owned sources of truth.
4. The validator does not modify files; it only reports mismatches.
5. The validator integrates into the existing validation gate cleanly.
6. Narrative documentation remains agent-authored and manually readable.

## Recommendation

Implement this plan instead of the full code-to-doc extraction design.

That gives the project the missing safety net:

- factual sync for exact values
- low maintenance cost
- no generated-doc complexity
- no TSX injection risk

It matches the repo's current quality-control style and should materially improve documentation reliability without turning docs into another build artifact.
