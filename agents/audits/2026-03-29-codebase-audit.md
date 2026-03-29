# Full Codebase Audit

Date: 2026-03-29
Scope: full application codebase under `src/`, `worker/src/`, `shared/`, `functions/`, build/CI surfaces, and dependency manifests
Audit mode: multi-agent parallel review across redundancy, code quality, and sustainability

## Audit Inputs

- Documentation reviewed: `docs/architecture.md`, `docs/api-reference.md`, `docs/testing.md`, `docs/worker-and-api-limits.md`, `docs/deployment-process.md`, `docs/worker-infrastructure.md`
- Dependency and automation surfaces reviewed: `package.json`, `worker/package.json`, `.github/workflows/validate-ci.yml`, `.github/workflows/deploy-cloudflare.yml`
- Structural baselines reviewed: `scripts/lib/hotspot-ratchet-baseline.json`, `agents/plans/2026-03-29-hotspot-decomposition-backlog.md`
- Verification run during audit:
  - `npm run audit:deps`
  - `npm audit --audit-level=high`
  - `npm run check:unused-code`
  - `npm run check:shared-cycles`
  - `npm run check:duplicate-exports`
  - `npm run check:hotspot-ratchet`
  - `npm run check:worker-boundary`
  - `npm run check:migrations`
  - `npm run check:cron-sync`
  - `npm run check:cron-connections`
  - `npm run lint`
  - `npm run typecheck`
  - `cd worker && npx tsc --noEmit`
  - `npm test`
  - `npm run seo:check`
  - `npm run build`

All listed checks passed on the audited tree.

## 1. Executive Summary

### Findings Count

| Pillar | Findings | Highest severity/impact |
| --- | ---: | --- |
| Redundancy elimination | 8 | High |
| Code quality improvement | 9 | Medium |
| Sustainability and maintainability | 10 | High |
| Total | 27 | High |

| Severity / impact bucket | Count |
| --- | ---: |
| Critical | 0 |
| High | 8 |
| Medium | 15 |
| Low | 4 |

No reproducible current-tree Critical defect was verified during this audit. The highest-risk items are operational and architectural High findings, not confirmed user-facing correctness failures in the current snapshot.

### Top 5 Most Critical Findings

1. `S1` Cloudflare Access JWT verification can fail for up to one hour after JWKS key rotation because unknown `kid` values do not trigger a cache refresh.
2. `S2` Public API rate limiting can silently fall back to a hardcoded repo-wide salt, weakening production isolation and making misconfiguration easy to miss.
3. `S3` `syncStablecoins()` remains a single orchestration hotspot spanning intake, pricing, validation, persistence, and depeg pipeline control.
4. `S6` `live-reserves-store.ts` combines DAO, parsing, consistency checks, scoring eligibility, and presentation assembly in one module.
5. `R1` + `Q1` + `S4` The digest pipeline is duplicated and fragmented across daily and weekly flows, with inconsistent parsing, error signaling, and test coverage.

### Codebase Health Assessment

| Pillar | Score | Justification |
| --- | ---: | --- |
| Redundancy elimination | 7/10 | Dead-code hygiene is strong and automated checks are clean, but several active product surfaces duplicate logic instead of sharing domain helpers. |
| Code quality improvement | 7/10 | Lint, type-check, and test discipline are strong, but several hotspot modules still violate SRP and rely on silent fallbacks. |
| Sustainability and maintainability | 6/10 | Architecture is broadly coherent, but core worker pipelines and two operational configuration gaps create meaningful future risk. |

### Technical Debt Profile

Estimated significant-debt footprint: about 7% of the codebase directly, concentrated in worker cron/lib hotspots and a smaller set of frontend state/UI composites. The direct estimate is anchored by the tracked hotspot baseline (`~8.1k` queued/deferred hotspot lines) plus the smaller duplicated modules identified here; the transitive blast radius is larger because several hotspots sit on central request and cron paths.

## 2. Findings by Pillar

### Redundancy Elimination

Dead-code note: `npm run check:unused-code` and `npm run check:duplicate-exports` were clean, so redundancy issues are concentrated in live code paths rather than stale exports.

#### R1. Digest generation and publish flow is duplicated

- Severity: High
- Locations:
  - `worker/src/cron/daily-digest.ts:251-423`
  - `worker/src/cron/weekly-recap.ts:175-280`
- Description: Both jobs repeat the same structural workflow: circuit-breaker gate, Anthropic call, response extraction, persistence into `daily_digest`, Telegram delivery, and outcome recording.
- Consolidation strategy: Extract a shared `runDigestGeneration()` + `persistDigest()` + `publishDigest()` service, with prompt/model/config injected per digest type.

#### R2. Weekly recap reimplements daily digest response parsing

- Severity: High
- Locations:
  - `worker/src/cron/weekly-recap.ts:212-246`
  - `worker/src/cron/daily-digest/response.ts:33-109`
- Description: Weekly recap manually strips fences, hunts for braces, parses JSON, normalizes dashes, and falls back to raw text instead of reusing the already-maintained daily parser.
- Consolidation strategy: Generalize `parseDigestModelResponse()` to accept type-specific metadata augmentation, then delete the weekly-only parser block.

#### R3. Logo loading is split between a trivial hook and direct JSON imports

- Severity: Medium
- Locations:
  - `src/hooks/use-logos.ts:1-6`
  - `src/app/chains/client.tsx:20`
  - `src/app/chains/[chain]/client.tsx:30`
  - `src/app/stablecoin/[id]/page.tsx:18`
  - `src/components/upcoming-client.tsx:31`
- Description: The hook is just a pass-through over static JSON while multiple consumers bypass it and import the JSON directly.
- Consolidation strategy: Replace `useLogos()` with a shared `logosById` module and have both server and client consumers import the same source directly.

#### R4. Header and sidebar duplicate route-active logic and nav affordances

- Severity: Medium
- Locations:
  - `src/components/header.tsx:47-50`
  - `src/components/header.tsx:84-147`
  - `src/components/sidebar.tsx:208-245`
  - `src/components/sidebar.tsx:247-303`
- Description: Mobile and desktop navigation each maintain their own `isActive` logic and their own search/theme/footer affordances.
- Consolidation strategy: Extract a shared active-route helper plus shared nav-action components for search/theme controls.

#### R5. Chain health threshold mapping is duplicated locally

- Severity: Medium
- Locations:
  - `src/app/chains/[chain]/client.tsx:47-65`
  - `shared/lib/chain-health.ts:113-119`
  - `src/lib/chain-ui.ts:14-28`
- Description: The chain detail page redefines score thresholds and color/icon mappings instead of deriving from the shared health-band model and UI class registries.
- Consolidation strategy: Convert score-to-band once via `getHealthBand()` and render band-driven UI through `chain-ui` helpers.

#### R6. Client-side persistence logic is reimplemented in several places

- Severity: Medium
- Locations:
  - `src/hooks/use-preferences.ts:13-54`
  - `src/hooks/use-command-palette-history.ts:23-85`
  - `src/hooks/use-portfolio.ts:46-115`
  - `src/hooks/use-start-here-callout.ts:16-48`
  - `src/components/sidebar.tsx:36-50`
  - `src/components/methodology-mode-toggle.tsx:21-36`
- Description: The repo already has one generic localStorage hook, but several other hooks/components implement their own parse, migrate, publish, and write patterns.
- Consolidation strategy: Extract a small shared storage adapter for safe read/write/subscribe behavior and reuse it across persistence-heavy hooks.

#### R7. Start Here visit state is written twice

- Severity: Low
- Locations:
  - `src/hooks/use-start-here-callout.ts:37-48`
  - `src/components/start-here-visit-marker.tsx:7-13`
- Description: Both the homepage hook and the visit marker perform the same `markStartHereOpened(read(...)); write(...)` sequence.
- Consolidation strategy: Expose a single `persistStartHereOpened()` helper from `@/lib/start-here-callout`.

#### R8. Dynamic admin route knowledge is duplicated between Pages and Worker layers

- Severity: Medium
- Locations:
  - `functions/api/admin/[[path]].ts:10-11`
  - `functions/api/admin/[[path]].ts:56-62`
  - `worker/src/route-registry.ts:364-370`
- Description: The Pages proxy maintains a separate regex for `/api/discovery-candidates/:id/dismiss` because the route is not fully representable through shared endpoint metadata.
- Consolidation strategy: Extend shared endpoint metadata to cover dynamic admin routes or export a shared matcher from one source of truth.

### Code Quality Improvement

#### Q1. Weekly recap silently degrades on malformed model output

- Severity: Medium
- Location: `worker/src/cron/weekly-recap.ts:228-246`
- Problem: The parser swallows all JSON/schema failures and silently falls back to raw text without marking the run as degraded, logging a decode reason, or exercising a dedicated regression test.
- Why it matters: Silent fallback makes prompt regressions and schema drift invisible until content quality declines in production.
- Recommendation: Reuse the shared parser, emit an explicit degraded flag in metadata, and add a focused test that covers malformed JSON and fence-wrapped responses.

#### Q2. `generateDailyDigest()` violates SRP

- Severity: Medium
- Location: `worker/src/cron/daily-digest.ts:59-423`
- Problem: One function handles freshness checks, data collection, PSI parsing, prompt construction, LLM transport, persistence, Twitter delivery, Telegram delivery, and degraded-state bookkeeping.
- Why it matters: The function is difficult to reason about and expensive to change safely.
- Recommendation: Split into staged helpers: `buildDigestInput()`, `generateDigestCopy()`, `storeDigest()`, `publishDigestToTwitter()`, and `publishDigestToTelegram()`.

#### Q3. `status-reliability.ts` is a god module

- Severity: Medium
- Locations:
  - `worker/src/lib/status-reliability.ts:207-378`
  - `worker/src/lib/status-reliability.ts:380-454`
  - `worker/src/lib/status-reliability.ts:456-535`
  - `worker/src/lib/status-reliability.ts:537-721`
- Problem: State reconciliation, snapshots, transition history, probe persistence, discrepancy counters, alert bookkeeping, and discrepancy rendering all live in one module.
- Why it matters: Each new status feature increases coupling between persistence, policy, and presentation concerns.
- Recommendation: Split into `status-state-store`, `status-probe-store`, `status-discrepancy-store`, and `status-discrepancy-view` modules.

#### Q4. Malformed JSON is silently ignored despite an existing observability helper

- Severity: Medium
- Locations:
  - `worker/src/lib/status-reliability.ts:91-98`
  - `worker/src/api/digest-archive.ts:14-30`
  - Existing shared helper: `worker/src/lib/json-decode-observability.ts:11-32`
- Problem: Two call sites silently swallow malformed JSON even though the codebase already provides `logMalformedJsonPath()` and `decodeJsonString()` for structured observability.
- Why it matters: Corrupt persisted/cache data becomes invisible, making operational debugging slower and masking upstream regressions.
- Recommendation: Standardize persisted JSON reads on `decodeJsonString()` and log decode failures with owner/context metadata.

#### Q5. Two UI components access `localStorage` without protection

- Severity: Medium
- Locations:
  - `src/components/sidebar.tsx:37-49`
  - `src/components/methodology-mode-toggle.tsx:22-36`
- Problem: Both components call `localStorage` synchronously without `try/catch`.
- Why it matters: Restrictive storage contexts, quota errors, or privacy modes can throw synchronously and break render-time initialization.
- Recommendation: Route these reads/writes through a shared safe-storage helper that returns defaults on failure.

#### Q6. `YieldHistoryChart` mixes data shaping, query fan-out, chart math, and rendering

- Severity: Medium
- Location: `src/components/yield-history-chart.tsx:322-520`
- Problem: The component owns source-selection policy, multiple query orchestration, overlay merging, tick/domain math, and view rendering.
- Why it matters: The component is hard to test in isolation and small visual changes can accidentally affect data behavior.
- Recommendation: Extract a `useYieldHistoryChartModel()` hook and keep the component focused on presentation.

#### Q7. `flow-machine-scene.tsx` couples geometry, animation policy, and rendering

- Severity: Medium
- Locations:
  - `src/components/flow-machine-scene.tsx:266-602`
  - `src/components/flow-machine-scene.tsx:609-879`
  - `src/components/flow-machine-scene.tsx:881-926`
- Problem: Printer geometry, shredder geometry, motion tuning, and JSX/CSS animation definitions are maintained in one file.
- Why it matters: The component is difficult to modify without regressions, especially for reduced-motion behavior and visual tuning.
- Recommendation: Split printer/shredder model builders from render components and move animation constants/keyframes into dedicated helpers or CSS modules.

#### Q8. `computeStressedGrades()` still lacks a real behavioral test

- Severity: Low
- Locations:
  - `shared/lib/report-cards.ts:835-872`
  - `shared/lib/__tests__/report-cards.test.ts:200-202`
- Problem: The current suite leaves the stressed-grade path behind an `it.todo`.
- Why it matters: This is scoring logic; untested override behavior increases regression risk in a methodology-sensitive area.
- Recommendation: Add explicit fixtures covering override application, unaffected coins, and grade transitions.

#### Q9. Versioned methodology content is stored as executable TypeScript

- Severity: Low
- Location: `shared/lib/safety-score-version.ts:3-405`
- Problem: Large methodology/version content is embedded directly in TS modules instead of a structured manifest or content file.
- Why it matters: Non-behavioral content changes create code churn, larger diffs, and harder review boundaries.
- Recommendation: Move version metadata/content into structured JSON/MDX or generate TS from a content manifest.

### Sustainability and Maintainability

#### S1. JWT verification does not refresh JWKS on `kid` miss

- Impact: High
- Locations:
  - `worker/src/lib/jwt-verify.ts:53-55`
  - `worker/src/lib/jwt-verify.ts:90-111`
  - `worker/src/lib/jwt-verify.ts:191-196`
- Issue: JWKS are cached for one hour, and if a token references a new `kid` during Cloudflare Access rotation, verification immediately returns `false` without forcing a refetch.
- Long-term consequence: Admin access can fail for up to the cache TTL after legitimate key rotation, creating brittle operational behavior during incidents or credential rollovers.
- Recommended remediation: On `kid` miss, bypass the cache once, refresh JWKS, retry key lookup, and add a regression test that simulates rotation.

#### S2. Public API rate limiting can run on a built-in fallback salt

- Impact: High
- Locations:
  - `worker/src/lib/env.ts:39`
  - `worker/src/lib/env.ts:114-135`
  - `worker/src/handlers/http/gates.ts:13-18`
  - `worker/src/handlers/http/gates.ts:44-51`
- Issue: Production can continue with a hardcoded repo-wide salt after only a warning log.
- Long-term consequence: Misconfiguration is easy to miss, environment isolation is weakened, and rate-limit key stability becomes tied to a checked-in constant.
- Recommended remediation: Require `PUBLIC_API_RATE_LIMIT_SALT` in production deploys, fail CI/deploy contract validation when absent, and keep `FEEDBACK_IP_SALT` fallback only for explicit local/dev profiles if still needed.

#### S3. `syncStablecoins()` remains a central orchestration hotspot

- Impact: High
- Locations:
  - `worker/src/cron/sync-stablecoins.ts:47-339`
  - Hotspot baseline: `scripts/lib/hotspot-ratchet-baseline.json:26-33`
  - Backlog note: `agents/plans/2026-03-29-hotspot-decomposition-backlog.md:12-15`
- Issue: Intake, pricing, validation, cache publication, fallback policy, and depeg pipeline control remain in one function.
- Long-term consequence: The most business-critical worker path is expensive to evolve and difficult to delegate across the team.
- Recommended remediation: Split into discrete orchestration stages with typed result contracts, then make the cron entrypoint a thin coordinator.

#### S4. Digest architecture is fragmented across multiple overlapping entrypoints

- Impact: High
- Locations:
  - `worker/src/cron/daily-digest.ts:59-423`
  - `worker/src/cron/daily-digest/collectors.ts:1-955`
  - `worker/src/cron/weekly-recap.ts:125-281`
- Issue: Daily and weekly digests share behavior but not infrastructure, and the collectors module remains broad even after some extraction.
- Long-term consequence: Each digest enhancement now risks divergence in prompts, parsing, failure semantics, and delivery policy.
- Recommended remediation: Create a single digest domain package with shared generation, parsing, persistence, and delivery flows plus separate daily/weekly input builders.

#### S5. `syncBlacklist()` still combines crawling, normalization, enrichment, and cursor policy

- Impact: High
- Locations:
  - `worker/src/cron/sync-blacklist.ts:73-449`
  - `worker/src/cron/sync-blacklist.ts:206-243`
  - `worker/src/cron/sync-blacklist.ts:286-323`
  - Hotspot baseline: `scripts/lib/hotspot-ratchet-baseline.json:162-168`
- Issue: Tron and EVM branches duplicate the same enrich/insert/current-balance pipeline after different fetch steps.
- Long-term consequence: Adding more blacklist families or cursor policies will amplify branching and increase regression risk.
- Recommended remediation: Isolate source crawling from a shared post-fetch pipeline (`enrich -> persist -> balance-cache -> cursor-advance`).

#### S6. `live-reserves-store.ts` owns too many roles

- Impact: High
- Locations:
  - `worker/src/lib/live-reserves-store.ts:230-318`
  - `worker/src/lib/live-reserves-store.ts:421-540`
  - `worker/src/lib/live-reserves-store.ts:553-629`
  - `worker/src/lib/live-reserves-store.ts:650-688`
  - `worker/src/lib/live-reserves-store.ts:735-780`
- Repeated consistency walks:
  - `worker/src/lib/live-reserves-store.ts:472-474`
  - `worker/src/lib/live-reserves-store.ts:578-581`
  - `worker/src/lib/live-reserves-store.ts:667-670`
  - `worker/src/lib/live-reserves-store.ts:751-763`
- Issue: The module mixes write paths, read paths, freshness overview, authoritative snapshot selection, metadata shaping, and final reserve-result presentation.
- Long-term consequence: Reserve-pipeline changes will remain high-risk and hard to review because one module sits on every live-reserve concern.
- Recommended remediation: Split write/store, read/query, snapshot-integrity, and presentation/view assembly into separate files with a shared parsing layer.

#### S7. `route-registry.ts` mixes route mapping with business logic and SQL

- Impact: Medium
- Locations:
  - `worker/src/route-registry.ts:151-189`
  - `worker/src/route-registry.ts:191-314`
  - `worker/src/route-registry.ts:340-370`
- Issue: The registry contains manual digest execution, idempotent admin actions, direct SQL for blacklist reset, and dynamic route business rules.
- Long-term consequence: The route table will keep growing into an application service layer, making entrypoint changes noisy and error-prone.
- Recommended remediation: Keep the registry declarative and move admin actions into dedicated handler modules or command services.

#### S8. Coverage page client remains a deferred hotspot

- Impact: Medium
- Locations:
  - `src/app/coverage/client.tsx:39-441`
  - Hotspot baseline: `scripts/lib/hotspot-ratchet-baseline.json:114-120`
  - Backlog note: `agents/plans/2026-03-29-hotspot-decomposition-backlog.md:71-74`
- Issue: One client component still owns model assembly, filtering, summary rendering, legend, cards, and table layout.
- Long-term consequence: Coverage-surface changes will continue to stack state and rendering concerns in one place.
- Recommended remediation: Extract a page model hook and split summary, filters, legend, and table sections into focused child components.

#### S9. Weekly recap lacks dedicated behavioral tests

- Impact: Medium
- Locations:
  - Production path: `worker/src/cron/weekly-recap.ts:125-281`
  - Current test touchpoint: `worker/src/__tests__/index.scheduled.test.ts:106`
- Issue: The only verified coverage in-tree is scheduler wiring via a mock; the weekly generation path itself has no dedicated behavior tests.
- Long-term consequence: Parser changes, prompt changes, and Telegram side effects are more likely to regress silently.
- Recommended remediation: Add a `worker/src/cron/__tests__/weekly-recap.test.ts` suite covering parse fallback, persistence metadata, circuit-open behavior, and Telegram posting.

#### S10. Dependency drift is low-risk now but should be scheduled

- Impact: Low
- Locations:
  - `package.json`
  - `worker/package.json`
- Issue: `npm outdated` only surfaced major-version drift on `eslint` (`9.39.4 -> 10.1.0`) and `typescript` (`5.9.3 -> 6.0.2`).
- Long-term consequence: Deferring toolchain majors too long increases the eventual migration jump and may hide deprecation cleanup work.
- Recommended remediation: Schedule an explicit tooling-upgrade branch after the structural refactors, with lint/type-baseline verification.

## 3. Cross-Cutting Concerns

### C1. Digest pipeline drift

- Connected findings: `R1`, `R2`, `Q1`, `Q2`, `S4`, `S9`
- Compound issue: Daily and weekly digest flows duplicate behavior, parse model output differently, expose inconsistent degraded-state handling, and lack uniform tests.
- Priority: Highest structural refactor after operational fixes because it touches product copy quality, delivery behavior, and maintainability together.

### C2. Fragmented client persistence strategy

- Connected findings: `R6`, `R7`, `Q5`
- Compound issue: Client storage behavior is implemented repeatedly, and two components already bypass safe storage guards.
- Priority: High quick-to-medium win because one shared storage adapter will remove duplication and harden browser-edge cases at the same time.

### C3. Worker hotspot concentration in core pipelines

- Connected findings: `Q2`, `Q3`, `S3`, `S5`, `S6`, `S7`, `S8`
- Compound issue: A small set of worker and page modules own too much orchestration and too many responsibilities, concentrating change risk in central paths.
- Priority: High because these hotspots define long-term team throughput more than isolated style issues.

### C4. Shared observability patterns are not applied consistently

- Connected findings: `Q1`, `Q4`, `S4`
- Compound issue: The codebase already has JSON decode observability helpers, but digest and status-related paths still prefer silent fallbacks.
- Priority: Medium; low implementation cost with good operational payoff.

### C5. Route metadata is not the single source of truth

- Connected findings: `R8`, `S7`
- Compound issue: Dynamic admin route authorization rules live partly in the Pages proxy and partly in the Worker router.
- Priority: Medium; important before more admin surfaces are added.

## 4. Prioritized Remediation Roadmap

### Phase 1 — Quick Wins

| Ref | Action | Scope | Effort | Depends on |
| --- | --- | --- | --- | --- |
| `S1` | Refresh JWKS on `kid` miss and add regression test | `worker/src/lib/jwt-verify.ts`, worker auth tests | Small | None |
| `S2` | Make public API rate-limit salt mandatory in production validation | `worker/src/lib/env.ts`, deploy/contract checks | Small | None |
| `R2` + `Q1` | Reuse shared digest parser for weekly recap and emit degraded metadata on fallback | `worker/src/cron/weekly-recap.ts`, `worker/src/cron/daily-digest/response.ts` | Small | None |
| `Q4` | Apply `decodeJsonString()` / `logMalformedJsonPath()` to silent JSON reads | `worker/src/api/digest-archive.ts`, `worker/src/lib/status-reliability.ts` | Small | None |
| `Q5` + `R6` | Add shared safe storage helpers and route sidebar/methodology mode through them | `src/lib/*`, `src/components/sidebar.tsx`, `src/components/methodology-mode-toggle.tsx` | Small | None |
| `R7` | Collapse Start Here state write to one helper | `src/hooks/use-start-here-callout.ts`, `src/components/start-here-visit-marker.tsx`, `src/lib/start-here-callout.ts` | Small | None |
| `Q8` | Replace `it.todo` with behavioral `computeStressedGrades()` coverage | `shared/lib/__tests__/report-cards.test.ts` | Small | None |
| `S10` | Open a scheduled tooling-upgrade task for ESLint and TypeScript majors | repo-wide tooling manifests | Small | None |

### Phase 2 — Targeted Refactoring

| Ref | Action | Scope | Effort | Depends on |
| --- | --- | --- | --- | --- |
| `R3` | Replace `useLogos()` plus direct JSON imports with one shared data module | `src/hooks/use-logos.ts`, logo consumers | Medium | None |
| `R4` | Extract shared active-route helper and shared nav actions | `src/components/header.tsx`, `src/components/sidebar.tsx` | Medium | None |
| `R5` | Convert chain detail page to band-driven UI rendering | `src/app/chains/[chain]/client.tsx`, `shared/lib/chain-health.ts`, `src/lib/chain-ui.ts` | Medium | None |
| `R6` + `Q5` | Consolidate persistence-heavy hooks onto a reusable storage adapter | `src/hooks/use-preferences.ts`, `src/hooks/use-command-palette-history.ts`, `src/hooks/use-portfolio.ts`, `src/hooks/use-start-here-callout.ts` | Medium | Phase 1 safe-storage helper |
| `S9` | Add dedicated weekly recap test suite | `worker/src/cron/__tests__/weekly-recap.test.ts` | Medium | Phase 1 weekly parser alignment |
| `S5` | Extract shared post-fetch blacklist processing | `worker/src/cron/sync-blacklist.ts` and blacklist helpers | Medium | None |
| `Q6` | Split `YieldHistoryChart` model logic from rendering | `src/components/yield-history-chart.tsx` | Medium | None |
| `Q7` | Separate flow machine scene model builders from visual components | `src/components/flow-machine-scene.tsx` | Medium | None |

### Phase 3 — Structural Improvements

| Ref | Action | Scope | Effort | Depends on |
| --- | --- | --- | --- | --- |
| `S7` + `R8` | Make route registry declarative and move dynamic admin path rules into shared metadata/services | `worker/src/route-registry.ts`, `functions/api/admin/[[path]].ts`, shared endpoint metadata | Large | None |
| `Q3` + `S6` | Split `status-reliability` and `live-reserves-store` by responsibility | `worker/src/lib/status-reliability.ts`, `worker/src/lib/live-reserves-store.ts` | Large | None |
| `S8` | Decompose coverage page into model hook plus section components | `src/app/coverage/client.tsx` and local coverage components | Large | None |
| `Q9` | Move versioned methodology content to structured content manifests | version/content modules and generators | Medium | None |

### Phase 4 — Strategic Overhauls

| Ref | Action | Scope | Effort | Depends on |
| --- | --- | --- | --- | --- |
| `S3` | Break `syncStablecoins()` into typed stages and a thin coordinator | `worker/src/cron/sync-stablecoins.ts` plus helper modules | Large | None |
| `R1` + `Q2` + `S4` | Build a unified digest domain layer for daily and weekly generation/publish flows | digest cron modules and shared helpers | Large | Phase 1 parser alignment |
| `S5` | Finish blacklist pipeline decomposition after shared post-fetch extraction proves stable | blacklist pipeline modules | Large | Phase 2 blacklist extraction |

## 5. Appendices

### Appendix A. Complete File-by-File Finding Index

| File | Finding IDs |
| --- | --- |
| `functions/api/admin/[[path]].ts` | `R8`, `S7` |
| `src/app/chains/[chain]/client.tsx` | `R3`, `R5` |
| `src/app/chains/client.tsx` | `R3` |
| `src/app/coverage/client.tsx` | `S8` |
| `src/app/stablecoin/[id]/page.tsx` | `R3` |
| `src/components/flow-machine-scene.tsx` | `Q7` |
| `src/components/header.tsx` | `R4` |
| `src/components/methodology-mode-toggle.tsx` | `R6`, `Q5` |
| `src/components/sidebar.tsx` | `R4`, `R6`, `Q5` |
| `src/components/start-here-visit-marker.tsx` | `R7` |
| `src/components/upcoming-client.tsx` | `R3` |
| `src/components/yield-history-chart.tsx` | `Q6` |
| `src/hooks/use-command-palette-history.ts` | `R6` |
| `src/hooks/use-logos.ts` | `R3` |
| `src/hooks/use-portfolio.ts` | `R6` |
| `src/hooks/use-preferences.ts` | `R6` |
| `src/hooks/use-start-here-callout.ts` | `R6`, `R7` |
| `shared/lib/__tests__/report-cards.test.ts` | `Q8` |
| `shared/lib/chain-health.ts` | `R5` |
| `shared/lib/report-cards.ts` | `Q8` |
| `shared/lib/safety-score-version.ts` | `Q9` |
| `worker/src/__tests__/index.scheduled.test.ts` | `S9` |
| `worker/src/api/digest-archive.ts` | `Q4` |
| `worker/src/cron/daily-digest.ts` | `R1`, `Q2`, `S4` |
| `worker/src/cron/daily-digest/collectors.ts` | `S4` |
| `worker/src/cron/daily-digest/response.ts` | `R2` |
| `worker/src/cron/sync-blacklist.ts` | `S5` |
| `worker/src/cron/sync-stablecoins.ts` | `S3` |
| `worker/src/cron/weekly-recap.ts` | `R1`, `R2`, `Q1`, `S4`, `S9` |
| `worker/src/handlers/http/gates.ts` | `S2` |
| `worker/src/lib/env.ts` | `S2` |
| `worker/src/lib/json-decode-observability.ts` | `Q4` |
| `worker/src/lib/jwt-verify.ts` | `S1` |
| `worker/src/lib/live-reserves-store.ts` | `S6` |
| `worker/src/lib/status-reliability.ts` | `Q3`, `Q4` |
| `worker/src/route-registry.ts` | `R8`, `S7` |

### Appendix B. Dependency Audit Summary

| Check | Result | Notes |
| --- | --- | --- |
| `npm run audit:deps` | Pass | No known vulnerabilities reported. |
| `npm audit --audit-level=high` | Pass | No vulnerabilities reported. |
| Lockfile integrity | Present | Root `package-lock.json` exists. |
| `npm outdated` | Minor drift only | Major updates available for `eslint` and `typescript`; no urgent package-health issue surfaced. |
| Shared-cycle check | Pass | `npm run check:shared-cycles` found no shared-lib cycles. |
| Duplicate export / dead code checks | Pass | `check:duplicate-exports` and `check:unused-code` were clean. |

### Appendix C. Glossary

- SRP: Single Responsibility Principle; one module/function should have one primary reason to change.
- God module / god function: a module or function that accumulates too many unrelated responsibilities.
- Structural clone: duplicated logic with superficial differences such as renamed variables or slightly different formatting.
- Circuit breaker: a guard that temporarily blocks an upstream integration after repeated failures.
- Idempotent action: an operation that can be retried without causing duplicated side effects.
- JWKS: JSON Web Key Set, used here to validate Cloudflare Access JWT signatures.
- Blast radius: the set of files or behaviors likely to be affected by changing a module.
- Hotspot baseline: the repo’s tracked complexity budget file used to prevent large files/functions from regrowing unchecked.
- Degraded mode: a state where the system continues operating but with reduced guarantees or partial data.
