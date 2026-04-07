# Comprehensive Codebase Remediation Blueprint

Date: 2026-04-06  
Repository: `stablecoin-dashboard`

Audit scope covered the complete repository inventory: 608 files under `src/`, 700 under `worker/src/`, 155 under `shared/`, 14 under `functions/`, 55 under `scripts/`, and 62 under `docs/`. The audit was run as a coordinated three-agent review, then reconciled against local guardrails and static checks: `npm run check:unused-code`, `npm run check:shared-cycles`, `npm run check:hotspot-ratchet`, `npm run check:duplicate-exports`, `npm run check:doc-counts`, `npm run check:doc-sync`, `npm run lint`, `npm run typecheck`, `cd worker && npx tsc --noEmit`, `npm audit --audit-level=high --omit=dev --json`, and `npm outdated --json`.

## 1. Executive Summary

### Findings Count

| Pillar | Critical | High | Medium | Low | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Redundancy elimination | 0 | 1 | 3 | 0 | 4 |
| Code quality improvement | 1 | 2 | 6 | 0 | 9 |
| Sustainability / maintainability | 0 | 3 | 5 | 1 | 9 |
| **Total** | **1** | **6** | **14** | **1** | **22** |

Redundancy debt is real but narrower than the other two pillars. Most of it sits in stale governance data, duplicated metadata parsing, and a thin abstraction that no longer earns its keep. The heavier risk is in worker correctness and long-term architectural control.

### Top 5 Most Critical Findings

1. **CQ-01 — Invalid `X-API-Key` requests on public protected routes bypass the public IP rate limiter before failing auth.**  
   `worker/src/handlers/http/gates.ts:94-149`, `worker/src/lib/api-keys.ts:336-389`  
   Effect: an attacker can force D1-backed auth work and skip the intended `public_api_rate_limit` path on bad-key traffic.

2. **CQ-02 — DEWS drops the 30-day mint/burn baseline whenever a stablecoin has no last-24h rows.**  
   `worker/src/cron/compute-dews.ts:448-500`, `worker/src/cron/compute-dews.ts:597-666`, `worker/src/lib/dews.ts:479-487`  
   Effect: valid historical flow context is silently discarded, degrading a published risk signal.

3. **CQ-03 — DEX-liquidity post-scoring uses a fake `{ cnt: 9999 }` previous-coverage sentinel that can trip the hard coverage guard and fail the cron.**  
   `worker/src/cron/dex-liquidity/orchestrator-metadata.ts:263-270`, `worker/src/cron/dex-liquidity/orchestrator-metadata.ts:342-344`, `worker/src/cron/dex-liquidity/orchestrator.ts:291-294`  
   Effect: an upstream read failure can cascade into a false hard-stop instead of a degraded-but-safe run.

4. **S-01 — Import-cycle enforcement only covers `shared/`, while real worker cycles already exist in production code.**  
   `scripts/check-shared-cycles.mjs:5`, `worker/src/lib/live-reserves-store-shared.ts:10`, `worker/src/lib/live-reserves-store-parsing.ts:23-28`, `worker/src/cron/sync-stablecoins/stages.ts:9-10,26-30`, `worker/src/cron/sync-stablecoins/fallback.ts:2-5,27-32`, `worker/src/cron/sync-stablecoins/intake.ts:8-14`, `worker/src/cron/sync-stablecoins/runtime.ts:1-2`  
   Effect: the repo’s architecture checks are giving false confidence in the subsystem with the highest change rate.

5. **S-02 — `sync-stablecoins` is still a tightly coupled monolith even after the recent file split.**  
   `worker/src/cron/sync-stablecoins.ts:66-208`, `worker/src/cron/sync-stablecoins/stages.ts:431-574`, `worker/src/cron/sync-stablecoins/fallback.ts:124-356`  
   Effect: ingestion behavior remains hard to isolate, hard to test independently, and easy to regress during pricing or fallback changes.

### Codebase Health Assessment

| Pillar | Score | Justification |
| --- | ---: | --- |
| Redundancy elimination | 6/10 | Basic hygiene is good: unused-code, duplicate-export, and hotspot checks all run. The remaining redundancy is concentrated in stale hotspot governance data, duplicated status parsing, and a wrapper abstraction that now obscures more than it helps. |
| Code quality improvement | 5/10 | Linting and type-checking are solid, but there are three concrete runtime correctness issues in critical worker paths and several large orchestration hotspots with test gaps around failure modes. |
| Sustainability / maintainability | 5/10 | The repo has strong docs and CI intent, but enforcement is incomplete where it matters most: import cycles, hotspot enrollment, environment contract drift, and subsystem boundary control. |

### Technical Debt Profile

Approximately **8% of runtime LOC** sits inside files directly implicated by significant findings. The operational blast radius is larger than that number suggests because those files are concentrated in shared worker gateways, cron orchestrators, and admin surfaces. In practice, the affected behavior is closer to the repo’s core ingestion, auth, scoring, and publish paths than the raw line percentage implies.

---

## 2. Findings by Pillar

### Redundancy Elimination

#### R-01. Hotspot backlog state is duplicated across JSON and markdown, and several entries are stale

- Priority: High
- Locations:
  - `scripts/lib/hotspot-ratchet-baseline.json:2-9`
  - `shared/lib/report-cards.ts:1-45`
  - `agents/plans/historical/2026-03-29-hotspot-decomposition-backlog.md:64-67`
  - `scripts/lib/hotspot-ratchet-baseline.json:26-32`
  - `worker/src/handlers/http.ts:1-10`
  - `agents/plans/historical/2026-03-29-hotspot-decomposition-backlog.md:98-108`
  - `scripts/lib/hotspot-ratchet-baseline.json:146-152`
  - `worker/src/cron/daily-digest/collectors.ts:1-24`
  - `agents/plans/historical/2026-03-29-hotspot-decomposition-backlog.md:56-59`
  - `scripts/lib/hotspot-ratchet-baseline.json:234-240`
  - `worker/src/cron/yield-sync/sources.ts:1-33`
  - `agents/plans/historical/2026-03-29-hotspot-decomposition-backlog.md:60-63`
- Description:
  - The ratchet baseline and the historical backlog both still describe these files as active decomposition targets, but the underlying files are now mostly barrel facades or thin delegates.
  - This is duplicated source-of-truth debt: two tracking artifacts, both stale in the same direction.
- Consolidation strategy:
  - Collapse backlog state to one canonical machine-readable inventory.
  - Generate any human-readable decomposition report from that source instead of maintaining both JSON and markdown manually.
  - Remove entries once a file is reduced to a facade/barrel.

#### R-02. The hotspot ratchet only detects file growth, so stale backlog entries survive indefinitely

- Priority: Medium
- Locations:
  - `scripts/lib/hotspot-ratchet.mjs:84-107`
  - `scripts/lib/hotspot-ratchet-baseline.json:2-9`
  - `scripts/lib/hotspot-ratchet-baseline.json:26-32`
  - `scripts/lib/hotspot-ratchet-baseline.json:146-152`
  - `scripts/lib/hotspot-ratchet-baseline.json:234-240`
  - `docs/testing.md:202`
- Description:
  - The ratchet compares current metrics only against an allowlisted baseline and fails on growth. It does not detect the opposite case: files that were decomposed and should be removed from the backlog.
  - The docs then point at that stale backlog as if it were current process state.
- Consolidation strategy:
  - Add a pruning pass that flags entries whose target file dropped below the hotspot threshold or became a facade-only module.
  - Update docs to reference the canonical current inventory, not a historical plan path.

#### R-03. Cron/status metadata coercion is duplicated across frontend and worker code

- Priority: Medium
- Locations:
  - `src/components/status/cron-metadata-summary.ts:1-25`
  - `src/components/status/cron-metadata-summary.ts:80-352`
  - `src/components/status/telegram-bot-stats.tsx:40-85`
  - `worker/src/lib/status/telegram-bot-stats.ts:120-136`
  - `shared/types/status.ts:30-37`
  - `shared/types/status.ts:39-48`
- Description:
  - Multiple consumers re-interpret loose `Record<string, unknown>` metadata into typed values with similar coercion logic.
  - The duplication exists because the shared contract never graduates beyond a loose map.
- Consolidation strategy:
  - Introduce a typed shared parser/normalizer in `shared/` and replace local coercion in both worker and frontend consumers.
  - Narrow `shared/types/status.ts` so downstream code does less shape recovery.

#### R-04. `admin-access.ts` is a single-mode abstraction with no meaningful variation

- Priority: Medium
- Locations:
  - `src/lib/admin-access.ts:3-5`
  - `src/lib/admin-access.ts:13-21`
  - `src/lib/admin-access.ts:23-31`
  - `src/lib/admin-access.ts:33-34`
  - `src/app/admin/client.tsx:41-47`
  - `src/hooks/use-admin-polling-query.ts:13-32`
- Description:
  - The module exists to abstract an access mode, but only one mode (`"ops-proxy"`) actually exists.
  - The abstraction adds indirection and tests around a branch that cannot currently vary.
- Consolidation strategy:
  - Inline the current mode or replace the wrapper with a single exported constant.
  - Reintroduce a strategy layer only when a second real access mode exists.

### Code Quality Improvement

#### CQ-01. Invalid API keys on public protected routes bypass the public IP limiter

- Severity: Critical
- Location:
  - `worker/src/handlers/http/gates.ts:94-149`
  - `worker/src/lib/api-keys.ts:336-389`
  - Related docs and tests:
    - `docs/worker-and-api-limits.md:43-44`
    - `docs/api-reference.md:7`
    - `docs/api-reference.md:154`
    - `docs/api-reference.md:2146`
    - `worker/src/api/__tests__/api-keys.test.ts:338-347`
    - `worker/src/__tests__/index.fetch.test.ts:472-485`
- Description:
  - `requireApiAccess()` authenticates `X-API-Key` and returns `401` before `checkPublicApiRateLimit()` runs.
  - Valid keys are routed into per-key limits; invalid keys should fall back to public IP limiting but currently do not.
- Why it matters:
  - Bad-key traffic can force D1 lookups and hash checks without consuming the intended public limiter budget.
  - This weakens the documented traffic control model on public-but-protected endpoints.
- Remediation:
  - Reorder the gate so failed key auth on public routes is treated as anonymous/public traffic and evaluated through `public_api_rate_limit`.
  - Add an end-to-end regression test for invalid-key requests on a public protected endpoint.

#### CQ-02. DEWS drops valid 30-day mint/burn baseline when no 24h rows exist

- Severity: High
- Location:
  - `worker/src/cron/compute-dews.ts:448-500`
  - `worker/src/cron/compute-dews.ts:597-666`
  - `worker/src/lib/dews.ts:479-487`
- Description:
  - `mintBurnMap` is built only from `mb24hMap`, so a stablecoin with valid 30-day mint/burn baseline but no last-24h rows gets `null` for both values.
  - `computeFlowSignal()` then marks the flow signal unavailable.
- Why it matters:
  - This silently under-reports a valid risk input in a published scoring pipeline.
- Remediation:
  - Build flow input from the union of 24h and baseline rows, not from the 24h map alone.
  - Preserve 30-day context even when short-window activity is zero or missing.

#### CQ-03. DEX-liquidity uses a fake high previous-coverage count to represent read failure

- Severity: High
- Location:
  - `worker/src/cron/dex-liquidity/orchestrator-metadata.ts:263-270`
  - `worker/src/cron/dex-liquidity/orchestrator-metadata.ts:342-344`
  - `worker/src/cron/dex-liquidity/orchestrator.ts:291-294`
- Description:
  - When the previous-coverage read fails, the code substitutes `{ cnt: 9999 }`.
  - Later guard logic interprets that as a real prior count and can trigger a hard coverage regression failure.
- Why it matters:
  - A telemetry read error is promoted into a false data-quality breach and can fail the cron.
- Remediation:
  - Replace the sentinel with an explicit `unavailable` state.
  - Teach the guard to degrade safely when historical comparison data cannot be read.

#### CQ-04. There is no regression test proving invalid-key traffic uses `public_api_rate_limit`

- Severity: Medium
- Location:
  - Production path: `worker/src/handlers/http/gates.ts:94-149`
  - Existing tests:
    - `worker/src/api/__tests__/api-keys.test.ts:338-347`
    - `worker/src/__tests__/index.fetch.test.ts:472-485`
- Description:
  - Current tests cover `401` behavior and valid-key rate limiting, but not the critical bad-key-on-public-route case.
- Why it matters:
  - CQ-01 can recur without an explicit regression test.
- Remediation:
  - Add a fetch test that supplies an invalid key to a public protected endpoint and asserts the public limiter path is exercised.

#### CQ-05. There is no regression test for the DEWS zero-24h / non-zero-baseline case

- Severity: Medium
- Location:
  - Production path:
    - `worker/src/cron/compute-dews.ts:448-500`
    - `worker/src/lib/dews.ts:479-487`
  - Existing tests:
    - `worker/src/lib/__tests__/dews.test.ts:289-317`
    - `worker/src/cron/__tests__/compute-dews.test.ts:247-527`
- Description:
  - The tests exercise normal flow inputs but not the specific edge case that drops the historical baseline.
- Why it matters:
  - The scoring bug in CQ-02 is easy to miss without a purpose-built case.
- Remediation:
  - Add fixture coverage for a stablecoin with no 24h rows and valid baseline rows, then assert the flow signal remains available.

#### CQ-06. `sync-yield-data.ts` is a single-responsibility violation hotspot

- Severity: Medium
- Location:
  - `worker/src/cron/sync-yield-data.ts:226-702`
- Description:
  - The file mixes orchestration, cache parsing, supply lookup, health cooldown state, safety snapshot publication, and history preparation.
- Why it matters:
  - The function surface is large enough that unrelated yield changes collide in the same file and tests become broad integration checks instead of focused unit coverage.
- Remediation:
  - Split publication, cache loading, and resolver orchestration into separate modules.
  - Keep the top-level cron file as a short coordinator.

#### CQ-07. `compute-dews.ts` is a deep orchestration hotspot with fragile edge-case handling

- Severity: Medium
- Location:
  - `worker/src/cron/compute-dews.ts:156-788`
- Description:
  - The file spans data loading, map construction, metric assembly, scoring, and persistence in one flow.
  - CQ-02 is a concrete symptom of that concentration.
- Why it matters:
  - Small scoring-rule changes require touching a large function with multiple implicit invariants.
- Remediation:
  - Split data assembly, signal derivation, and persistence into isolated stages with typed intermediate contracts.

#### CQ-08. `contagion-graph.tsx` mixes graph derivation, interaction state, traversal, and rendering

- Severity: Medium
- Location:
  - `src/components/contagion-graph.tsx:53-783`
- Description:
  - The component owns data shaping, BFS traversal, hover/click interactions, tooltip content, and render output.
- Why it matters:
  - UI behavior changes and data logic changes are tightly coupled, which makes isolated testing and future visualization work harder.
- Remediation:
  - Extract graph-model derivation and traversal utilities from the render component.
  - Keep the React component focused on presentation and interaction wiring.

#### CQ-09. A single malformed `detail_json` row can break the admin audit-log endpoint

- Severity: Medium
- Location:
  - `worker/src/api/api-key-audit-log.ts:53-60`
  - Existing tests: `worker/src/api/__tests__/api-key-audit-log.test.ts:13-52`
- Description:
  - The endpoint uses bare `JSON.parse(row.detail_json)` while mapping rows.
  - One bad row can abort the entire response instead of being skipped or normalized.
- Why it matters:
  - Admin visibility degrades because one corrupted audit record takes down the full page.
- Remediation:
  - Parse per row in a try/catch, emit a safe fallback payload for invalid JSON, and add a regression test for malformed stored data.

### Sustainability and Maintainability

#### S-01. Import-cycle enforcement only covers `shared/`, while worker cycles already exist

- Impact on maintainability: High
- Location / scope:
  - Guardrail: `scripts/check-shared-cycles.mjs:5`
  - Documented check surface: `docs/testing.md:16`
  - Confirmed cycles:
    - `worker/src/lib/live-reserves-store-shared.ts:10`
    - `worker/src/lib/live-reserves-store-parsing.ts:23-28`
    - `worker/src/cron/sync-stablecoins/stages.ts:9-10,26-30`
    - `worker/src/cron/sync-stablecoins/fallback.ts:2-5,27-32`
    - `worker/src/cron/sync-stablecoins/intake.ts:8-14`
    - `worker/src/cron/sync-stablecoins/runtime.ts:1-2`
- Description:
  - The enforced cycle check covers only `shared/`, even though the heaviest orchestration and most fragile boundaries live in `worker/src/`.
- Long-term consequence:
  - The repo can continue to accumulate worker coupling while the guardrail still reports green.
- Recommended remediation:
  - Extend the import-cycle check to `worker/src/` and `src/`, then clean the existing worker cycles before making the broader check blocking.

#### S-02. The `sync-stablecoins` split still behaves like a partially split monolith

- Impact on maintainability: High
- Location / scope:
  - `worker/src/cron/sync-stablecoins.ts:66-208`
  - `worker/src/cron/sync-stablecoins/stages.ts:431-574`
  - `worker/src/cron/sync-stablecoins/fallback.ts:124-356`
  - Back-edge imports:
    - `worker/src/cron/sync-stablecoins/stages.ts:9-10,26-30`
    - `worker/src/cron/sync-stablecoins/fallback.ts:2-5,27-32`
    - `worker/src/cron/sync-stablecoins/intake.ts:8-14`
    - `worker/src/cron/sync-stablecoins/runtime.ts:1-2`
- Description:
  - File boundaries were added, but responsibilities still leak across them through runtime imports and shared mutable orchestration context.
- Long-term consequence:
  - Future changes will keep paying monolith-level coordination cost while creating the illusion of modularity.
- Recommended remediation:
  - Redesign the subsystem around explicit phase contracts and one-directional dependencies: intake -> shared phase helpers -> publish orchestrator.

#### S-03. Hotspot governance misses several current top-risk files

- Impact on maintainability: High
- Location / scope:
  - Guardrail definition: `scripts/lib/hotspot-ratchet.mjs:5-39`
  - Omitted high-risk files:
    - `worker/src/lib/api-keys.ts:15-839`
    - `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts:102-807`
    - `worker/src/cron/yield-sync/resolve.ts:154-789`
    - `worker/src/cron/sync-yield-data.ts:226-380`
    - `src/components/stablecoin-table.tsx:181-700`
    - `src/app/stability-index/client.tsx:570-756`
    - `src/app/admin/client.tsx:120-537`
- Description:
  - The ratchet protects a fixed list instead of the repo’s current hotspot reality.
  - Several of today’s largest and most change-heavy runtime files are not enrolled at all.
- Long-term consequence:
  - New monoliths can continue to grow without CI friction, and the backlog data from R-01/R-02 becomes less trustworthy over time.
- Recommended remediation:
  - Generate hotspot candidates automatically from file metrics and require explicit disposition: enroll, exempt with rationale, or decompose.

#### S-04. `api-keys.ts` is a maintainability bottleneck for a security-sensitive subsystem

- Impact on maintainability: Medium
- Location / scope:
  - `worker/src/lib/api-keys.ts:15-839`
- Description:
  - One module owns token parsing, crypto, pepper rotation, auth, rate limiting, usage bookkeeping, audit logging, and admin CRUD.
- Long-term consequence:
  - Security changes, operational changes, and admin UX changes all converge in one file, increasing review burden and change risk.
- Recommended remediation:
  - Split the module by responsibility and leave only a minimal facade or index module at the current import path.

#### S-05. Yield publication remains concentrated in two orchestration-heavy modules

- Impact on maintainability: Medium
- Location / scope:
  - `worker/src/cron/yield-sync/resolve.ts:154-789`
  - `worker/src/cron/sync-yield-data.ts:226-380`
- Description:
  - Resolver logic, optional provider handling, historical lookup, and publication concerns remain tightly packed.
- Long-term consequence:
  - Adding a new yield source or changing provider ordering will continue to require deep edits across the same modules.
- Recommended remediation:
  - Separate provider resolution families from publication and state management, then give each family dedicated tests.

#### S-06. Price enrichment is concentrated in a single provider-heavy integration module

- Impact on maintainability: Medium
- Location / scope:
  - `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts:102-807`
- Description:
  - Provider-specific logic, chain normalization, identity matching, and fallback policy all live in one file.
- Long-term consequence:
  - New source additions and policy changes raise the blast radius of one already-large module.
- Recommended remediation:
  - Split provider passes into separate modules and centralize only shared identity/budget helpers.

#### S-07. `.env.example` has drifted from the actual worker environment contract

- Impact on maintainability: Medium
- Location / scope:
  - Runtime contract: `worker/src/lib/env.ts:7-45`, `worker/src/lib/env.ts:56-93`
  - Example file: `.env.example:21-77`
- Description:
  - The example file omits active env vars used by the worker contract, including:
    - `SITE_API_SHARED_SECRET_PREVIOUS`
    - `API_KEY_HASH_PEPPER`
    - `API_KEY_HASH_PEPPER_PREVIOUS`
    - `PUBLIC_API_AUTH_MODE`
    - `TELEGRAM_WEBHOOK_SECRET_PREVIOUS`
    - `CLOUDFLARE_D1_STATUS_API_TOKEN`
    - `CLOUDFLARE_D1_DATABASE_ID`
- Long-term consequence:
  - Onboarding, secret rotation, and incident recovery become more error-prone because the example file is no longer a reliable setup reference.
- Recommended remediation:
  - Generate `.env.example` from the typed contract or add a CI check that compares the example against `env.ts`.

#### S-08. Verified documentation has live path drift and config-name drift

- Impact on maintainability: Medium
- Location / scope:
  - Broken hotspot backlog path:
    - `docs/testing.md:202`
    - actual file: `agents/plans/historical/2026-03-29-hotspot-decomposition-backlog.md`
  - Wrong frontend env var name:
    - `README.md:113-114`
    - actual runtime usage: `.env.example:10-16`, `src/lib/api.ts:12`, `src/lib/api.ts:30`
- Description:
  - The testing guide points to a non-existent path.
  - The README documents `NEXT_PUBLIC_API_BASE_URL`, while the app reads `NEXT_PUBLIC_API_BASE`.
- Long-term consequence:
  - The verified documentation corpus loses authority and creates avoidable setup errors.
- Recommended remediation:
  - Fix the current drift immediately, then add automated checks for internal repo links and env-name consistency across docs and runtime.

#### S-09. Worker build output is not fully ignored

- Impact on maintainability: Low
- Location / scope:
  - `.gitignore:19-21`
  - `.gitignore:95-103`
  - Current worktree artifact: `worker/.next/`
- Description:
  - Root `.next/` is ignored, but `worker/.next/` is not.
- Long-term consequence:
  - Local worker builds dirty the worktree and increase accidental artifact commit risk.
- Recommended remediation:
  - Add `worker/.next/` to `.gitignore` alongside other worker-generated artifacts.

---

## 3. Cross-Cutting Concerns

### C-01. Hotspot governance drift is now both a redundancy problem and a sustainability problem

- Connected findings: `R-01`, `R-02`, `S-03`, `S-08`
- Compound issue:
  - The repo is maintaining multiple hotspot tracking artifacts, some are stale, the docs point at stale paths, and the active ratchet misses current large files.
- Why this matters:
  - Governance is producing process noise without fully governing the real risk surface.
- Priority:
  - High. It is a small-to-medium effort fix with strong leverage over future code health.

### C-02. The public API auth surface has a correctness gap, a test gap, and a maintainability bottleneck

- Connected findings: `CQ-01`, `CQ-04`, `S-04`, `S-07`
- Compound issue:
  - Public-route auth behavior is wrong in one edge case, there is no regression test for it, the responsible subsystem is concentrated in a large security-sensitive module, and the auth-related env contract is not fully reflected in setup docs.
- Why this matters:
  - This combines runtime risk with slower remediation velocity.
- Priority:
  - Highest.

### C-03. The DEWS scoring path shows both a live correctness bug and a structural hotspot

- Connected findings: `CQ-02`, `CQ-05`, `CQ-07`
- Compound issue:
  - A published scoring bug exists in a file that is already too large, and there is no focused regression test for the failing edge case.
- Why this matters:
  - The current implementation makes subtle scoring bugs easier to introduce and harder to pin down.
- Priority:
  - High.

### C-04. Worker cron orchestration is concentrated in a handful of large modules with weak architectural guardrails

- Connected findings: `S-01`, `S-02`, `S-05`, `S-06`, `CQ-06`
- Compound issue:
  - `sync-stablecoins`, yield publication, and price enrichment all remain large, tightly coupled orchestration surfaces, while cycle checks and hotspot enrollment do not fully constrain their growth.
- Why this matters:
  - This is the main source of long-term drag on the repo’s fastest-moving business logic.
- Priority:
  - High.

### C-05. Loose contracts are forcing local recovery logic and fragile adapters

- Connected findings: `R-03`, `R-04`, `CQ-09`
- Compound issue:
  - Loose metadata contracts and thin wrapper abstractions are pushing interpretation and failure handling into leaf consumers instead of shared contract code.
- Why this matters:
  - The result is duplicated coercion, harder local testing, and brittle endpoint behavior.
- Priority:
  - Medium.

---

## 4. Prioritized Remediation Roadmap

### Phase 1 — Quick Wins

| Finding refs | Remediation action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `CQ-01`, `CQ-04` | Reorder public-route auth gating so bad API keys fall back to public IP limiting, then add the missing regression test. | `worker/src/handlers/http/gates.ts`, `worker/src/lib/api-keys.ts`, `worker/src/__tests__/index.fetch.test.ts`, `worker/src/api/__tests__/api-keys.test.ts` | Small | None |
| `CQ-02`, `CQ-05` | Preserve DEWS baseline rows when 24h rows are absent and add the targeted edge-case tests. | `worker/src/cron/compute-dews.ts`, `worker/src/lib/dews.ts`, `worker/src/lib/__tests__/dews.test.ts`, `worker/src/cron/__tests__/compute-dews.test.ts` | Small | None |
| `CQ-03` | Replace the fake previous-coverage sentinel with an explicit unavailable state and safe degraded behavior. | `worker/src/cron/dex-liquidity/orchestrator-metadata.ts`, `worker/src/cron/dex-liquidity/orchestrator.ts` | Small | None |
| `CQ-09` | Harden audit-log JSON parsing per row and add malformed-data coverage. | `worker/src/api/api-key-audit-log.ts`, `worker/src/api/__tests__/api-key-audit-log.test.ts` | Small | None |
| `R-04` | Remove or inline the single-mode admin access wrapper. | `src/lib/admin-access.ts`, `src/app/admin/client.tsx`, `src/hooks/use-admin-polling-query.ts` | Small | None |
| `S-07`, `S-08`, `S-09` | Sync `.env.example`, fix the broken docs path and wrong env var name, and ignore `worker/.next/`. | `.env.example`, `README.md`, `docs/testing.md`, `.gitignore` | Small | None |
| `R-01` | Remove stale hotspot backlog entries for files that are already reduced to facades/barrels. | `scripts/lib/hotspot-ratchet-baseline.json`, `agents/plans/historical/2026-03-29-hotspot-decomposition-backlog.md` | Small | None |

### Phase 2 — Targeted Refactoring

| Finding refs | Remediation action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `R-03`, `C-05` | Introduce a typed shared status metadata parser and replace duplicated coercion logic in worker and frontend consumers. | `shared/types/status.ts`, `shared/lib/...new parser...`, `src/components/status/cron-metadata-summary.ts`, `src/components/status/telegram-bot-stats.tsx`, `worker/src/lib/status/telegram-bot-stats.ts` | Medium | None |
| `S-01` | Expand import-cycle checks to `worker/src/` and `src/`, initially non-blocking until existing worker cycles are removed. | `scripts/check-shared-cycles.mjs`, `docs/testing.md`, CI workflow/config that runs the script | Medium | None |
| `S-04`, `C-02` | Split `api-keys.ts` into auth, rate-limit, audit, and admin-store modules behind a stable facade. | `worker/src/lib/api-keys.ts`, new `worker/src/lib/api-key-*.ts` modules | Medium | `CQ-01` quick fix first |
| `CQ-08` | Extract graph-model and traversal logic from `contagion-graph.tsx` into testable non-React helpers. | `src/components/contagion-graph.tsx`, new helper module(s) | Medium | None |
| `CQ-06` | Break `sync-yield-data.ts` into coordinator, publication, and state-loading modules. | `worker/src/cron/sync-yield-data.ts`, adjacent helper modules | Medium | None |
| `R-02`, `S-08` | Add stale-entry pruning and doc-link verification so hotspot/process docs self-correct instead of drifting. | `scripts/lib/hotspot-ratchet.mjs`, `docs/testing.md`, docs tooling/checks | Medium | `R-01` cleanup first |

### Phase 3 — Structural Improvements

| Finding refs | Remediation action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `S-02`, `S-01` | Redesign `sync-stablecoins` around one-directional phase contracts and remove runtime back-edges between `stages`, `fallback`, `intake`, and `runtime`. | `worker/src/cron/sync-stablecoins.ts`, `worker/src/cron/sync-stablecoins/stages.ts`, `worker/src/cron/sync-stablecoins/fallback.ts`, `worker/src/cron/sync-stablecoins/intake.ts`, `worker/src/cron/sync-stablecoins/runtime.ts` | Large | Cycle-check expansion in Phase 2 |
| `S-05`, `CQ-06` | Separate yield provider-resolution families from publication/state management and give each family focused tests. | `worker/src/cron/yield-sync/resolve.ts`, `worker/src/cron/sync-yield-data.ts`, `worker/src/cron/yield-sync/*` | Large | `CQ-06` coordinator split first |
| `S-06` | Split price enrichment provider passes into dedicated modules with shared identity/budget helpers. | `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts`, new `enrich-prices/*` modules | Large | `S-02` phase-contract refactor strongly recommended first |
| `CQ-07`, `C-03` | Rebuild DEWS as staged assembly -> signal derivation -> persistence with typed intermediate structures. | `worker/src/cron/compute-dews.ts`, `worker/src/lib/dews.ts` | Large | `CQ-02` fix and tests first |
| `S-03`, `C-01` | Replace fixed hotspot allowlists with generated candidate enrollment plus explicit waivers. | `scripts/lib/hotspot-ratchet.mjs`, `scripts/lib/hotspot-ratchet-baseline.json`, docs/process around hotspot management | Medium | `R-01` and `R-02` cleanup first |

### Phase 4 — Strategic Overhauls

| Finding refs | Remediation action | Affected files/modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `C-04` | Standardize worker cron subsystem architecture around explicit stage interfaces, typed handoff objects, and shared orchestration conventions across stablecoin sync, DEWS, and yield sync. | `worker/src/cron/sync-stablecoins*`, `worker/src/cron/compute-dews.ts`, `worker/src/cron/sync-yield-data.ts`, `worker/src/cron/yield-sync/*` | Large | Phase 3 decompositions |
| `C-01`, `S-07`, `S-08` | Introduce contract-driven governance checks for env docs, internal markdown links, and hotspot inventory freshness. | docs/process scripts, `scripts/lib/hotspot-ratchet.mjs`, `.env.example`, `README.md`, `docs/testing.md` | Medium | Phase 1 doc/env fixes |
| `S-03`, `CQ-08` | Establish a frontend hotspot decomposition program for large interactive analytics components. Start with `contagion-graph.tsx`, `stablecoin-table.tsx`, `src/app/stability-index/client.tsx`, and `src/app/admin/client.tsx`. | Frontend analytics surfaces under `src/components/` and `src/app/` | Large | Hotspot enrollment automation in Phase 3 |

---

## 5. Appendices

### Appendix A. Complete File-by-File Finding Index

| File / module | Findings |
| --- | --- |
| `.env.example` | `S-07`, `S-08` |
| `.gitignore` | `S-09` |
| `README.md` | `S-08` |
| `agents/plans/historical/2026-03-29-hotspot-decomposition-backlog.md` | `R-01` |
| `docs/api-reference.md` | `CQ-01` |
| `docs/testing.md` | `R-02`, `S-01`, `S-08` |
| `docs/worker-and-api-limits.md` | `CQ-01` |
| `scripts/check-shared-cycles.mjs` | `S-01` |
| `scripts/lib/hotspot-ratchet-baseline.json` | `R-01`, `R-02`, `S-03` |
| `scripts/lib/hotspot-ratchet.mjs` | `R-02`, `S-03` |
| `shared/lib/report-cards.ts` | `R-01` |
| `shared/types/status.ts` | `R-03` |
| `src/app/admin/client.tsx` | `R-04`, `S-03` |
| `src/app/stability-index/client.tsx` | `S-03` |
| `src/components/contagion-graph.tsx` | `CQ-08` |
| `src/components/stablecoin-table.tsx` | `S-03` |
| `src/components/status/cron-metadata-summary.ts` | `R-03` |
| `src/components/status/telegram-bot-stats.tsx` | `R-03` |
| `src/hooks/use-admin-polling-query.ts` | `R-04` |
| `src/lib/admin-access.ts` | `R-04` |
| `src/lib/api.ts` | `S-08` |
| `worker/src/__tests__/index.fetch.test.ts` | `CQ-01`, `CQ-04` |
| `worker/src/api/__tests__/api-key-audit-log.test.ts` | `CQ-09` |
| `worker/src/api/__tests__/api-keys.test.ts` | `CQ-01`, `CQ-04` |
| `worker/src/api/api-key-audit-log.ts` | `CQ-09` |
| `worker/src/cron/__tests__/compute-dews.test.ts` | `CQ-05` |
| `worker/src/cron/compute-dews.ts` | `CQ-02`, `CQ-05`, `CQ-07` |
| `worker/src/cron/daily-digest/collectors.ts` | `R-01` |
| `worker/src/cron/dex-liquidity/orchestrator-metadata.ts` | `CQ-03` |
| `worker/src/cron/dex-liquidity/orchestrator.ts` | `CQ-03` |
| `worker/src/cron/sync-stablecoins.ts` | `S-02` |
| `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts` | `S-03`, `S-06` |
| `worker/src/cron/sync-stablecoins/fallback.ts` | `S-01`, `S-02` |
| `worker/src/cron/sync-stablecoins/intake.ts` | `S-01`, `S-02` |
| `worker/src/cron/sync-stablecoins/runtime.ts` | `S-01`, `S-02` |
| `worker/src/cron/sync-stablecoins/stages.ts` | `S-01`, `S-02` |
| `worker/src/cron/sync-yield-data.ts` | `CQ-06`, `S-03`, `S-05` |
| `worker/src/cron/yield-sync/resolve.ts` | `S-03`, `S-05` |
| `worker/src/cron/yield-sync/sources.ts` | `R-01` |
| `worker/src/handlers/http.ts` | `R-01` |
| `worker/src/handlers/http/gates.ts` | `CQ-01`, `CQ-04` |
| `worker/src/lib/__tests__/dews.test.ts` | `CQ-05` |
| `worker/src/lib/api-keys.ts` | `CQ-01`, `S-03`, `S-04` |
| `worker/src/lib/dews.ts` | `CQ-02`, `CQ-05` |
| `worker/src/lib/env.ts` | `S-07` |
| `worker/src/lib/live-reserves-store-parsing.ts` | `S-01` |
| `worker/src/lib/live-reserves-store-shared.ts` | `S-01` |
| `worker/src/lib/status/telegram-bot-stats.ts` | `R-03` |

### Appendix B. Dependency Audit Summary

| Area | Result | Notes |
| --- | --- | --- |
| Production vulnerabilities | Clean | `npm audit --audit-level=high --omit=dev --json` reported no vulnerabilities. |
| Full install vulnerabilities | Clean | No high/critical advisories surfaced in the local audit run. |
| Lockfile integrity | Acceptable | Root `package-lock.json` is present and covers the npm workspace. There is no separate `worker/package-lock.json`, which is expected for this setup. |
| Update pressure | Moderate | Patch/minor upgrades are available for `next` (`16.2.1 -> 16.2.2`), `eslint-config-next` (`16.2.1 -> 16.2.2`), `@tanstack/react-query` (`5.95.2 -> 5.96.2`), `viem` (`2.47.6 -> 2.47.10`), `wrangler` (`4.78.0 -> 4.80.0`), and `@cloudflare/workers-types` (`4.20260329.1 -> 4.20260405.1`). |
| Major-version watchlist | Present | `eslint` `10.x` and `typescript` `6.x` are available, but these should be treated as planned compatibility upgrades rather than urgent audit findings. |
| Local install drift | Observed but not elevated | `npm ls --depth=0` showed local invalid/extraneous packages in the current machine state. Because the committed manifests and lockfile did not reflect that drift, it was treated as environment noise, not a repo finding. |

No dependency issue was severe enough to become a top-level maintainability finding. The repo’s dependency posture is materially better than its architecture-governance posture.

### Appendix C. Glossary

| Term | Meaning |
| --- | --- |
| Circular dependency | Two or more modules import each other directly or indirectly, creating initialization-order coupling. |
| Contract drift | Documentation or example files no longer match the runtime contract implemented in code. |
| God module | A file that owns too many unrelated responsibilities and therefore changes for multiple reasons. |
| Hotspot ratchet | A guardrail that freezes complexity metrics for selected files and fails if they grow. |
| Sentinel value | A placeholder value used to represent a special state. It becomes dangerous when later logic mistakes it for real data. |
| SRP violation | A Single Responsibility Principle violation: one module does too many unrelated jobs. |
| Structural clone | Logic duplicated with superficial differences such as names or formatting rather than identical text. |
| Thin wrapper | An abstraction layer that adds indirection without adding real behavioral variation or policy value. |
| Typed handoff object | An explicit intermediate data contract passed between stages so invariants are visible and testable. |
| Waiver-based governance | A process where large or risky files must either meet a rule or carry an explicit, reviewed exception. |
