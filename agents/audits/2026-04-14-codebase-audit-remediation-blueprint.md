# Codebase Audit Remediation Blueprint - 2026-04-14

Scope: read-only audit of the Pharos stablecoin dashboard repository at `/home/ahirice/Documents/git/stablecoin-dashboard`.

This audit artifact does not include application-code changes. It consolidates three parallel specialist audits plus local verification against the current workspace.

## Methodology And Evidence

Inventory sources read:

- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/testing.md`
- `docs/worker-and-api-limits.md`
- `package.json`
- `worker/package.json`
- `.github/workflows/*`
- `scripts/lib/hotspot-ratchet-baseline.json`
- `scripts/lib/hotspot-ratchet-waivers.json`

Verification commands run locally:

- `npm run lint`
- `npm run typecheck`
- `cd worker && npx tsc --noEmit`
- `npm run test:coverage`
- `npm audit --json`
- `npm outdated --json`
- `npm run check:unused-code`
- `npm run check:shared-cycles`
- `npm run check:duplicate-exports`
- `npm run check:hotspot-ratchet`
- `npm run check:env-contract`
- `npm run check:cron-sync`
- `npm run check:cron-connections`
- `npm run check:sql-safety`
- `npm run check:migrations`
- `npm run check:doc-counts`
- `npm run check:verified-doc-links`
- `npm run check:doc-sync`
- `npm run audit:pricing-providers`
- `npm run check:stablecoin-data`

Guardrail result summary:

- Lint passed.
- Root typecheck passed.
- Worker typecheck passed.
- Full Vitest coverage run passed: 464 test files, 4,468 tests, 81.76% line coverage, 68.17% branch coverage.
- `npm audit --json` reported 0 vulnerabilities across 759 packages.
- Unused-code, duplicate-export, cycle, env, cron, SQL-safety, migration, docs, and stablecoin-data checks passed.

## 1. Executive Summary

Total findings: 21

| Pillar | High/Critical | Medium | Low | Total |
| --- | ---: | ---: | ---: | ---: |
| Redundancy elimination | 1 | 3 | 6 | 10 |
| Code quality improvement | 1 | 4 | 1 | 6 |
| Sustainability and maintainability | 0 | 3 | 2 | 5 |
| Total | 2 | 10 | 9 | 21 |

Top 5 findings across all pillars:

1. Q-1: destructive admin delete parsing accepts partial IDs in `worker/src/api/audit-depeg-history.ts`.
2. R-3: live reserve branch-balance adapter logic is duplicated between `evm-branch-balances` and `lista`.
3. Q-2: public feedback text can break out of Markdown code fences in generated GitHub issues.
4. Q-3: API-key rate-limit parsing accepts partial numeric strings in backend and UI admin flows.
5. S-1: testing docs describe full PR validation, but the PR workflow now passes diff-derived conditional inputs.

Overall health:

- Redundancy elimination: 7.5/10. The repo has strong unused-code and duplicate-export guardrails, but several repeated helper and adapter patterns remain. The largest actionable redundancy is in live reserve adapter logic.
- Code quality: 8/10. Lint, typecheck, full tests, and SQL-safety checks pass. Remaining concerns are mostly strict input parsing and test gaps around security-sensitive happy paths.
- Sustainability and maintainability: 8/10. Architecture, CI, docs, and operational guardrails are unusually strong. Main debt is managed hotspot backlog, workflow documentation drift, dependency freshness drift, and a few tracked local runtime artifacts.

Estimated technical debt profile:

- File-count estimate: significant findings touch roughly 20 to 25 runtime/test/config files out of about 1,700 scoped source/test/config files, or about 1% to 1.5% by file count.
- Risk-surface estimate: because those files include admin mutation endpoints, API-key auth/admin tooling, live reserve adapters, CI workflows, and hotspot modules, the affected operational risk surface is closer to 8% to 12%.

## 2. Findings By Pillar

### Pillar A - Redundancy Elimination

#### R-1 - Medium - Duplicated circulating-supply summing helper

Locations:

- `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`, `sumCirculatingUsd()`, lines 78-85
- `worker/src/lib/authoritative-price-sources.ts`, `sumCirculatingUsd()`, lines 90-97
- Existing shared helper: `shared/lib/supply.ts`, `sumPegBuckets()` / `getCirculatingRaw()`, lines 4-27

Problem:

Two Worker-side helpers duplicate the shared supply summing behavior: guard missing/non-object `circulating`, iterate values, and sum only finite numbers. The shared module already encodes the canonical DefiLlama supply semantics.

Why it matters:

Supply interpretation is a high-value domain invariant in this repo. Repeated local implementations increase drift risk if non-USD or malformed DefiLlama payload handling changes again.

Remediation:

Import `sumPegBuckets()` where the local helpers are used. If the `PeggedAsset` type shape blocks direct use, add a small shared wrapper such as `getPeggedAssetCirculatingUsd(asset: Pick<PeggedAsset, "circulating">)` in `shared/lib/supply.ts`.

#### R-2 - Medium - Duplicate one-off KYC reconciliation script utilities

Locations:

- `worker/scripts/reconcile-blacklist-current-balances-from-kyc-rip.ts`, `buildCurrentBalanceId()`, `executeWrangler()`, `sqlString()`, `fetchAllExternalRows()`, lines 23-56
- `worker/scripts/reconcile-blacklist-events-from-kyc-rip.ts`, `executeWrangler()`, `sqlString()`, `fetchAllExternalRows()`, lines 51-80

Problem:

Both scripts duplicate Wrangler remote-D1 execution, SQL string escaping, and kyc.rip pagination. `buildCurrentBalanceId()` is also a pass-through wrapper around `buildBlacklistAddressCountKey()`.

Why it matters:

These are operational repair scripts. If execution flags, buffer handling, endpoint pagination, or SQL escaping requirements change, behavior can diverge across scripts that mutate production D1.

Remediation:

Extract a small `worker/scripts/lib/kyc-rip.ts` for typed pagination and a `worker/scripts/lib/remote-d1.ts` for remote execution and SQL literal helpers, or reuse root `scripts/lib/remote-d1.ts` if script import boundaries allow it. Replace `buildCurrentBalanceId()` with direct use of `buildBlacklistAddressCountKey()`.

#### R-3 - High - Overlapping live reserve branch-balance adapter logic

Locations:

- `worker/src/cron/reserve-adapters/evm-branch-balances.ts`, branch config/read/pricing/slice path, lines 16-60 and 62-149
- `worker/src/cron/reserve-adapters/lista.ts`, branch config/read/pricing/slice path, lines 15-56 and 70-149

Problem:

The generic EVM branch-balance adapter and the Lista adapter repeat a large part of the same domain workflow: branch config shape, params validation, USD fallback lookup, ERC-20 balance reads, DefiLlama pricing, unreadable-branch detection, non-zero-balance detection, slice construction, and metadata assembly.

Why it matters:

This is live reserve logic. Divergent error messages, pricing fallback, and metadata handling can change report-card/reserve behavior for one adapter but not the other.

Remediation:

Extract a reusable branch-balance adapter utility that accepts adapter key, proof metadata, optional redemption-rate probe, protocol metadata, and params schema key. Keep `lista` as a config-specific wrapper with Lista-only metadata.

#### R-4 - Low - Near-duplicate Alchemy transaction RPC wrappers

Locations:

- `worker/src/lib/alchemy-logs.ts`, `getAlchemyTransactionByHash()`, lines 176-196
- `worker/src/lib/alchemy-logs.ts`, `getAlchemyTransactionReceipt()`, lines 198-218

Problem:

Both functions perform budget check, increment count, call `jsonRpcCall()`, return `rpc.result ?? null`, and swallow/log errors. They differ only by method name, result type, and log label.

Why it matters:

Small duplication, but it repeats subrequest-budget behavior in code that interacts with provider limits.

Remediation:

Add a private generic helper such as `getAlchemyTxObject<T>(alchemyUrl, method, txHash, budget, signal)` and keep the current named exports as thin wrappers.

#### R-5 - Low - Duplicate API-key status badge helpers

Locations:

- `src/components/status/api-key-load-table.tsx`, `getKeyStatus()` and `statusBadgeClassName()`, lines 4-25
- `src/components/status/api-keys-panel.tsx`, `getKeyStatus()` and `statusBadgeClassName()`, lines 78-103

Problem:

API-key active/expired/inactive state and badge class mapping are repeated across two admin status components.

Why it matters:

This can cause admin UI status semantics to drift between the API-key list and request attribution table.

Remediation:

Extract `getApiKeyStatus()` and `apiKeyStatusBadgeClassName()` into a small `src/components/status/api-key-status.ts` helper.

#### R-6 - Medium - Test duplicates private production helper logic

Locations:

- `src/components/stablecoin-detail/price-transparency-card.tsx`, `resolveSourceStatus()`, lines 18-30
- `src/components/stablecoin-detail/__tests__/price-transparency-card.test.tsx`, copied `resolveSourceStatus()`, lines 8-21

Problem:

The test reimplements private component logic instead of exercising the helper directly or asserting rendered behavior only.

Why it matters:

Copied logic can keep passing after production logic changes, reducing regression detection.

Remediation:

Move the pure helper to a sidecar module and unit test it directly, or remove the copied helper and assert rendered status labels/classes from the public component behavior.

#### R-7 - Low - Duplicated chain-profile test fixtures

Locations:

- `src/app/chains/[chain]/client.test.tsx`, `makeChain()` / `makeCoin()` fixtures, lines 38-89
- `src/hooks/__tests__/use-chain-profile-data.test.tsx`, `makeChain()` / `makeCoin()` fixtures, lines 20-71

Problem:

The same `ChainSummary` / `ChainStablecoin` fixture builders are repeated.

Why it matters:

When the chain profile data contract changes, duplicated fixtures increase test maintenance.

Remediation:

Move the fixture builders to a focused shared test helper near the chain profile tests.

#### R-8 - Low - Duplicate supply unit tests across frontend and shared suites

Locations:

- `src/lib/__tests__/supply.test.ts`, lines 23-109
- `shared/lib/__tests__/supply.test.ts`, lines 59-157

Problem:

The frontend suite imports `@shared/lib/supply` and repeats much of the shared suite.

Why it matters:

Supply behavior should be canonically covered in `shared/`; duplicate frontend tests add maintenance without much extra signal unless they are explicitly testing alias/bundling behavior.

Remediation:

Keep canonical behavior coverage in `shared/lib/__tests__/supply.test.ts`. Retain only frontend-specific alias/consumer tests if needed.

#### R-9 - Low - Duplicated worker API-key test helpers

Locations:

- `worker/src/__tests__/index.fetch.test.ts`, helper setup, lines 8-32
- `worker/src/api/__tests__/api-keys.test.ts`, helper setup, lines 16-40
- `worker/src/lib/__tests__/api-keys.test.ts`, `hmacSha256Hex()`, lines 15-26

Problem:

API-key HMAC and execution-context fixtures are repeated across worker tests.

Why it matters:

Auth/token setup is sensitive; duplicated fixture helpers can drift as token/HMAC behavior evolves.

Remediation:

Add a small worker test helper, for example `worker/src/api/__tests__/helpers/auth.ts`, and reuse it across worker API/lib tests.

#### R-10 - Low - Duplicated worker report-card and DEX test fixtures

Locations:

- `worker/src/api/__tests__/report-cards.test.ts`, report-card cache fixture, lines 8-23
- `worker/src/lib/__tests__/report-cards-snapshot.test.ts`, report-card cache fixture, lines 134-149
- `worker/src/cron/__tests__/dex-api-common.test.ts`, DEX lookup fixture, lines 27-53
- `worker/src/cron/__tests__/dex-liquidity-process-pools.test.ts`, DEX lookup fixture, lines 41-67

Problem:

Repeated test fixture builders recreate D1 report-card cache rows and DEX lookup maps.

Why it matters:

Low risk, but fixture drift can hide regressions in data contracts.

Remediation:

Extract focused fixture helpers near each domain, not a broad global test utility.

### Pillar B - Code Quality Improvement

#### Q-1 - High - Destructive admin delete parsing accepts partial IDs

Location:

- `worker/src/api/audit-depeg-history.ts`, `handleAuditDepegHistory`, lines 294-320

Problem:

The `deleteIds` path uses `deleteIds.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n))`. This means `delete=1abc` becomes `1`, and invalid mixed tokens are silently ignored.

Why it matters:

This is a mutating admin path that deletes depeg events. An operator typo can delete an unintended event instead of failing fast.

Remediation:

Require every token to match `/^\d+$/`, reject empty or invalid tokens with `400`, and add tests for `delete=1abc`, `delete=abc,1`, and `delete=,1`.

#### Q-2 - Medium - Feedback issue body can break out of Markdown code fences

Locations:

- `worker/src/api/feedback/format.ts`, `formatTextBlock()`, lines 14-16
- `worker/src/api/feedback/format.ts`, `formatFeedbackBody()`, lines 39-43
- Existing weak test: `worker/src/api/__tests__/feedback.test.ts`, lines 373-395

Problem:

Public feedback text is wrapped in a fenced Markdown block without escaping embedded triple backticks. The inline sanitizer neutralizes `@` mentions, but block text keeps raw mentions and raw fence delimiters.

Why it matters:

A public submitter can close the code fence and inject arbitrary Markdown or active mentions into the generated GitHub issue body.

Remediation:

Escape or replace ``` inside multiline fields, neutralize `@` in block text as well as inline text, and add a regression test with both ``` and `@team` in the description.

#### Q-3 - Medium - API-key rate-limit parsing accepts partial numeric strings

Locations:

- `worker/src/lib/api-key-core.ts`, `normalizeRateLimit()`, lines 146-157
- `src/components/status/api-keys-panel.tsx`, create payload parsing, lines 190-196
- `src/components/status/api-keys-panel.tsx`, update payload parsing, lines 456-462

Problem:

Backend and UI use `Number.parseInt(...)`; values like `"120abc"` become `120`.

Why it matters:

Operator-entered rate limits can silently normalize malformed input into a valid public API limiter, which is inconsistent with the stricter query/body validation style used elsewhere.

Remediation:

Use a strict integer parser: `typeof value === "number" && Number.isInteger(value)` for JSON numbers, or string `/^\d+$/` for strings. Reject non-canonical values. Use number inputs with min/max in the UI and add backend/UI malformed input tests.

#### Q-4 - Medium - API-key audit-log query parsing silently broadens invalid filters

Location:

- `worker/src/api/api-key-audit-log.ts`, `handleApiKeyAuditLog`, lines 41-49

Problem:

`limit=25abc` is accepted as `25`, and invalid `apiKeyId` becomes `null`, falling through to an unfiltered audit-log query.

Why it matters:

This violates the documented API convention that invalid query parameter syntax returns `400`. It can surprise operators and broaden sensitive admin log reads.

Remediation:

Use the shared strict query-param helpers or equivalent regex validation for `limit` and `apiKeyId`. Return `400` for invalid `apiKeyId`. Add explicit tests for invalid and partial numeric filters.

#### Q-5 - Medium - CF Access JWT verifier lacks a successful-signature test

Locations:

- `shared/lib/cloudflare-access-jwt.ts`, `verifyAccessJwt()`, lines 159-209
- Test gap examples: `worker/src/lib/__tests__/jwt-verify.test.ts`, lines 184-196 and 315-333

Problem:

Tests cover malformed and negative paths, plus a "claims passed because JWKS fetch was called" proxy assertion. They do not prove that a correctly signed Access JWT returns `true`.

Why it matters:

A regression in public-key import or signature verification could deny all valid ops requests while the current suite still passes.

Remediation:

In tests, generate an RSA key pair, export the public JWK into mocked JWKS, sign an RS256 JWT with matching `kid` and valid claims, and assert `verifyAccessJwt(...) === true`. Add a header/JWK algorithm mismatch rejection case.

#### Q-6 - Low - Persisted JSON blob parsing falls back silently

Locations:

- `worker/src/lib/api-cache-read.ts`, `safeJsonParse()`, lines 5-11
- Representative callsite: `worker/src/api/dex-liquidity.ts`, `handleDexLiquidity`, lines 103-131

Problem:

Malformed persisted JSON fields return fallback `{}` or `null` without logging or response degradation metadata.

Why it matters:

Silent fallback keeps endpoints resilient, but it can hide D1 data corruption and publish incomplete liquidity breakdowns as normal.

Remediation:

Add a contextual persisted-JSON parser that logs key/row context and optionally attaches response warning/meta flags. Keep silent fallback only for explicitly best-effort client/local state.

### Pillar C - Sustainability And Maintainability

#### S-1 - Medium - PR validation documentation no longer matches workflow behavior

Locations:

- `docs/testing.md`, lines 43-46 and 68-71
- `.github/workflows/pull-request-checks.yml`, lines 37-43
- `.github/workflows/validate-ci.yml`, lines 56-66

Problem:

The docs say PRs use reusable workflow defaults and always run `build`, `seo:check`, and worker typecheck. The PR workflow actually passes diff-derived `pages_changed` and `worker_changed` inputs into `validate-ci`.

Long-term consequence:

Maintainers may assume full PR validation when some lanes are conditional. If deploy-impact classification misses a path, the docs will not help catch the gap.

Remediation:

Choose one contract and make it explicit: either restore full PR validation by omitting those inputs on PRs, or update `docs/testing.md` and `docs/deployment-process.md` to describe diff-aware PR validation and add classifier coverage for every skipped lane.

#### S-2 - Medium - One admin backfill fetch lacks the timeout/cancellation pattern

Locations:

- `worker/src/api/backfill-depegs.ts`, raw DefiLlama detail `fetch()`, line 172
- Relevant repo limit guidance: `docs/worker-and-api-limits.md`, connection-budget guidance around line 55

Problem:

`handleBackfillDepegs()` performs a raw DefiLlama detail fetch without `AbortSignal.timeout()` or a shared admin-job cancellation signal.

Long-term consequence:

Slow upstreams can pin the admin job until platform/runtime deadlines, making backfills less predictable during degraded upstream periods.

Remediation:

Wrap this call with `fetchWithRetry()` or an explicit timeout signal and preserve the existing body-drain/cancel behavior for non-OK responses.

#### S-3 - Medium - Managed hotspot waivers remain decomposition debt

Locations:

- `scripts/lib/hotspot-ratchet-baseline.json`, `src/components/contagion-graph.tsx` entry, around line 50
- `scripts/lib/hotspot-ratchet-baseline.json`, `worker/src/cron/dispatch-telegram-alerts.ts` entry, around line 242
- `scripts/lib/hotspot-ratchet-baseline.json`, `worker/src/cron/sync-blacklist.ts` entry, around line 326
- `scripts/lib/hotspot-ratchet-waivers.json`, file-wide waiver map, line 1 onward

Problem:

The hotspot ratchet passes, but the baseline/waiver files explicitly defer broad modules such as `src/components/contagion-graph.tsx`, `worker/src/cron/dispatch-telegram-alerts.ts`, `worker/src/cron/sync-blacklist.ts`, `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`, and several UI composition surfaces.

Long-term consequence:

New changes in these areas remain harder to isolate, review, and test, even though regressions are being tracked.

Remediation:

Keep the ratchet, but turn the queued/deferred entries into an owned decomposition backlog. Require new feature work in those files to extract a helper/subcomponent when practical.

#### S-4 - Low - Runtime spillover artifacts are tracked despite ignore rule

Locations:

- `.gitignore`, `/.superpowers`, line 95
- `.superpowers/brainstorm/136710-1773742362/.server.log`, line 1
- `.superpowers/brainstorm/136710-1773742362/.server.pid`, line 1
- `.superpowers/brainstorm/137385-1773742381/.server.log`, line 1
- `.superpowers/brainstorm/137385-1773742381/.server.pid`, line 1

Problem:

`.superpowers` is ignored, but four `.server.log` / `.server.pid` files are already tracked in the index.

Long-term consequence:

Local runtime noise can leak into reviews and confuse repo inventory.

Remediation:

Remove these files from version control with index-only removal, keep the ignore rule, and optionally add a lightweight guard for tracked `.server.log` / `.server.pid` artifacts.

#### S-5 - Low - Dependency/runtime drift needs routine cleanup

Locations:

- `package.json`, Node engine, lines 9-10
- `package.json`, `@types/node`, line 87
- `worker/package.json`, Worker dependency versions, lines 13-20
- `.nvmrc`, line 1

Problem:

`npm audit` is clean, but `npm outdated --json` reports patch/minor drift for `@cloudflare/workers-types`, `@tanstack/react-query`, `@types/node`, `prettier`, `viem`, and `wrangler`; major-only updates for `eslint` and `typescript` are intentionally deferred. The supported runtime starts at Node 22, while `@types/node` is on 25.x.

Long-term consequence:

Patch/minor drift is manageable, but newer Node ambient types can allow accidental use of APIs unavailable on the lowest supported runtime.

Remediation:

Refresh the patch/minor cohort in a bounded dependency PR. Consider aligning `@types/node` to the lowest supported runtime line or adding explicit compatibility guardrails for Node 22-only execution paths.

## 3. Cross-Cutting Concerns

### C-1 - Strict parsing and admin mutation safety

Connected findings: Q-1, Q-3, Q-4, S-2

Pattern:

Several admin/operator paths use partial numeric parsing or unbounded upstream fetches. The rest of the repo has stricter validation helpers and explicit runtime budgets, so these are localized inconsistencies.

Priority:

High. Fix Q-1 first because it is destructive. Then fix Q-3 and Q-4 together by reusing a strict numeric parser. Fix S-2 in the same admin-hardening tranche.

### C-2 - Live reserves and DEX data remain high-complexity operational surfaces

Connected findings: R-3, S-3, coverage observations for `worker/src/cron/dex-liquidity/*` and reserve adapters

Pattern:

Live reserve adapters and DEX liquidity ingestion have strong guardrails but still contain large, branch-heavy modules and duplicated adapter workflow logic.

Priority:

Medium-high. R-3 is the most valuable consolidation because it reduces live reserve behavior drift. Defer broad DEX decomposition until it aligns with queued hotspot tranches.

### C-3 - Documentation and CI contract drift

Connected findings: S-1 plus passed doc checks

Pattern:

Automated doc count/link/sync checks pass, but prose around PR validation does not match workflow behavior. The existing doc guards do not cover this exact workflow-contract claim.

Priority:

Medium. Decide whether PR validation is intentionally diff-aware. Then align docs or workflow behavior and add classifier tests if the diff-aware path is intended.

### C-4 - Test duplication and test gap asymmetry

Connected findings: R-6, R-7, R-8, R-9, R-10, Q-5

Pattern:

The test suite is broad and passes, but some tests duplicate production logic while one security-sensitive happy path lacks proof.

Priority:

Medium. Add the CF Access positive-signature test first, then clean duplicated fixtures opportunistically when touching those areas.

### C-5 - Managed but deferred hotspot and dependency debt

Connected findings: S-3, S-5

Pattern:

The repo is actively managing debt with ratchets and Dependabot, but some entries remain deferred rather than scheduled.

Priority:

Low-medium. Keep the existing guardrails and move queued hotspot entries into concrete backlog items.

## 4. Prioritized Remediation Roadmap

### Phase 1 - Quick Wins

| Finding | Action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| Q-1 | Add strict delete-ID parser and tests for malformed tokens. | `worker/src/api/audit-depeg-history.ts`, matching audit-depeg tests | Small | None |
| Q-2 | Escape Markdown fences and mentions in feedback block text; update regression test. | `worker/src/api/feedback/format.ts`, `worker/src/api/__tests__/feedback.test.ts` | Small | None |
| Q-3 | Add strict API-key rate-limit parser and malformed-value tests. | `worker/src/lib/api-key-core.ts`, API-key tests | Small | None |
| Q-4 | Parse `limit` and `apiKeyId` through strict query helpers; add tests. | `worker/src/api/api-key-audit-log.ts`, audit-log tests | Small | None |
| S-2 | Add timeout/cancellation to DefiLlama detail fetch. | `worker/src/api/backfill-depegs.ts` | Small | None |
| R-4 | Extract private Alchemy transaction object helper. | `worker/src/lib/alchemy-logs.ts` | Small | None |
| R-5 | Extract API-key status/badge helper. | `src/components/status/api-key-status.ts`, `api-key-load-table.tsx`, `api-keys-panel.tsx` | Small | None |
| S-4 | Remove tracked `.server.log` / `.server.pid` artifacts from the index. | `.superpowers/brainstorm/**/.server.*` | Small | None |

### Phase 2 - Targeted Refactoring

| Finding | Action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| R-1 | Replace local supply summing helpers with shared helper. | `shared/lib/supply.ts`, `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`, `worker/src/lib/authoritative-price-sources.ts` | Small | Add typed wrapper if needed |
| R-2 | Extract kyc.rip and remote-D1 script helpers. | `worker/scripts/reconcile-blacklist-*.ts`, new `worker/scripts/lib/*` | Medium | Keep scripts read-only dry-run friendly while refactoring |
| R-6 | Remove copied `resolveSourceStatus()` test logic. | `price-transparency-card.tsx`, `price-transparency-card.test.tsx` | Small | None |
| R-7 | Share chain-profile test fixtures. | `src/app/chains/[chain]/client.test.tsx`, `src/hooks/__tests__/use-chain-profile-data.test.tsx` | Small | None |
| R-8 | Remove redundant frontend supply tests or make them alias-specific. | `src/lib/__tests__/supply.test.ts`, `shared/lib/__tests__/supply.test.ts` | Small | None |
| R-9 | Share worker API-key test helpers. | `worker/src/__tests__/index.fetch.test.ts`, API-key worker tests | Small | None |
| R-10 | Share report-card and DEX fixture builders. | Worker report-card and DEX tests | Small | None |
| Q-5 | Add a valid signed Access JWT test. | `worker/src/lib/__tests__/jwt-verify.test.ts` | Medium | Needs deterministic WebCrypto key setup |
| Q-6 | Add contextual persisted-JSON parser/logging for DB JSON fields. | `worker/src/lib/api-cache-read.ts`, `worker/src/api/dex-liquidity.ts` | Medium | Decide public warning/meta shape |

### Phase 3 - Structural Improvements

| Finding | Action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| R-3 | Extract shared branch-balance reserve adapter utility and refit Lista/generic adapter. | `worker/src/cron/reserve-adapters/evm-branch-balances.ts`, `worker/src/cron/reserve-adapters/lista.ts`, adapter tests | Medium-large | Add characterization tests before extraction |
| S-1 | Align PR validation docs and workflow contract; add classifier tests if diff-aware PR validation is intended. | `docs/testing.md`, `docs/deployment-process.md`, `.github/workflows/pull-request-checks.yml`, `scripts/classify-deploy-changes.mjs` tests | Medium | Product/team decision on PR validation scope |
| S-3 | Convert hotspot ratchet deferred/queued entries into owned decomposition backlog. | `scripts/lib/hotspot-ratchet-baseline.json`, `scripts/lib/hotspot-ratchet-waivers.json`, `/agents/plans/` | Medium | Needs owner and tranche sequencing |
| S-5 | Refresh patch/minor dependency cohort and reassess Node type alignment. | `package.json`, `package-lock.json`, `worker/package.json`, `.nvmrc` decision | Medium | Run full merge gate after updates |

### Phase 4 - Strategic Overhauls

No immediate Phase 4 rewrite is justified. The codebase already has boundary, cycle, migration, env, doc, SQL, unused-code, hotspot, coverage, smoke, CodeQL, dependency-audit, and secret-scan guardrails. Strategic work should stay focused on hotspot decomposition tranches rather than broad re-architecture.

## 5. Appendices

### Appendix A - File-by-file Finding Index

| File | Findings |
| --- | --- |
| `.github/workflows/pull-request-checks.yml` | S-1 |
| `.github/workflows/validate-ci.yml` | S-1 |
| `.gitignore` | S-4 |
| `.nvmrc` | S-5 |
| `.superpowers/brainstorm/136710-1773742362/.server.log` | S-4 |
| `.superpowers/brainstorm/136710-1773742362/.server.pid` | S-4 |
| `.superpowers/brainstorm/137385-1773742381/.server.log` | S-4 |
| `.superpowers/brainstorm/137385-1773742381/.server.pid` | S-4 |
| `docs/testing.md` | S-1 |
| `docs/worker-and-api-limits.md` | S-2 |
| `package.json` | S-5 |
| `shared/lib/cloudflare-access-jwt.ts` | Q-5 |
| `shared/lib/supply.ts` | R-1 |
| `src/app/chains/[chain]/client.test.tsx` | R-7 |
| `src/components/stablecoin-detail/__tests__/price-transparency-card.test.tsx` | R-6 |
| `src/components/stablecoin-detail/price-transparency-card.tsx` | R-6 |
| `src/components/status/api-key-load-table.tsx` | R-5 |
| `src/components/status/api-keys-panel.tsx` | R-5, Q-3 |
| `src/hooks/__tests__/use-chain-profile-data.test.tsx` | R-7 |
| `src/lib/__tests__/supply.test.ts` | R-8 |
| `worker/package.json` | S-5 |
| `worker/scripts/reconcile-blacklist-current-balances-from-kyc-rip.ts` | R-2 |
| `worker/scripts/reconcile-blacklist-events-from-kyc-rip.ts` | R-2 |
| `worker/src/api/__tests__/feedback.test.ts` | Q-2 |
| `worker/src/api/api-key-audit-log.ts` | Q-4 |
| `worker/src/api/audit-depeg-history.ts` | Q-1 |
| `worker/src/api/backfill-depegs.ts` | S-2 |
| `worker/src/api/dex-liquidity.ts` | Q-6 |
| `worker/src/api/feedback/format.ts` | Q-2 |
| `worker/src/api/__tests__/api-keys.test.ts` | R-9 |
| `worker/src/api/__tests__/report-cards.test.ts` | R-10 |
| `worker/src/cron/__tests__/dex-api-common.test.ts` | R-10 |
| `worker/src/cron/__tests__/dex-liquidity-process-pools.test.ts` | R-10 |
| `worker/src/cron/reserve-adapters/evm-branch-balances.ts` | R-3 |
| `worker/src/cron/reserve-adapters/lista.ts` | R-3 |
| `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts` | R-1, S-3 |
| `worker/src/__tests__/index.fetch.test.ts` | R-9 |
| `worker/src/lib/__tests__/api-keys.test.ts` | R-9 |
| `worker/src/lib/__tests__/jwt-verify.test.ts` | Q-5 |
| `worker/src/lib/__tests__/report-cards-snapshot.test.ts` | R-10 |
| `worker/src/lib/alchemy-logs.ts` | R-4 |
| `worker/src/lib/api-cache-read.ts` | Q-6 |
| `worker/src/lib/api-key-core.ts` | Q-3 |
| `worker/src/lib/authoritative-price-sources.ts` | R-1 |
| `scripts/lib/hotspot-ratchet-baseline.json` | S-3 |
| `scripts/lib/hotspot-ratchet-waivers.json` | S-3 |

### Appendix B - Dependency Audit Summary

| Check | Result |
| --- | --- |
| `npm audit --json` | 0 vulnerabilities across 759 total packages |
| `npm audit --audit-level=high --omit=dev` | Passed via project script |
| `@cloudflare/workers-types` | current `4.20260409.1`, latest `4.20260414.1` |
| `@tanstack/react-query` | current `5.97.0`, latest/wanted `5.99.0` |
| `@types/node` | current `25.5.2`, latest/wanted `25.6.0`; note Node engine starts at 22.12 |
| `prettier` | current `3.8.1`, latest/wanted `3.8.2` |
| `viem` | current `2.47.12`, latest/wanted `2.47.17` |
| `wrangler` | current `4.81.1`, latest/wanted `4.82.2` |
| `eslint` | current/wanted `9.39.4`, latest `10.2.0`; major deferred |
| `typescript` | current/wanted `5.9.3`, latest `6.0.2`; major deferred |

### Appendix C - Coverage And Testing Notes

Full coverage run:

- Test files: 464 passed
- Tests: 4,468 passed
- Statements: 79.5%
- Branches: 68.17%
- Functions: 82.01%
- Lines: 81.76%

Notable lower-coverage pockets, prioritized by operational relevance:

- `worker/src/cron/dex-liquidity/subgraph-source-families.ts`: 0% line coverage in the full coverage run.
- `worker/src/cron/dex-liquidity/crawl-helpers.ts`: 0% line coverage in the full coverage run.
- `worker/src/cron/dex-liquidity/subgraph-helpers.ts`: 0% line coverage in the full coverage run.
- `worker/src/api/og.tsx`: 7.2% line coverage.
- `worker/src/cron/dex-liquidity/fetch-fallbacks.ts`: 15.7% line coverage.
- `worker/src/cron/reserve-adapters/chainlink-nav.ts`: 18.8% line coverage.
- `worker/src/cron/reserve-adapters/gho.ts`: 22.8% line coverage.
- `worker/src/cron/blacklist/amount-recovery.ts`: 27% line coverage.
- `src/hooks/use-portfolio.ts`: 2.2% line coverage; user-facing but not a server-side operational risk.

Use this list for targeted coverage improvements after Q-1 through Q-5 are fixed. Do not chase UI display coverage before admin/security and live-data parser coverage.

### Appendix D - Glossary

Branch-balance adapter:

A live reserve adapter pattern that reads balances across multiple on-chain holder/token branches, prices each branch, and emits reserve slices.

Cyclomatic/branch complexity:

A rough count of conditional paths through a function or module. High branch counts make changes harder to reason about and test.

Hotspot ratchet:

The repo's guardrail that tracks broad files, long functions, and branch-heavy modules so they cannot grow unnoticed.

Partial numeric parse:

The JavaScript `parseInt()` behavior where strings such as `"25abc"` produce `25` instead of failing. This is risky for admin IDs, limits, and mutation controls.

Strict parser:

A parser that rejects invalid syntax rather than coercing. For numeric strings, this usually means checking `/^\d+$/` before converting.

Wire-compatible schema:

A schema that accepts older serialized shapes while mapping them into the current runtime model.
