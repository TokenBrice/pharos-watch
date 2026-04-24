# Repo-Wide Strategic Cleanup Follow-up Plan

Date: 2026-04-24
Scope: follow-up cleanup after `agents/plans/2026-04-24-website-maintainability-cleanup-plan.md` lands. Whole repository is in scope: `shared/`, `worker/`, `functions/`, `scripts/`, docs/process files, tests, data tooling, and frontend only where it is unavoidable for cross-surface contracts.

## Assumptions

- The parent website cleanup plan owns active frontend-only cleanup under `src/app`, `src/components`, `src/hooks`, `src/lib`, `src/styles`, and static website assets.
- This plan should not be executed until the parent website cleanup either lands or explicitly drops the overlapping frontend slices.
- The goal is maintainability, ownership clarity, validation strength, and drift reduction. Product behavior, API contracts, scoring methodology, cron cadence, and runtime semantics should remain unchanged unless a cleanup reveals a real bug and the owner approves that bug fix separately.
- Execution should be staged into independently reviewable slices. Do not batch large data moves, worker refactors, and validation-script changes in one commit.
- Any score-affecting or methodology-affecting change is out of scope for cleanup unless it is a separately documented bug fix with explicit score-impact review.

## Success Criteria

- Cross-runtime source-of-truth boundaries are easier to audit: shared endpoint metadata, generated integration artifacts, stablecoin data sources, and worker route bindings have fewer hand-maintained duplicates.
- Worker/admin/cron code becomes easier to review through exact-preserving decomposition of the largest mixed-responsibility modules.
- Test maintenance improves without weakening coverage: fixture builders and helper ownership become clearer, while focused test names remain discoverable.
- Validation scripts become more consistent and less duplicated without changing the deploy gate surface.
- Each slice has a focused validation path plus an explicit full-gate escalation rule.

## Current State Evidence

- Worktree state at plan time: `main...origin/main`, with the parent-owned untracked file `agents/plans/2026-04-24-website-maintainability-cleanup-plan.md`.
- The website plan reports current frontend guardrails passing: `check:unused-code`, `check:hotspot-ratchet`, `check:shared-cycles`, and `check:duplicate-exports`.
- The website plan already owns query-contract fixes, frontend hotspot decomposition, coverage/portfolio cleanup, taxonomy descriptor cleanup, filter/search primitives, chart primitives, static frontend content extraction, and opportunistic hook moves.
- Repo docs define the main architecture seams:
  - `shared/lib/api-endpoints/**` owns endpoint metadata and path definitions.
  - `worker/src/routes/**` binds shared endpoint definitions to handlers.
  - `shared/lib/cron-jobs.ts` and `shared/lib/scheduled-runner-registry.ts` own cron metadata.
  - `scripts/**` owns CI guardrails, generated artifacts, smokes, and data tooling.
- Current largest non-website runtime/source files include:
  - `shared/lib/redemption-backstop-configs/offchain-issuer.ts`: 1139 lines.
  - `worker/src/lib/blacklist-contracts.ts`: 951 lines.
  - `worker/src/lib/mint-burn-contracts-data.ts`: 943 lines.
  - `shared/lib/api-endpoints/definitions.ts`: 785 lines.
  - `worker/src/api/audit-depeg-history.ts`: 783 lines.
  - `worker/src/cron/sync-fx-rates-helpers.ts`: 725 lines.
  - `worker/src/api/telegram-webhook.ts`: 661 lines.
  - `worker/src/cron/weekly-recap.ts`: 632 lines.
  - `worker/src/cron/detect-depegs.ts`: 624 lines.
  - `worker/src/api/mint-burn-flows.ts`: 611 lines.
- Current largest test files include:
  - `worker/src/cron/__tests__/sync-yield-data.test.ts`: 3247 lines.
  - `worker/src/cron/__tests__/sync-stablecoins.test.ts`: 2856 lines.
  - `worker/src/api/__tests__/status.test.ts`: 2737 lines.
  - `worker/src/cron/__tests__/enrich-prices.test.ts`: 2554 lines.
  - `worker/src/cron/__tests__/daily-digest.test.ts`: 1930 lines.
- Stablecoin catalog state is split only in tooling, not in data files: `shared/data/stablecoins/coins/` exists but currently has `0` per-coin JSON files, while legacy shard files total about `21070` lines.
- Generated integration artifacts are guarded, but their source catalogs are still locally hand-maintained:
  - `scripts/generate-openapi-spec.ts` has a local `endpoints` array.
  - `scripts/generate-postman-collection.ts` has local `folders` and request arrays.
  - `docs/api-reference.md` is canonical prose, and `/about/api/` renders that markdown.
  - `shared/lib/api-endpoints/definitions.ts` is the runtime route metadata source.

## Plan-wide Execution Rules

- Start by rebasing mentally and technically on the post-website-cleanup tree. Re-run `git status --short --branch` and read the final parent cleanup artifact before editing.
- Do not touch files currently modified by another agent unless the parent cleanup explicitly hands them off.
- Prefer moves/extractions over behavior rewrites. If tests fail after a move, fix the extraction rather than changing semantics.
- Keep fixture updates and generated artifact rewrites in the same slice as the source change that requires them.
- For deploy-impacting slices, run focused checks first, then `npm run test:merge-gate` after the slice is committed or with `--staged` if the owner wants pre-commit validation.

## High-priority Opportunities

### 1. Make public integration artifact catalogs share one source

Files/areas:

- `scripts/generate-openapi-spec.ts`
- `scripts/generate-postman-collection.ts`
- `shared/lib/api-endpoints/paths.ts`
- `shared/lib/api-endpoints/definitions.ts`
- `docs/api-reference.md`
- `docs/api-endpoint-authoring.md`
- `scripts/__tests__/validate-ci-parity.test.ts`
- `scripts/__tests__/classify-deploy-changes.test.ts`

Finding:

- Runtime route metadata is centralized in `shared/lib/api-endpoints/definitions.ts`, but public OpenAPI and Postman artifacts each keep separate hand-maintained endpoint/request catalogs.
- `check:openapi` and `check:postman` prove generated files match their local generators, not that the local generator catalogs still match the runtime endpoint inventory or `docs/api-reference.md`.
- The `/about/api/` route renders `docs/api-reference.md`, so humans see the docs corpus while API consumers may import a different machine-readable catalog.

Proposed implementation:

1. Add a script-owned descriptor module such as `scripts/lib/public-api-artifact-catalog.ts` that captures only the public integration artifact metadata: endpoint key, sample path params, examples, tags/folders, query examples, and whether the request is site-hosted rather than API-hosted.
2. Build descriptor paths from `API_PATHS` where possible instead of raw strings.
3. Update `generate-openapi-spec.ts` and `generate-postman-collection.ts` to consume that shared descriptor.
4. Add a focused test that compares descriptor endpoint keys/paths against the non-admin public endpoint definitions that are intended to appear in public artifacts. Explicitly allow omissions such as dynamic OG routes or admin-only routes.
5. Update `docs/api-endpoint-authoring.md` so endpoint authors know to update the artifact descriptor when a public endpoint is integration-facing.
6. Do not generate `docs/api-reference.md` from the descriptor in this pass. Keep prose canonical and use tests to catch obvious catalog omissions.

Priority:

- P1. High-value drift reduction across runtime, docs, and generated public artifacts.

Visual/runtime impact:

- Runtime impact: none intended.
- Visual impact: none intended, except `/about/api/` links continue to point at regenerated artifacts.
- Public artifact impact: expected byte changes only if the current OpenAPI/Postman output is corrected or re-ordered. Preserve output equivalence unless a drift is found and documented.

Validation:

```bash
npm test -- scripts/__tests__/validate-ci-parity.test.ts scripts/__tests__/classify-deploy-changes.test.ts
npm run check:openapi
npm run check:postman
npm run check:doc-source-paths
npm run check:verified-doc-links
npm run typecheck
```

Prerequisite cleanup-plan notes affecting execution:

- Wait for website plan slices that touch `/about/api/`, API reference rendering, or generated artifact links if any are added during implementation.
- Website plan query-contract work does not block this, but if it changes public endpoint docs or hook contracts, re-check `docs/api-reference.md` before deriving artifact expectations.

### 2. Migrate stablecoin metadata from giant legacy shards to per-coin sources

Files/areas:

- `shared/data/stablecoins/usd-major.json`
- `shared/data/stablecoins/usd-minor.json`
- `shared/data/stablecoins/non-usd.json`
- `shared/data/stablecoins/commodity.json`
- `shared/data/stablecoins/pre-launch.json`
- `shared/data/stablecoins/coins/*.json`
- `shared/data/stablecoins/coins.generated.json`
- `shared/data/stablecoins/canonical-order.json`
- `scripts/lib/stablecoin-catalog-sources.ts`
- `scripts/generate-stablecoin-per-coin-asset.ts`
- `scripts/check-stablecoin-data.ts`
- `docs/stablecoin-data.md`

Finding:

- The per-coin source directory and generator exist, but `shared/data/stablecoins/coins/` currently contains no per-coin JSON files.
- Legacy shard files remain large and hard to review, with `usd-minor.json` alone over 11000 lines.
- Current tooling already understands `legacy` plus `per-coin` source kinds, duplicate IDs, generated aggregate validation, and canonical order. This makes a staged exact-preserving migration possible without inventing new data architecture.

Proposed implementation:

1. Start with a small pilot batch of low-churn assets, for example 5 to 10 entries from `commodity.json` or pre-launch assets, and move each entry to `shared/data/stablecoins/coins/<id>.json`.
2. Run `tsx scripts/generate-stablecoin-per-coin-asset.ts` and verify `coins.generated.json` contains exactly the moved assets in deterministic order.
3. Keep `canonical-order.json` unchanged unless the source move reveals an existing ordering bug.
4. Add or adjust tests so the combined legacy plus per-coin loader preserves:
   - no duplicate IDs
   - canonical order membership
   - schema validation
   - generated aggregate freshness
5. After the pilot lands, migrate the remaining catalog by stable group in reviewable batches. Prefer 20 to 40 assets per commit rather than one repository-wide data churn commit.
6. Update `docs/stablecoin-data.md` to make per-coin files the preferred authoring path once the pilot is proven.

Priority:

- P1. High maintainability payoff with low intended runtime risk because existing tooling already supports the target shape.

Visual/runtime impact:

- Runtime impact: none intended. The combined stablecoin registry should produce the same metadata and tracked counts.
- Visual impact: none intended. Any visible diff in tracked count, stablecoin ordering, route generation, logo mapping, or report-card inputs is a blocker unless it is a separately approved data correction.

Validation:

```bash
npm run check:stablecoin-data
npm run check:doc-counts
npm test -- scripts/__tests__/stablecoin-catalog-sources.test.ts shared/lib/stablecoins/__tests__
npm run typecheck
npm run check:unused-code
```

Escalate to:

```bash
npm run build
npm run seo:check
```

when a batch moves enough metadata to affect static route generation confidence.

Prerequisite cleanup-plan notes affecting execution:

- Do not overlap with website plan slices that touch stablecoin taxonomy routes, route metadata, or static link hubs until those slices land.
- If the website plan changes stablecoin browse/taxonomy assumptions, rerun route generation and SEO checks after the first data batch.

### 3. Decompose worker admin/backfill handlers along command boundaries

Files/areas:

- `worker/src/api/audit-depeg-history.ts`
- `worker/src/api/backfill-dews.ts`
- `worker/src/api/backfill-depegs.ts`
- `worker/src/api/backfill-supply-history.ts`
- `worker/src/api/backfill-mint-burn.ts`
- `worker/src/api/mint-burn-flows.ts`
- `worker/src/api/mint-burn-flows-shared.ts`
- `worker/src/api/__tests__/audit-depeg-history.test.ts`
- `worker/src/api/__tests__/backfill-dews.test.ts`
- `worker/src/api/__tests__/backfill-depegs.test.ts`
- `worker/src/api/__tests__/mint-burn-flows.test.ts`

Finding:

- Several admin/backfill handlers mix URL parsing, dry-run/live mutation policy, D1 queries, repair/replay algorithms, response shaping, and sometimes downstream recomputation.
- `worker/src/api/audit-depeg-history.ts` is the clearest first target at 783 lines and already contains distinct repair modes: false-positive audit/delete, synthetic split repair, contradictory recovery-price repair, and PSI recomputation.
- These handlers are operationally sensitive, so cleanup should preserve endpoint behavior and isolate pure planning/execution helpers rather than rewrite SQL or repair semantics.

Proposed implementation:

1. Start with `audit-depeg-history.ts` only.
2. Extract pure and near-pure modules under an adjacent folder such as `worker/src/api/depeg-audit/`:
   - `request.ts` for query parsing and mode selection.
   - `synthetic-splits.ts` for grouping and summary helpers.
   - `contradictory-recovery.ts` for candidate selection/repair planning.
   - `psi-recompute.ts` only if the extraction is mechanical and does not conflict with existing `worker/src/lib/psi-recompute.ts`.
   - `response.ts` for result envelopes if response typing becomes clearer.
3. Keep SQL text and live mutation order in place until tests prove the extracted plan objects are equivalent.
4. Add focused tests for the extracted pure grouping/summary helpers before changing the handler shell.
5. Repeat the pattern later for `backfill-dews.ts` and `mint-burn-flows.ts`, but only one endpoint family per slice.
6. Do not change admin auth, dry-run defaults, idempotency, or response fields in cleanup commits.

Priority:

- P1 for `audit-depeg-history.ts`.
- P2 for subsequent admin/backfill handlers after the first extraction pattern is validated.

Visual/runtime impact:

- Visual impact: none.
- Runtime impact: none intended, but operational risk is medium because these endpoints can mutate D1 in live mode. Dry-run behavior and tests are mandatory.

Validation:

```bash
npm test -- worker/src/api/__tests__/audit-depeg-history.test.ts
npm run typecheck:worker
npm run check:sql-safety
npm run check:worker-boundary
```

For later endpoint families:

```bash
npm test -- worker/src/api/__tests__/backfill-dews.test.ts worker/src/api/__tests__/backfill-depegs.test.ts worker/src/api/__tests__/mint-burn-flows.test.ts
npm run typecheck:worker
```

Prerequisite cleanup-plan notes affecting execution:

- No direct website-plan dependency.
- If website query-contract work changes public depeg, mint/burn, or safety-score API consumers, confirm this slice remains admin/backfill-only and does not alter public response contracts.

### 4. Clarify worker test helper ownership and shrink the largest fixture-heavy tests

Files/areas:

- `worker/src/api/__tests__/helpers/mock-d1.ts`
- `worker/src/api/__tests__/helpers/fixtures.ts`
- `worker/src/api/__tests__/helpers/mock-fetch.ts`
- `worker/src/lib/__tests__/_helpers/stateful-d1.ts`
- `worker/src/cron/__tests__/sync-yield-data.test.ts`
- `worker/src/cron/__tests__/sync-stablecoins.test.ts`
- `worker/src/api/__tests__/status.test.ts`
- `worker/src/cron/__tests__/enrich-prices.test.ts`
- `worker/src/cron/__tests__/daily-digest.test.ts`

Finding:

- Worker test helpers live under API test directories but are imported by cron and top-level worker tests. That makes helper ownership look API-specific even when helpers are cross-worker utilities.
- Several worker tests are over 1900 lines and combine module mocks, large inline stablecoin fixtures, D1 rows, fetch mocks, and assertions in one file.
- Large tests are valuable but expensive to maintain; the cleanup should reduce fixture noise without splitting tests so aggressively that behavior coverage becomes hard to find.

Proposed implementation:

1. Create a neutral worker test helper home such as `worker/src/__tests__/_helpers/` or `worker/src/test-helpers/`. Use whichever pattern best fits existing test import conventions.
2. Move only cross-worker helpers first:
   - `mock-d1`
   - generic auth/env helpers
   - generic fetch mock helpers
   Leave endpoint-specific fixtures near endpoint tests.
3. Add fixture builders for repeated stablecoin metadata, cache rows, and D1 row shapes in the largest cron tests. Keep defaults realistic and allow narrow overrides.
4. In `sync-yield-data.test.ts`, replace repeated inline stablecoin registry mocks with named fixture factories before moving test cases.
5. Split a large test file only when there is a natural domain boundary, for example source resolution vs persistence vs degraded-mode behavior. Do not split just to reduce line count.
6. Preserve all existing test names or use clearer equivalents so failure output remains actionable.

Priority:

- P1 for moving shared helpers out of API-owned paths.
- P2 for fixture-builder extraction in each giant test file.

Visual/runtime impact:

- Runtime impact: none. Test-only changes.
- Visual impact: none.

Validation:

```bash
npm test -- worker/src/cron/__tests__/sync-yield-data.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts worker/src/api/__tests__/status.test.ts worker/src/cron/__tests__/enrich-prices.test.ts worker/src/cron/__tests__/daily-digest.test.ts
npm run typecheck:worker
npm run check:unused-code
```

Prerequisite cleanup-plan notes affecting execution:

- No direct website-plan dependency.
- If the parent plan adds or moves frontend tests only, ignore that churn. This slice should stay worker-test-only.

## Medium-priority Opportunities

### 5. Standardize cron stage progress and abort handling where jobs already expose stages

Files/areas:

- `worker/src/cron/shared/stage-contracts.ts`
- `worker/src/cron/sync-mint-burn.ts`
- `worker/src/cron/mint-burn/run-configs.ts`
- `worker/src/cron/sync-live-reserves.ts`
- `worker/src/cron/sync-live-reserves-core.ts`
- `worker/src/cron/dex-discovery/orchestrator.ts`
- `worker/src/cron/sync-fx-rates-helpers.ts`
- `worker/src/handlers/scheduled/context.ts`
- `scripts/check-cron-abort-contract.mjs`

Finding:

- `worker/src/cron/shared/stage-contracts.ts` exists as a seed contract for stage progress, abort result metadata, and handoff context.
- Several cron jobs still hand-roll abort checks, stage labels, degraded abort results, and progress metadata.
- The repo already has `check:cron-abort-contract` and docs emphasize connection/cadence constraints, so standardizing stage contracts can improve validation and observability without changing schedules.

Proposed implementation:

1. Do not mass-migrate every cron job.
2. Start with one staged job that already has progress labels and focused tests, preferably `sync-mint-burn.ts` or `sync-live-reserves.ts`.
3. Replace only equivalent abort/result/progress helpers with `returnIfCronStageAborted()`, `reportCronStage()`, and shared `CronStageContext` types.
4. Add or update tests that assert abort metadata includes the same job/stage information as before.
5. Only after one job lands cleanly, extend to `dex-discovery/orchestrator.ts` or `sync-fx-rates-helpers.ts`.
6. If a job has intentionally unique metadata, leave it alone and document why in a test or waiver rather than forcing uniformity.

Priority:

- P2. Useful observability cleanup, but lower priority than source-of-truth and test ownership cleanup.

Visual/runtime impact:

- Visual impact: none.
- Runtime impact: intended none. Medium operational risk because cron abort/degraded metadata is incident-facing.

Validation:

```bash
npm run check:cron-abort-contract
npm run check:cron-sync
npm run check:cron-connections
npm test -- worker/src/cron/__tests__/sync-mint-burn.test.ts worker/src/cron/__tests__/sync-live-reserves.test.ts worker/src/cron/dex-discovery/__tests__/sync-dex-discovery.test.ts
npm run typecheck:worker
```

Prerequisite cleanup-plan notes affecting execution:

- No direct website-plan dependency.
- If website cleanup changes status/admin display of cron metadata, coordinate before changing serialized cron result metadata.

### 6. Consolidate generated-artifact write/check boilerplate

Files/areas:

- `scripts/lib/generated-artifacts.ts`
- `scripts/generate-cemetery-dataset.ts`
- `scripts/generate-llms-txt.ts`
- `scripts/generate-openapi-spec.ts`
- `scripts/generate-postman-collection.ts`
- `scripts/build-world-map-svg.ts`
- `scripts/generate-stablecoin-per-coin-asset.ts`
- `scripts/__tests__/generate-markdown-exports.test.ts`
- `docs/scripts.md`

Finding:

- `scripts/lib/generated-artifacts.ts` already provides a shared `syncGeneratedArtifacts()` helper for check/write behavior.
- `generate-openapi-spec.ts`, `generate-postman-collection.ts`, and `build-world-map-svg.ts` still duplicate `existsSync`/`readFileSync`/`writeFileSync` check-mode boilerplate.
- The duplicate boilerplate is not large, but generated artifact checks are central to CI and prebuild, so consistent failure messages and write behavior reduce maintenance risk.

Proposed implementation:

1. Convert `generate-openapi-spec.ts` and `generate-postman-collection.ts` to use `syncGeneratedArtifacts()` after opportunity 1 or in the same generated-artifact slice.
2. Convert `build-world-map-svg.ts` only if the helper supports its single-artifact SVG use case without making the script less readable.
3. Keep `generate-stablecoin-per-coin-asset.ts` separate unless its result object semantics can be preserved cleanly.
4. Add a small helper test only if behavior changes beyond a mechanical import replacement.
5. Update `docs/scripts.md` only if failure messages or invocation semantics change.

Priority:

- P2/P3. Low-risk consistency cleanup; best paired with opportunity 1 to avoid touching generators twice.

Visual/runtime impact:

- Runtime impact: none.
- Visual impact: none.
- Generated artifact impact: none intended. Output bytes should remain identical.

Validation:

```bash
npm run check:openapi
npm run check:postman
npm run check:world-map
npm run check:llms-txt
npm run check:cemetery-dataset
npm run typecheck
```

Prerequisite cleanup-plan notes affecting execution:

- If website plan touches world-map artifacts or alt-pegs/chains static visuals, avoid `build-world-map-svg.ts` until that work lands.

### 7. Promote doc/process ownership checks from advisory to targeted validation

Files/areas:

- `docs/doc-ownership.json`
- `docs/agent-task-router.md`
- `docs/scripts.md`
- `docs/testing.md`
- `scripts/check-doc-sync.ts`
- `scripts/lib/doc-sync/checks.ts`
- `scripts/check-doc-source-paths.mjs`
- `scripts/check-verified-doc-links.mjs`

Finding:

- `docs/doc-ownership.json` is explicitly advisory. It is useful for agents, but CI does not verify that mapped docs exist, that globbed source areas still exist, or that new high-level source areas have an ownership entry.
- Existing doc checks are strong for links, source paths, counts, and methodology constants, but there is no focused ownership-manifest integrity check.
- A lightweight check would improve process reliability without forcing every source change to update docs automatically.

Proposed implementation:

1. Add a non-invasive check, for example `scripts/check-doc-ownership.mjs`, that validates:
   - every mapped doc path exists, with wildcard paths allowed only for intentional route/runbook families
   - every mapped source root exists
   - no duplicate mapping names
   - the manifest status remains `advisory`
2. Do not fail CI because a changed file lacks an ownership mapping in the first pass. That would create noisy process debt.
3. Wire the check into `validate:prebuild` only after it is deterministic and fast.
4. Update `docs/testing.md`, `docs/scripts.md`, and `docs/agent-task-router.md` with the new check.
5. Add a unit test with a tiny fixture manifest rather than testing the full repo tree only through CI.

Priority:

- P2. Good validation improvement with low product risk.

Visual/runtime impact:

- Runtime impact: none.
- Visual impact: none.

Validation:

```bash
npm test -- scripts/__tests__/doc-sync.test.ts
npm run check:doc-source-paths
npm run check:verified-doc-links
npm run validate:prebuild
```

Prerequisite cleanup-plan notes affecting execution:

- Website cleanup may update route docs or route ownership. Re-read the final `docs/doc-ownership.json` and route docs before adding any manifest integrity assumptions.

## Lower-priority / Opportunistic Opportunities

### 8. Split shared methodology/version content only when already touched

Files/areas:

- `shared/lib/pricing-pipeline-version.ts`
- `shared/lib/safety-score-version-data.ts`
- `shared/lib/yield-methodology-version.ts`
- `shared/lib/redemption-backstop-version.ts`
- `shared/lib/depeg-dews-version.ts`
- `shared/lib/blacklist-tracker-version.ts`
- `src/app/methodology/**`
- matching `docs/*-timeline.md`

Finding:

- Several version/history files are large because they contain long methodology timelines and changelog content.
- Large content files are not automatically bad. They are intentionally reviewed as historical records and are guarded by doc-sync/version checks.
- Splitting them purely for line count could increase navigation cost and methodology risk.

Proposed implementation:

1. Do not run a standalone methodology-content sharding pass.
2. When a methodology/version file is already touched for a real update, move older immutable entries into adjacent `*-history.ts` or `*-entries.ts` modules only if the split improves reviewability.
3. Preserve export names, ordering, and version labels exactly.
4. Run doc-sync and methodology tests immediately after any split.

Priority:

- P3. Opportunistic only.

Visual/runtime impact:

- Runtime impact: none intended, but score/methodology display impact is possible if ordering changes.
- Visual impact: none intended.

Validation:

```bash
npm run check:doc-sync
npm test -- src/lib/__tests__/methodology-version.test.ts shared/lib/__tests__/report-cards.test.ts
npm run typecheck
npm run build
```

Prerequisite cleanup-plan notes affecting execution:

- Website plan static content extraction may touch methodology route files. Do not split methodology content in parallel with that work.

### 9. Keep runtime registry megafiles stable unless a real ownership split is obvious

Files/areas:

- `worker/src/lib/blacklist-contracts.ts`
- `worker/src/lib/mint-burn-contracts-data.ts`
- `shared/lib/classification.ts`
- `shared/lib/api-endpoints/definitions.ts`
- `shared/lib/redemption-backstop-configs/offchain-issuer.ts`
- `shared/lib/redemption-backstop-configs/stablecoin-redeem.ts`

Finding:

- These files are large, but many are registry/configuration sources of truth where locality is valuable.
- Existing guardrails and nested `AGENTS.md` instructions emphasize not redefining labels/colors locally and preserving shared runtime-neutral logic.
- The right cleanup is not automatic sharding. Split only when there is a clear ownership boundary, repeated edit conflict, or generator-backed validation.

Proposed implementation:

1. Do not include these files in a broad "large file" cleanup pass.
2. For `blacklist-contracts.ts`, consider splitting only by event-family registry vs contract deployment list if a future blacklist coverage change makes review conflict likely.
3. For `mint-burn-contracts-data.ts`, consider chain/family shards only if `check:stablecoin-data`-style validation can prove no config loss.
4. For `classification.ts`, keep labels/colors centralized unless a generated classification registry becomes necessary.
5. For redemption backstop config files, split only along already documented route families and keep `check:redemption-backstops` as the authority.

Priority:

- P3. Guardrail note, not an immediate action.

Visual/runtime impact:

- Runtime impact: none intended if ever executed. High risk if split carelessly.
- Visual impact: none intended.

Validation:

```bash
npm run check:redemption-backstops
npm run check:stablecoin-data
npm run check:shared-cycles
npm run check:unused-code
npm test -- shared/lib/__tests__
npm run typecheck
```

Prerequisite cleanup-plan notes affecting execution:

- Website plan does not directly own these files, but any frontend taxonomy/classification cleanup should settle before touching `shared/lib/classification.ts`.

## Recommended Execution Order

1. Reconcile with the final website cleanup result: read its final artifact, run `git status --short --branch`, and identify files it changed.
2. Run a repo-wide baseline guardrail sample before cleanup:

```bash
npm run check:unused-code
npm run check:hotspot-ratchet
npm run check:shared-cycles
npm run check:duplicate-exports
```

3. Execute P1 slice A: public integration artifact shared descriptor, with output equivalence preferred.
4. Execute P1 slice B: stablecoin per-coin source pilot batch, with exact registry/count/order validation.
5. Execute P1 slice C: `audit-depeg-history.ts` decomposition only.
6. Execute P1/P2 slice D: neutral worker test helper ownership move, then fixture builders in one large test at a time.
7. Execute P2 slices only after P1 cleanup has landed:
   - cron stage-contract adoption for one job
   - generated-artifact helper consolidation
   - doc ownership integrity check
8. Treat P3 items as opportunistic only when adjacent work already touches those files.

## Final Validation Strategy

Minimum per-slice:

```bash
npm run typecheck
npm run check:unused-code
npm test -- <focused test files>
```

Worker-impacting slices:

```bash
npm run typecheck:worker
npm run check:worker-boundary
npm run check:shared-cycles
```

Cron-impacting slices:

```bash
npm run check:cron-abort-contract
npm run check:cron-sync
npm run check:cron-connections
npm run typecheck:worker
```

Generated artifact and docs/process slices:

```bash
npm run check:openapi
npm run check:postman
npm run check:llms-txt
npm run check:cemetery-dataset
npm run check:world-map
npm run check:doc-source-paths
npm run check:verified-doc-links
```

Data catalog slices:

```bash
npm run check:stablecoin-data
npm run check:doc-counts
npm test -- scripts/__tests__/stablecoin-catalog-sources.test.ts shared/lib/stablecoins/__tests__
```

Before pushing deploy-impacting cleanup:

```bash
npm run test:merge-gate
```

If validating uncommitted staged work:

```bash
npm run test:merge-gate -- --staged
```
