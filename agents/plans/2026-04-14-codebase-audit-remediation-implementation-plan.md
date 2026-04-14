# Codebase Audit Remediation Implementation Plan - 2026-04-14

Source audit: `agents/audits/2026-04-14-codebase-audit-remediation-blueprint.md`

## Assumptions

- Goal: remediate every finding in the audit blueprint, not just the high-risk items.
- Existing unrelated worktree changes are user/concurrent work and must be preserved.
- Application code may be edited only after this plan has been reviewed and corrected.
- Remediation should stay surgical and avoid broad rewrites. The audit did not justify a Phase 4 re-architecture.
- Dependency updates should stay to the patch/minor cohort identified by `npm outdated`, leaving deferred major updates for separate review.
- For tracked local runtime artifacts under `.superpowers`, use index-only removal only after confirming they are tracked and ignored.
- If an issue is better remediated by a durable backlog item rather than code churn, create/update an `/agents/` planning artifact and keep a concrete acceptance criterion.

## Success Criteria

- All 21 audit findings have an explicit remediation action completed or a durable tracked backlog item where direct implementation is intentionally deferred.
- The plan review loop has zero known remaining issues before code execution begins.
- Tests and guardrails pass:
  - `npm run lint`
  - `npm run typecheck`
  - `cd worker && npx tsc --noEmit`
  - focused Vitest suites for changed runtime/test areas
  - `npm test` if the change set remains broad
  - relevant repo checks: unused-code, shared-cycles, duplicate-exports, env-contract, cron checks, SQL-safety, migrations, docs sync, stablecoin data
  - `npm run build`
  - `npm run seo:check`
- The final status clearly separates our changes from unrelated pre-existing/concurrent worktree changes.

## Execution Phases

### Phase 0 - Preflight And Baseline

1. Capture `git status --short`.
2. Re-read current versions of files before editing any file that already has changes.
3. Confirm whether the `.superpowers` artifacts are tracked and ignored.
4. Keep a running list of changed files owned by this remediation.

### Phase 1 - High-risk Admin And Security Fixes

#### Q-1 - Destructive admin delete parsing accepts partial IDs

Files:

- `worker/src/api/audit-depeg-history.ts`
- relevant tests under `worker/src/api/__tests__/`

Implementation:

- Add a strict comma-separated positive integer parser for delete IDs.
- Reject empty tokens, whitespace-only tokens, partial numeric strings, and non-numeric tokens with `400`.
- Preserve existing successful delete and dry-run behavior.
- Add tests for `delete=1abc`, `delete=abc,1`, `delete=,1`, and a valid multi-ID delete.

Validation:

- Run the audit-depeg-history test file.

#### Q-2 - Feedback issue body can break out of Markdown code fences

Files:

- `worker/src/api/feedback/format.ts`
- `worker/src/api/__tests__/feedback.test.ts`

Implementation:

- Sanitize multiline block text separately from inline text.
- Replace or split triple backticks so user text cannot close the fenced block.
- Neutralize `@` mentions inside block text.
- Add a regression test with both triple backticks and `@team` in the description.

Validation:

- Run `worker/src/api/__tests__/feedback.test.ts`.

#### Q-3 - API-key rate-limit parsing accepts partial numeric strings

Files:

- `worker/src/lib/api-key-core.ts`
- `src/components/status/api-keys-panel.tsx`
- relevant worker API-key tests
- relevant admin UI tests if existing coverage is practical

Implementation:

- Add a strict rate-limit parser that accepts integer JSON numbers and canonical integer strings only.
- Reject non-integer numbers, partial strings, empty malformed strings, and out-of-range values.
- In UI form payloads, avoid `parseInt`; validate with a strict parser or pass a strictly parsed number.
- Set API-key rate-limit inputs to `type="number"` with min/max where the existing UI structure allows it without a redesign.

Validation:

- Run API-key tests and the status API-keys panel test file.

#### Q-4 - API-key audit-log query parsing silently broadens invalid filters

Files:

- `worker/src/api/api-key-audit-log.ts`
- `worker/src/api/__tests__/api-key-audit-log.test.ts`

Implementation:

- Parse `limit` and `apiKeyId` strictly.
- Reject partial numeric strings with `400`.
- Reject invalid `apiKeyId` instead of falling through to an unfiltered query.
- Preserve default limit and max limit behavior for missing/valid values.

Validation:

- Run the API-key audit-log test file.

#### S-2 - Admin backfill DefiLlama fetch lacks timeout/cancellation

Files:

- `worker/src/api/backfill-depegs.ts`

Implementation:

- Add an explicit timeout signal to the DefiLlama detail `fetch()`.
- Preserve response body cancellation/draining behavior.
- Prefer a minimal helper local to the file if importing shared retry helpers changes semantics.

Validation:

- Run backfill-depegs tests.

### Phase 2 - Runtime Redundancy And Observability

#### R-1 - Duplicated circulating-supply summing helper

Files:

- `shared/lib/supply.ts`
- `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`
- `worker/src/lib/authoritative-price-sources.ts`
- supply tests if helper surface changes

Implementation:

- Add or reuse a shared helper for `Pick<PeggedAsset, "circulating">`.
- Replace local `sumCirculatingUsd()` implementations.
- Keep DefiLlama USD-denominated supply semantics unchanged.

Validation:

- Run supply tests and pricing-related tests that import touched files.

#### R-4 - Near-duplicate Alchemy transaction RPC wrappers

Files:

- `worker/src/lib/alchemy-logs.ts`
- `worker/src/lib/__tests__/alchemy-logs.test.ts`

Implementation:

- Extract a private generic helper for transaction/receipt RPC reads.
- Keep exported wrapper names and return types unchanged.

Validation:

- Run Alchemy logs tests.

#### Q-6 - Persisted JSON blob parsing falls back silently

Files:

- `worker/src/lib/api-cache-read.ts`
- `worker/src/api/dex-liquidity.ts`
- relevant dex-liquidity API tests

Implementation:

- Add a contextual parser for best-effort persisted DB JSON fields that logs endpoint/field/stablecoin context on parse failure.
- Keep fallback behavior to avoid breaking response contracts.
- Add a test that malformed JSON logs a warning and still returns fallback data.

Validation:

- Run dex-liquidity API tests.

### Phase 3 - Live Reserve Adapter Consolidation

#### R-3 - Overlapping branch-balance adapter logic

Files:

- `worker/src/cron/reserve-adapters/evm-branch-balances.ts`
- `worker/src/cron/reserve-adapters/lista.ts`
- new helper under `worker/src/cron/reserve-adapters/`
- reserve adapter tests

Implementation:

- Extract shared branch config type, params validation, fallback price lookup, balance-to-slice transform, and DefiLlama price resolution into a helper.
- Preserve adapter-specific metadata:
  - generic adapter: `proofKind: "onchain-branch-balances"` and optional redemption fee metadata
  - Lista adapter: `proofKind: "onchain-branch-balances"` plus `protocol: "lista-dao"`
- Keep existing exported testable pure function for Lista or replace it with an equivalent helper-backed export.

Validation:

- Run relevant reserve adapter tests.

### Phase 4 - UI/Test Redundancy Cleanup

#### R-5 - Duplicate API-key status badge helpers

Files:

- `src/components/status/api-key-load-table.tsx`
- `src/components/status/api-keys-panel.tsx`
- new `src/components/status/api-key-status.ts`
- relevant status component tests

Implementation:

- Extract `getApiKeyStatus()` and `apiKeyStatusBadgeClassName()`.
- Preserve class strings and status labels.

#### R-6 - Test duplicates price transparency helper logic

Files:

- `src/components/stablecoin-detail/price-transparency-card.tsx`
- new helper module if useful
- `src/components/stablecoin-detail/__tests__/price-transparency-card.test.tsx`

Implementation:

- Export the pure source-status resolver from a sidecar module or test rendered behavior directly.
- Remove copied helper from the test.

#### R-7 - Duplicate chain-profile test fixtures

Files:

- `src/app/chains/[chain]/client.test.tsx`
- `src/hooks/__tests__/use-chain-profile-data.test.tsx`
- new shared fixture helper near one of these test domains

Implementation:

- Extract `makeChain()` and `makeCoin()` fixture builders.
- Keep imports local to test files.

#### R-8 - Duplicate supply tests

Files:

- `src/lib/__tests__/supply.test.ts`
- `shared/lib/__tests__/supply.test.ts`

Implementation:

- Keep canonical behavior tests in `shared`.
- Reduce frontend test to alias/bundling-specific coverage only if needed.

#### R-9 - Duplicate worker API-key test helpers

Files:

- `worker/src/__tests__/index.fetch.test.ts`
- `worker/src/api/__tests__/api-keys.test.ts`
- `worker/src/lib/__tests__/api-keys.test.ts`
- new worker test helper

Implementation:

- Extract HMAC and execution-context helper where both API and lib tests can import it.

#### R-10 - Duplicate report-card and DEX worker test fixtures

Files:

- `worker/src/api/__tests__/report-cards.test.ts`
- `worker/src/lib/__tests__/report-cards-snapshot.test.ts`
- `worker/src/cron/__tests__/dex-api-common.test.ts`
- `worker/src/cron/__tests__/dex-liquidity-process-pools.test.ts`
- new focused fixture helpers

Implementation:

- Extract focused helpers only if the shared fixture remains clearer than the local setup.
- If extraction creates awkward cross-domain coupling, document the rationale and keep local duplication as an intentional exception in this plan's completion notes.

Validation for Phase 4:

- Run affected component/hook/worker test files.

### Phase 5 - Sustainability Items

#### S-1 - PR validation docs/workflow drift

Files:

- `docs/testing.md`
- `docs/deployment-process.md`
- possibly `.github/workflows/pull-request-checks.yml`
- possibly `scripts/classify-deploy-changes.mjs` tests

Implementation choice:

- Prefer documentation alignment over workflow expansion unless code inspection shows diff-aware PR validation is accidental.
- Update docs to say PR validation uses deploy-surface classification for Pages build/SEO and worker typecheck, while still running the shared non-deploy guardrails and tests.
- If classifier tests are missing around the PR inputs, add focused tests.

Validation:

- Run doc checks and classifier tests if touched.

#### S-3 - Hotspot waivers remain decomposition debt

Files:

- new or updated `/agents/plans/` backlog artifact
- possibly `scripts/lib/hotspot-ratchet-baseline.json` notes if a typo/ownership gap is found

Implementation:

- Create a concrete hotspot decomposition backlog mapping queued/deferred entries to tranches and acceptance criteria.
- Avoid broad hotspot refactors in this remediation unless already required by R-3.

Validation:

- Run `npm run check:hotspot-ratchet` if hotspot metadata is touched.

#### S-4 - Tracked runtime spillover artifacts

Files:

- `.superpowers/brainstorm/136710-1773742362/.server.log`
- `.superpowers/brainstorm/136710-1773742362/.server.pid`
- `.superpowers/brainstorm/137385-1773742381/.server.log`
- `.superpowers/brainstorm/137385-1773742381/.server.pid`

Implementation:

- Confirm files are tracked and ignored.
- Remove them from the index only; do not delete user-local working files unless unavoidable.

Validation:

- Confirm `git status --short` shows staged/working removal as expected.

#### S-5 - Dependency/runtime drift

Files:

- `package.json`
- `package-lock.json`
- `worker/package.json`

Implementation:

- Update patch/minor cohort only:
  - `@cloudflare/workers-types`
  - `@tanstack/react-query`
  - `@types/node`
  - `prettier`
  - `viem`
  - `wrangler`
- Do not update `eslint` or `typescript` major versions.
- Consider `@types/node` alignment separately. If patching within Node 25 keeps the current contract, document the residual Node 22 ambient type concern in completion notes or add an explicit follow-up.

Validation:

- Run install/update command, then lint/typecheck/tests/build.

## Review Plan Loop

### Review Pass 1

Review findings:

1. Phase 4 R-10 can become counterproductive if fixture extraction creates broader test coupling.
2. S-1 needs an explicit decision: update docs vs change workflow.
3. S-5 includes a potential policy decision around `@types/node` alignment.
4. S-4 should avoid deleting local ignored files from disk.

Fixes applied to plan:

1. R-10 now allows documenting an intentional exception if extraction is worse than local duplication.
2. S-1 now prefers documentation alignment unless workflow inspection proves diff-aware PR validation is accidental.
3. S-5 now limits implementation to patch/minor updates and treats Node type alignment as a separate compatibility decision if needed.
4. S-4 now requires index-only removal and preserving local files when possible.

### Review Pass 2

Review result:

- No critical, major, or minor plan issues remain known.
- Execution is allowed after this point.

## Owned Change List

This section must be updated during execution.

- Plan artifact: `agents/plans/2026-04-14-codebase-audit-remediation-implementation-plan.md`
- Hotspot backlog artifact: `agents/plans/2026-04-14-hotspot-decomposition-backlog.md`
- Q-1: strict direct-delete ID parsing and regression tests.
- Q-2: feedback Markdown fence and mention hardening with regression test.
- Q-3/Q-4: strict API-key numeric parsing in backend/admin UI and audit-log filters.
- Q-5: positive signed CF Access JWT test.
- Q-6: contextual persisted JSON warning parser for DEX liquidity response shaping.
- R-1/R-3/R-4/R-5/R-6/R-7/R-8/R-9/R-10: shared supply helper reuse, branch-balance reserve helper extraction, Alchemy RPC helper extraction, UI/test helper extraction and duplicate supply test reduction.
- S-1/S-3/S-4/S-5: PR validation documentation alignment, hotspot backlog, index-only removal of tracked `.superpowers` runtime artifacts, and bounded dependency refresh with `@types/node` aligned to Node 22.

## Execution Notes

- R-10 was implemented with focused shared report-card and DEX test fixture helpers; no intentional exception was needed.
- `@types/node` was aligned to `22.19.17` rather than patched on the Node 25 line, so `npm outdated` still reports Node 25 as latest by design.
- `.superpowers` runtime files were removed from the Git index with `git rm --cached` and left on disk.
