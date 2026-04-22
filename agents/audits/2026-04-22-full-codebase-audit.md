# Full Codebase Audit - 2026-04-22

Scope: full repository review of `src/`, `shared/`, `worker/src/`, `functions/`, `scripts/`, selected docs, manifests, and CI/workflow files.

Evidence used:
- Repo structure and architecture docs: `docs/architecture.md`, `docs/api-reference.md`, `docs/testing.md`, `docs/worker-and-api-limits.md`
- Guardrails: `npm run check:unused-code`, `npm run check:shared-cycles`, `npm run check:duplicate-exports`, `npm audit --omit=dev`, `npm outdated --all`
- Verification: `npm test`, `npm run lint`, `npm run typecheck`, `cd worker && npx tsc --noEmit`
- Parallel specialist passes: redundancy, code quality, sustainability

Normalization note: redundancy findings do not have a native severity scale in the request, so this report assigns `High` / `Medium` / `Low` priority buckets to support cross-pillar prioritization.

## 1. Executive Summary

### Findings rollup

| Pillar | Total | High | Medium | Low | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| Redundancy elimination | 9 | 2 | 6 | 1 | Low dead-code signal, but real duplication in adapters, status UI, and build/runtime contracts |
| Code quality improvement | 6 | 3 | 2 | 1 | No critical defects found; risk is concentrated in a few large operational modules |
| Sustainability and maintainability | 7 | 2 | 4 | 1 | Strong guardrails, but hotspot backlog, catalog size, and runtime/tooling coupling remain material |
| Total | 22 | 7 | 12 | 3 | Significant issues are concentrated, not repo-wide |

### Top 5 findings

1. `Q-03` + `S-01`: `worker/src/cron/dispatch-telegram-alerts.ts` is an oversized operational coordinator and is already tripping the hotspot ratchet.
2. `Q-02` + `S-01`: `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts` still concentrates too much pricing-policy behavior in one module.
3. `S-02`: the stablecoin catalog is still maintained as a few very large JSON files, creating merge pressure and broad blast radius.
4. `Q-01`: Pages proxy layers drop upstream `Retry-After`, breaking documented client backoff semantics on degraded paths.
5. `S-04`: live reserve sync has an explicit scaling ceiling that will degrade by deferment as coverage grows.

### Health assessment

| Pillar | Score | Rationale |
| --- | ---: | --- |
| Redundancy elimination | 7/10 | Cycles, unused-code, and duplicate-export guardrails are clean, but there are real duplication pockets in adapters, status UI, and shared contract definitions |
| Code quality improvement | 6/10 | Lint, typecheck, and tests are clean, but a few core modules still combine too many responsibilities and one proxy bug materially affects client behavior |
| Sustainability and maintainability | 6/10 | Docs and CI discipline are unusually strong, but hotspot backlog, monolithic data sources, Node 25 coupling, and reserve-sync scaling keep long-term risk elevated |

### Technical debt profile

Estimated significant debt footprint: about `20%` of the audited source surface, concentrated in roughly `25` files/modules plus the three large stablecoin catalog JSONs. This is not a repo-wide hygiene failure; it is a localized architecture and hotspot-management problem.

### Verification summary

- `npm run check:unused-code`: passed
- `npm run check:shared-cycles`: passed
- `npm run check:duplicate-exports`: passed
- `npm audit --omit=dev`: passed with `0` production vulnerabilities
- `npm test`: passed, `585` files / `5,672` tests
- `npm run lint`: passed
- `npm run typecheck`: passed
- `cd worker && npx tsc --noEmit`: passed
- `npm run check:hotspot-ratchet`: failed on `worker/src/cron/dispatch-telegram-alerts.ts` growth, which is itself a finding in this report

## 2. Findings by Pillar

### 2.1 Redundancy Elimination

#### R-01 - Repeated redemption metadata blocks in reserve adapters
- Priority: `Medium`
- Locations:
  - `worker/src/cron/reserve-adapters/buck-io-transparency.ts:98-104`
  - `worker/src/cron/reserve-adapters/circle-transparency.ts:153-159`
  - `worker/src/cron/reserve-adapters/sgforge-coinvertible.ts:118-124`
  - `worker/src/cron/reserve-adapters/usdh-native-markets.ts:110-116`
- Problem: identical documented-bound / verified-customer redemption metadata is hand-built in multiple adapters.
- Why it matters: policy or schema changes will drift across adapters unless every copy is patched.
- Consolidation strategy: extract a shared helper that returns the standard redemption metadata envelope from minimal adapter inputs such as `sourceTimestamp`.
- Confidence: `High`

#### R-02 - Repeated optional redemption-rate probe logic
- Priority: `Medium`
- Locations:
  - `worker/src/cron/reserve-adapters/evm-branch-balances.ts:32-43`
  - `worker/src/cron/reserve-adapters/liquity-v1.ts:77-86`
  - `worker/src/cron/reserve-adapters/liquity-v2-branches.ts:124-135`
- Problem: the same `fetchOnchainRateBps(...)` plus fallback-to-null flow is duplicated across three EVM adapters.
- Why it matters: fixes to timeout, error policy, or probe semantics must be replicated manually.
- Consolidation strategy: introduce a shared `maybeFetchRedemptionRateBps(...)` helper.
- Confidence: `High`

#### R-03 - Duplicated risk-free benchmark loader
- Priority: `High`
- Locations:
  - `worker/src/cron/fetch-tbill-rate.ts:161-192`
  - `worker/src/cron/yield-sync/sources-riskfree.ts:53-86`
- Problem: the same multi-cache lookup plus legacy USD fallback logic exists in both the legacy benchmark fetch path and the yield-sync path.
- Why it matters: this is transitional duplication in a benchmark path that influences downstream yield logic.
- Consolidation strategy: centralize the loader into one utility and make both callers consume it.
- Confidence: `High`

#### R-04 - Repeated API-key SQL projection lists
- Priority: `Medium`
- Locations:
  - `worker/src/lib/api-key-admin.ts:28-45`
  - `worker/src/lib/api-key-admin.ts:73-102`
  - `worker/src/lib/api-key-core.ts:307-325`
  - `worker/src/lib/api-key-core.ts:443-460`
  - `worker/src/lib/api-key-core.ts:467-483`
- Problem: `api_keys` column projection lists are repeated across list/create/select paths with only minor differences.
- Why it matters: schema changes can silently drift between admin and core paths.
- Consolidation strategy: define canonical public/private projection fragments once and reuse them.
- Confidence: `High`

#### R-05 - Repeated severity badge class mappings in status UI
- Priority: `Medium`
- Locations:
  - `src/lib/status-dashboard-model.ts:173-176`
  - `src/components/status/status-facts.tsx:69-76`
  - `src/components/status/transition-timeline.tsx:111-118`
  - `src/components/status/recommended-action-strip.tsx:43-50`
  - `src/components/status/admin-actions-panel.tsx:100-107`
- Problem: `getSeverityBadgeClass()` exists, but identical severity-to-class mappings are still inlined in multiple status components.
- Why it matters: visual semantics can drift across the status surface.
- Consolidation strategy: route all severity pill rendering through the shared helper or a dedicated `SeverityBadge` component.
- Confidence: `High`

#### R-06 - Duplicated `DigestEntry` contract across build and runtime
- Priority: `Medium`
- Locations:
  - `scripts/lib/markdown-renderers.ts:38-46`
  - `src/app/digest/[date]/page.tsx:13-21`
- Problem: the digest data contract for `data/digests.json` is defined twice.
- Why it matters: a data-shape change can break either build-time markdown generation or runtime rendering without type-level coupling.
- Consolidation strategy: move the type into a shared module consumed by both script and app code.
- Confidence: `High`

#### R-07 - Repeated AI summary shape under local aliases
- Priority: `Low`
- Locations:
  - `scripts/lib/markdown-renderers.ts:32-36`
  - `src/lib/stablecoin-detail-view-model.ts:44-48`
  - `src/components/ai-summary.tsx:4-8`
  - `src/components/stablecoin-detail/notices-and-summary-section.tsx:8-12`
  - `src/components/stablecoin-detail/overview-section.tsx:12-16`
- Problem: the same `title/text/updatedAt` summary shape is redefined under multiple local names.
- Why it matters: low-level shape drift is easy and adds type noise across layers.
- Consolidation strategy: export a single summary contract and reuse it end-to-end.
- Confidence: `High`

#### R-08 - Stablecoin detail hook/builder split is mostly a transport abstraction
- Priority: `Medium`
- Locations:
  - `src/hooks/use-stablecoin-detail-view-model.ts:32-149`
  - `src/lib/stablecoin-detail-view-model.ts:121-161`
  - `src/lib/stablecoin-detail-view-model.ts:210-250`
- Problem: the hook mostly gathers query outputs and forwards them field-by-field into a single-use builder with a very wide parameter surface.
- Why it matters: this adds indirection without materially reducing coupling.
- Consolidation strategy: either collapse the builder into the hook, or group inputs into typed sub-objects such as `queries`, `freshness`, and `auxiliary`.
- Confidence: `Medium`

#### R-09 - Status UI redefines shapes already owned by shared status types
- Priority: `High`
- Locations:
  - `shared/types/status.ts:99-118`
  - `shared/types/status.ts:120-124`
  - `shared/types/status.ts:126-152`
  - `shared/types/status.ts:167-195`
  - `shared/types/status.ts:574-579`
  - `src/components/status/system-diagnostics.tsx:18-69`
  - `src/components/status/data-quality-cards.tsx:10-38`
  - `src/components/status/uptime-bar.tsx:7-12`
- Problem: local status prop shapes overlap with canonical shared status types instead of consuming them.
- Why it matters: responsibility for the status contract is split between the shared type layer and the UI layer.
- Consolidation strategy: use shared types directly or compose UI props from shared slices plus small local additions.
- Confidence: `High`

Dead code / stale flags / stale config:
- No high-confidence dead-code finding was confirmed. `check:unused-code` reported no dead internal modules or unused named exports.

Redundant dependencies:
- No safe dependency removals were confirmed. Workspace-scoped duplication appears intentional rather than redundant.

### 2.2 Code Quality Improvement

#### Q-01 - Proxy layers drop `Retry-After`
- Severity: `High`
- Locations:
  - `functions/api/admin/[[path]].ts:21-38`
  - `functions/api/admin/[[path]].ts:80-85`
  - `functions/_site-data/[[path]].ts:24-46`
  - `functions/_site-data/[[path]].ts:79-81`
  - `functions/lib/proxy-utils.ts:51-68`
- Problem: both Pages proxies rebuild responses from a small header allowlist and omit upstream `Retry-After`.
- Why it matters: this breaks the documented client backoff contract for `429` / `503` / `504` responses and can cause clients to hammer degraded upstreams.
- Remediation: include `Retry-After` in both proxy allowlists, or preserve it by default for error responses in `buildProxyResponse()`. Add tests for `429` and timeout cases.
- Confidence: `High`

#### Q-02 - Primary pricing pipeline is still too concentrated
- Severity: `High`
- Locations:
  - `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts:339-451`
  - `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts:458-787`
  - `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts:793-887`
  - `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts:917-1005`
- Problem: provider fan-out, consensus building, disagreement diagnostics, DEX challenge replacement, and GT reprobe mutation are still concentrated in one module.
- Why it matters: this is a high-impact data-quality path where unrelated changes are still coupled together.
- Remediation: split by stable phase boundaries: provider collection, normalization, consensus selection, post-consensus hardening, and reprobe mutation.
- Confidence: `High`

#### Q-03 - Telegram alert dispatch violates SRP on an operational path
- Severity: `High`
- Location: `worker/src/cron/dispatch-telegram-alerts.ts:268-728`
- Problem: one function owns circuit gating, snapshot seeding, DB reads, event diffing, subscriber resolution, quiet-hours suppression, queue budgeting, delivery, cleanup, and final breaker outcome.
- Why it matters: failures are harder to localize, and the hotspot ratchet is already failing on this file.
- Remediation: extract pure phases for snapshot loading/diffing, subscriber routing, delivery scheduling, and result aggregation, then keep a thin orchestration shell.
- Confidence: `High`

#### Q-04 - Feedback limiter/storage failures collapse into generic `500`
- Severity: `Medium`
- Locations:
  - `worker/src/api/feedback.ts:9-25`
  - `worker/src/api/feedback/request.ts:68-76`
  - `worker/src/lib/rate-limit.ts:151-191`
- Problem: feedback limiter or D1 dependency failures bubble into generic error handling instead of a specific degraded-service response.
- Why it matters: this is inconsistent with other API dependency-failure behavior and obscures retry semantics.
- Remediation: return `503` plus `Retry-After` on feedback-limiter/storage dependency failure, or add a feedback-specific dependency-failure branch before the generic wrapper.
- Confidence: `High`

#### Q-05 - `ContagionGraph` mixes too many behaviors for its test surface
- Severity: `Medium`
- Locations:
  - `src/components/contagion-graph.tsx:44-641`
  - `src/components/__tests__/contagion-graph.test.tsx:117-143`
- Problem: graph preparation, simulation state, drag handling, keyboard navigation, neighborhood filtering, hover/ripple logic, tooltip construction, and SVG rendering all live in one client component, while direct tests cover only a small interaction subset.
- Why it matters: regression diagnosis is hard and interaction behavior is only partially pinned.
- Remediation: move drag logic, hover/ripple derivation, and tooltip view-model generation into focused helpers/hooks; add tests for drag persistence, edge hover, and neighborhood visibility.
- Confidence: `High`

#### Q-06 - Frontend fetch wrapper has no standard timeout or cancellation path
- Severity: `Low`
- Locations:
  - `src/lib/api.ts:69-74`
  - `src/lib/api.ts:200-290`
- Problem: the shared fetch wrapper has no built-in timeout or standard cancellation strategy.
- Why it matters: dashboard queries can wait on browser/network defaults instead of aligning with documented worker/proxy budgets.
- Remediation: thread an optional `AbortSignal` through helpers and offer a standard timeout wrapper for callers that do not supply one.
- Confidence: `Medium`

### 2.3 Sustainability and Maintainability

#### S-01 - Hotspot backlog is concentrated in live production paths
- Impact: `High`
- Scope:
  - `worker/src/cron/dispatch-telegram-alerts.ts:268`
  - `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts:203`
  - `worker/src/lib/mint-burn-contracts.ts:109`
  - `scripts/lib/hotspot-ratchet-baseline.json`
  - `scripts/lib/hotspot-ratchet-waivers.json`
- Issue: the highest-change production paths still mix orchestration, provider policy, data shaping, and side effects in oversized modules. The hotspot ratchet is currently failing on `dispatch-telegram-alerts.ts`.
- Long-term consequence: every change in alerting, pricing, or mint/burn stays review-heavy and regression-prone, while the hotspot program risks becoming a waiver ledger.
- Recommended remediation: continue splitting by phase boundaries, not arbitrary helpers. Each hot path should separate planning, provider fetches, consensus/scoring, persistence, and delivery.
- Confidence: `High`

#### S-02 - Stablecoin catalog is still monolithic
- Impact: `High`
- Scope:
  - `shared/data/stablecoins/usd-minor.json`
  - `shared/data/stablecoins/usd-major.json`
  - `shared/data/stablecoins/non-usd.json`
  - `shared/lib/stablecoins/registry.ts`
- Issue: core catalog data is still maintained in a few very large category JSON files and loaded into repo-wide globals.
- Long-term consequence: high merge-conflict pressure, broad review blast radius, and unclear ownership for single-coin changes.
- Recommended remediation: move to smaller source units, ideally per-coin or per-family files plus a generated aggregate that preserves the current registry API.
- Confidence: `High`

#### S-03 - Toolchain is hard-coupled to Node 25
- Impact: `Medium`
- Scope:
  - `package.json:9`
  - `worker/package.json:5`
  - `scripts/check-worker-migrations.mjs:142`
  - `.github/actions/setup-workspace/action.yml:4`
  - `.github/workflows/deploy-cloudflare.yml:25`
- Issue: local dev, CI, and migration tooling all rely on Node 25 behavior, including `--env-file-if-exists` and `node:sqlite`.
- Long-term consequence: the repo inherits the upgrade burden of an odd-numbered, non-LTS runtime and tighter ecosystem coupling.
- Recommended remediation: reduce the minimum runtime to the current LTS line where feasible, isolate Node-version-specific helpers, and add an LTS CI lane before the next toolchain refresh.
- Confidence: `High`

#### S-04 - Live reserve sync has a built-in scaling ceiling
- Impact: `Medium`
- Scope:
  - `docs/live-reserves.md:9`
  - `worker/src/cron/sync-live-reserves.ts:21`
  - `worker/src/cron/sync-live-reserves.ts:150`
  - `worker/src/cron/reserve-adapters/index.ts`
- Issue: reserve sync currently scales by sequential coin processing with a fixed run budget and per-attempt timeout.
- Long-term consequence: adding coverage or hitting slower upstreams will degrade by deferment/queueing rather than isolated source failure.
- Recommended remediation: shard the work by adapter family or coin partitions, persist resume state explicitly, and expose deferred-tail metrics as first-class signals.
- Confidence: `High`

#### S-05 - Env/config contract is well-checked but still too fragmented
- Impact: `Medium`
- Scope:
  - `.env.example:21`
  - `worker/src/lib/env.ts`
  - `functions/lib/ops-env.ts`
  - `functions/lib/site-api-env.ts`
  - `scripts/check-env-contract.mjs:6`
- Issue: the same logical config domains appear across worker, Pages Functions, and CI/service-token flows in different active/reserved forms.
- Long-term consequence: onboarding and secret rotation remain cognitively expensive, and cross-runtime drift is more likely.
- Recommended remediation: promote the env contract to a single typed manifest that generates `.env.example`, docs snippets, and runtime-specific active/reserved views.
- Confidence: `Medium-High`

#### S-06 - Several flagship UI surfaces are still waived large modules
- Impact: `Medium`
- Scope:
  - `src/components/contagion-graph.tsx:44`
  - `src/app/stability-index/client.tsx`
  - `src/app/safety-scores/client.tsx`
  - `src/components/stablecoin-detail/hero-card.tsx:57`
  - `scripts/lib/hotspot-ratchet-waivers.json`
- Issue: multiple high-visibility UI surfaces still combine state, view-model shaping, and rendering in single large route/components and are explicitly waived rather than decomposed.
- Long-term consequence: iteration slows and regression risk grows on already complex routes.
- Recommended remediation: keep route shells thin, move graph math/view-model logic out of render modules, and continue decomposing by section/hook boundary.
- Confidence: `High`

#### S-07 - The custom verification layer is itself a large subsystem
- Impact: `Low`
- Scope:
  - `package.json:12`
  - `scripts/smoke-ui.mjs`
  - `scripts/check-unused-code.mjs`
  - `scripts/lib/doc-sync/checks.ts`
  - `.github/workflows/deploy-cloudflare.yml`
- Issue: the repo’s quality system is strong but large: 53 root scripts, about 12k lines of scripts, and 10 workflow files.
- Long-term consequence: maintainers must keep both the product and a bespoke verification platform healthy.
- Recommended remediation: treat the guardrail layer as a product with explicit ownership, consolidate where a standard tool can replace a custom checker, and periodically retire redundant custom code.
- Confidence: `Medium`

## 3. Cross-Cutting Concerns

### CC-01 - Telegram delivery path is both a quality hotspot and a maintainability hotspot
- Connected findings: `Q-03`, `S-01`
- Scope: `worker/src/cron/dispatch-telegram-alerts.ts`
- Why it matters: the same file is simultaneously too large for safe change, already failing the hotspot ratchet, and responsible for a user-facing operational path.
- Recommended response: make this the first structural refactor target after quick proxy fixes.

### CC-02 - Pricing pipeline concentration combines duplication, code quality risk, and hotspot debt
- Connected findings: `R-03`, `Q-02`, `S-01`
- Scope: `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`, `worker/src/cron/fetch-tbill-rate.ts`, `worker/src/cron/yield-sync/sources-riskfree.ts`
- Why it matters: critical pricing logic is still concentrated, and parts of the benchmark-loading behavior exist in two places.
- Recommended response: centralize shared benchmark loading first, then split the primary pricing module by stable phases.

### CC-03 - Status surface has duplicated logic, duplicated types, and UI growth debt
- Connected findings: `R-05`, `R-09`, `S-06`
- Scope: `src/components/status/**`, `src/lib/status-dashboard-model.ts`, `shared/types/status.ts`
- Why it matters: the status surface is drifting on both presentation logic and contract ownership while also remaining a waived hotspot area.
- Recommended response: unify shared status types first, then centralize severity badge rendering, then split large route/components.

### CC-04 - Shared contract drift exists across build-time scripts, runtime pages, and view-model layers
- Connected findings: `R-06`, `R-07`, `R-08`, `S-05`
- Scope: `scripts/lib/markdown-renderers.ts`, `src/app/digest/[date]/page.tsx`, stablecoin-detail view-model and summary components
- Why it matters: multiple low-level types are duplicated across script/runtime boundaries, which increases drift risk every time data contracts evolve.
- Recommended response: create a small shared contract layer for digest and summary payloads before further feature work.

### CC-05 - Stablecoin catalog size amplifies every other change
- Connected findings: `S-02`, indirectly `Q-02`, `S-04`
- Scope: `shared/data/stablecoins/*.json`, `shared/lib/stablecoins/registry.ts`
- Why it matters: catalog edits have broad downstream impact on pricing, reserve sync, UI routes, and docs, yet the source units are still coarse-grained.
- Recommended response: move to finer-grained source files plus generation so downstream systems keep the same registry API.

## 4. Prioritized Remediation Roadmap

### Phase 1 - Quick Wins

| Ref | Action | Scope | Effort | Depends on |
| --- | --- | --- | --- | --- |
| `Q-01` | Preserve `Retry-After` through both proxy layers and add regression tests for `429` / timeout responses | `functions/api/admin/[[path]].ts`, `functions/_site-data/[[path]].ts`, `functions/lib/proxy-utils.ts` | Small | None |
| `R-01`, `R-02` | Extract shared reserve-adapter helpers for redemption metadata and optional redemption-rate probes | `worker/src/cron/reserve-adapters/**` | Small | None |
| `R-04` | Centralize API-key SQL projection fragments | `worker/src/lib/api-key-admin.ts`, `worker/src/lib/api-key-core.ts` | Small | None |
| `R-05` | Centralize severity pill rendering via helper/component | `src/components/status/**`, `src/lib/status-dashboard-model.ts` | Small | None |
| `R-06`, `R-07` | Move digest and summary contracts into shared modules | `scripts/lib/markdown-renderers.ts`, `src/app/digest/[date]/page.tsx`, stablecoin-detail summary files | Small | None |
| Dependency hygiene | Apply low-risk direct patch/minor updates: `@tailwindcss/postcss`, `tailwindcss`, `@tanstack/react-query`, `@tanstack/react-virtual`, `vitest`, `@vitest/coverage-v8`, `viem`, `wrangler`, `@cloudflare/workers-types` | `package.json`, `worker/package.json`, lockfile | Small | None |

### Phase 2 - Targeted Refactoring

| Ref | Action | Scope | Effort | Depends on |
| --- | --- | --- | --- | --- |
| `Q-04` | Give feedback limiter/storage failures explicit degraded-service responses | `worker/src/api/feedback.ts`, `worker/src/api/feedback/request.ts`, `worker/src/lib/rate-limit.ts` | Small | `Q-01` recommended but not required |
| `Q-05`, `S-06` | Split `ContagionGraph` into render shell plus hooks/helpers and expand interaction tests | `src/components/contagion-graph.tsx`, `src/components/__tests__/contagion-graph.test.tsx` | Medium | None |
| `R-08` | Collapse or narrow the stablecoin-detail view-model transport abstraction | `src/hooks/use-stablecoin-detail-view-model.ts`, `src/lib/stablecoin-detail-view-model.ts` | Medium | `R-07` |
| `R-09` | Replace local status prop/type redefinitions with shared status contracts | `shared/types/status.ts`, `src/components/status/system-diagnostics.tsx`, `src/components/status/data-quality-cards.tsx`, `src/components/status/uptime-bar.tsx` | Medium | `R-05` |
| `R-03` | Centralize benchmark loader before further yield/pricing work | `worker/src/cron/fetch-tbill-rate.ts`, `worker/src/cron/yield-sync/sources-riskfree.ts` | Medium | None |

### Phase 3 - Structural Improvements

| Ref | Action | Scope | Effort | Depends on |
| --- | --- | --- | --- | --- |
| `Q-03`, `S-01` | Decompose Telegram alert dispatch into snapshot/diff, routing, scheduling, delivery, and result phases | `worker/src/cron/dispatch-telegram-alerts.ts` plus adjacent telegram modules | Large | Phase 1 proxy fix recommended |
| `Q-02`, `S-01` | Split the primary pricing path into provider collection, normalization, consensus, hardening, and reprobe stages | `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts` | Large | `R-03` |
| `S-05` | Replace fragmented env contract maintenance with one typed manifest that generates docs/example views | `worker/src/lib/env.ts`, `functions/lib/*env.ts`, `scripts/check-env-contract.mjs`, `.env.example` | Medium | None |
| `S-06` | Continue hotspot retirement for waived frontend route/components | `src/app/stability-index/client.tsx`, `src/app/safety-scores/client.tsx`, `src/components/stablecoin-detail/hero-card.tsx` | Medium | Shared type/contract cleanup helps |
| `S-07` | Review custom guardrail scripts and retire any checker that can be replaced safely by standard tooling | `scripts/**`, `.github/workflows/**` | Medium | None |

### Phase 4 - Strategic Overhauls

| Ref | Action | Scope | Effort | Depends on |
| --- | --- | --- | --- | --- |
| `S-02` | Replace monolithic stablecoin catalog files with per-coin or per-family sources plus generated aggregate | `shared/data/stablecoins/*.json`, `shared/lib/stablecoins/registry.ts`, generation scripts | Large | None |
| `S-04` | Shard live reserve sync by adapter family or partitions and expose deferred-tail metrics | `worker/src/cron/sync-live-reserves.ts`, `worker/src/cron/reserve-adapters/**`, status telemetry | Large | `S-02` helpful but not required |
| `S-03` | Reduce or eliminate Node 25 lock-in and add LTS CI coverage | `package.json`, `worker/package.json`, workflows, migration tooling | Large | None |
| `S-01` | Convert hotspot backlog from waiver inventory into an explicit retirement program with dated owners/targets | `scripts/lib/hotspot-ratchet-baseline.json`, `scripts/lib/hotspot-ratchet-waivers.json`, hotspot files | Large | Structural splits in Phase 3 |

## 5. Appendices

### Appendix A - File-by-File Finding Index

- `.env.example` -> `S-05`
- `.github/actions/setup-workspace/action.yml` -> `S-03`
- `.github/workflows/deploy-cloudflare.yml` -> `S-03`, `S-07`
- `functions/_site-data/[[path]].ts` -> `Q-01`
- `functions/api/admin/[[path]].ts` -> `Q-01`
- `functions/lib/ops-env.ts` -> `S-05`
- `functions/lib/proxy-utils.ts` -> `Q-01`
- `functions/lib/site-api-env.ts` -> `S-05`
- `package.json` -> `S-03`, `S-07`
- `scripts/check-env-contract.mjs` -> `S-05`
- `scripts/check-worker-migrations.mjs` -> `S-03`
- `scripts/lib/doc-sync/checks.ts` -> `S-07`
- `scripts/lib/hotspot-ratchet-baseline.json` -> `S-01`
- `scripts/lib/hotspot-ratchet-waivers.json` -> `S-01`, `S-06`
- `scripts/lib/markdown-renderers.ts` -> `R-06`, `R-07`
- `scripts/smoke-ui.mjs` -> `S-07`
- `shared/data/stablecoins/non-usd.json` -> `S-02`
- `shared/data/stablecoins/usd-major.json` -> `S-02`
- `shared/data/stablecoins/usd-minor.json` -> `S-02`
- `shared/lib/stablecoins/registry.ts` -> `S-02`
- `shared/types/status.ts` -> `R-09`
- `src/app/digest/[date]/page.tsx` -> `R-06`
- `src/app/safety-scores/client.tsx` -> `S-06`
- `src/app/stability-index/client.tsx` -> `S-06`
- `src/components/__tests__/contagion-graph.test.tsx` -> `Q-05`
- `src/components/ai-summary.tsx` -> `R-07`
- `src/components/contagion-graph.tsx` -> `Q-05`, `S-06`
- `src/components/stablecoin-detail/hero-card.tsx` -> `S-06`
- `src/components/stablecoin-detail/notices-and-summary-section.tsx` -> `R-07`
- `src/components/stablecoin-detail/overview-section.tsx` -> `R-07`
- `src/components/status/admin-actions-panel.tsx` -> `R-05`
- `src/components/status/data-quality-cards.tsx` -> `R-09`
- `src/components/status/recommended-action-strip.tsx` -> `R-05`
- `src/components/status/status-facts.tsx` -> `R-05`
- `src/components/status/system-diagnostics.tsx` -> `R-09`
- `src/components/status/transition-timeline.tsx` -> `R-05`
- `src/components/status/uptime-bar.tsx` -> `R-09`
- `src/hooks/use-stablecoin-detail-view-model.ts` -> `R-08`
- `src/lib/api.ts` -> `Q-06`
- `src/lib/stablecoin-detail-view-model.ts` -> `R-07`, `R-08`
- `src/lib/status-dashboard-model.ts` -> `R-05`
- `worker/package.json` -> `S-03`
- `worker/src/api/feedback.ts` -> `Q-04`
- `worker/src/api/feedback/request.ts` -> `Q-04`
- `worker/src/cron/dispatch-telegram-alerts.ts` -> `Q-03`, `S-01`
- `worker/src/cron/fetch-tbill-rate.ts` -> `R-03`
- `worker/src/cron/reserve-adapters/buck-io-transparency.ts` -> `R-01`
- `worker/src/cron/reserve-adapters/circle-transparency.ts` -> `R-01`
- `worker/src/cron/reserve-adapters/evm-branch-balances.ts` -> `R-02`
- `worker/src/cron/reserve-adapters/index.ts` -> `S-04`
- `worker/src/cron/reserve-adapters/liquity-v1.ts` -> `R-02`
- `worker/src/cron/reserve-adapters/liquity-v2-branches.ts` -> `R-02`
- `worker/src/cron/reserve-adapters/sgforge-coinvertible.ts` -> `R-01`
- `worker/src/cron/reserve-adapters/usdh-native-markets.ts` -> `R-01`
- `worker/src/cron/sync-live-reserves.ts` -> `S-04`
- `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts` -> `Q-02`, `S-01`
- `worker/src/cron/yield-sync/sources-riskfree.ts` -> `R-03`
- `worker/src/lib/api-key-admin.ts` -> `R-04`
- `worker/src/lib/api-key-core.ts` -> `R-04`
- `worker/src/lib/env.ts` -> `S-05`
- `worker/src/lib/mint-burn-contracts.ts` -> `S-01`
- `worker/src/lib/rate-limit.ts` -> `Q-04`

### Appendix B - Dependency Audit Summary

| Package | Current | Latest | Delta | Comment |
| --- | --- | --- | --- | --- |
| `@tailwindcss/postcss` | `4.2.2` | `4.2.4` | Patch | Low-risk update candidate |
| `tailwindcss` | `4.2.2` | `4.2.4` | Patch | Low-risk update candidate |
| `@tanstack/react-query` | `5.99.0` | `5.99.2` | Patch | Low-risk update candidate |
| `@tanstack/react-virtual` | `3.13.23` | `3.13.24` | Patch | Low-risk update candidate |
| `vitest` | `4.1.4` | `4.1.5` | Patch | Low-risk update candidate |
| `@vitest/coverage-v8` | `4.1.4` | `4.1.5` | Patch | Keep in sync with Vitest |
| `viem` | `2.48.0` | `2.48.4` | Patch | Low-risk update candidate |
| `wrangler` | `4.83.0` | `4.84.1` | Patch | Keep Cloudflare toolchain current |
| `@cloudflare/workers-types` | `4.20260416.2` | `4.20260422.1` | Weekly release | Keep aligned with Wrangler cadence |
| `eslint` | `9.39.4` | `10.2.1` | Major | Plan, do not fast-track |
| `typescript` | `5.9.3` | `6.0.3` | Major | Plan, do not fast-track; also tied to `S-03` |

Other audit notes:
- `npm audit --omit=dev` reported `0` production vulnerabilities.
- No clear abandoned-package or duplicate-library removal was confirmed.
- Dependency lag is mostly patch/minor plus the expected major jumps for `eslint` and `typescript`.

### Appendix C - Glossary

- `SRP`: Single Responsibility Principle. A module should have one primary reason to change.
- `Hotspot ratchet`: Repo guardrail that tracks file size, function size, and branch-count growth in explicitly watched files.
- `Waiver`: Temporary allowance for a known hotspot to remain above target budget.
- `D1`: Cloudflare SQLite-compatible database used by the worker.
- `Pages Function`: Cloudflare Pages edge function used here as a same-origin proxy layer.
- `Adapter`: Source-specific integration module that maps one external provider into the shared reserve/yield model.
- `LTS`: Long-term support runtime line with a longer maintenance window than a current odd-numbered release.
- `Transport abstraction`: An abstraction that mostly forwards data between layers without meaningfully reducing coupling or complexity.
