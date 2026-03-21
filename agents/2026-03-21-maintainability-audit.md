# Pharos Maintainability Audit

Date: 2026-03-21

## Executive Summary

1. `handleYieldRankings()` and mint/burn fallback responses still fail open on malformed cached JSON, which can return `200` with corrupt bodies instead of a controlled `503`.
2. Critical worker cache/state readers use multiple ad hoc JSON parsing patterns with different fallback semantics, making corruption handling inconsistent and harder to reason about.
3. `syncStablecoins()` and `syncYieldData()` remain large orchestration functions that mix fetch, validation, enrichment, persistence, and observability concerns in single edit hotspots.
4. The status pipeline has a layer inversion: `worker/src/lib/status-evaluation.ts` depends on `worker/src/api/*` modules, which makes the operational core harder to isolate and evolve safely.
5. Frontend helper duplication has already diverged in explorer-link and formatting logic, increasing update cost and creating user-visible inconsistencies.

## Critical Findings

### 1. Fail-open cache reads can return corrupt JSON as success

- Location:
  - `worker/src/api/cache-handlers.ts` lines 100-143
  - `worker/src/api/mint-burn-flows-shared.ts` lines 77-94
  - `worker/src/api/__tests__/yield-rankings.test.ts` lines 42-252
- Category: Production Risk
- Severity: Critical
- Current State:
  - `handleYieldRankings()` catches `JSON.parse` failure and returns `new Response(cached.value, { headers })` anyway.
  - `cachedFlowFallbackResponse()` always returns the raw cached body, even if JSON parsing failed while deriving freshness.
  - The cache-passthrough contract elsewhere fails closed with `503`, so this behavior is inconsistent and can surface malformed JSON to operators or clients as a nominal success.
- Recommended Change:
  - Introduce a shared `readCachedJsonOr503()` helper for transformed cache endpoints.
  - Make `handleYieldRankings()` and mint/burn fallback responses return `503` on parse failure, matching `createCacheHandler()`.
  - Add explicit regression tests for malformed cached payloads on both endpoints.
- Risk Assessment:
  - Tightening to fail closed may expose latent bad cache rows that are currently masked.
  - Mitigate by adding logs/alerts first, deploying on admin-oriented endpoints first, and keeping last-known-good cache writes untouched.

## Redundancy Report

### 2. Cache/state JSON parsing is duplicated with inconsistent fallback semantics

- Location:
  - `worker/src/lib/stablecoins-cache.ts` lines 155-188
  - `worker/src/lib/report-card-cache.ts` lines 36-64
  - `worker/src/lib/fx-rate-state.ts` lines 166-194 and 418-459
  - `worker/src/lib/live-reserves-store.ts` lines 61-114
  - `worker/src/lib/redemption-backstops-store.ts` lines 53-80
- Category: Redundancy
- Severity: High
- Current State:
  - Each loader implements its own parse/validate/fallback behavior.
  - Some paths return structured errors, some silently coerce to `{}` or `[]`, and `parseFxMeta()` synthesizes bootstrap metadata when parsing fails.
  - The same concern is solved multiple ways, which raises cognitive load and makes corruption handling unpredictable.
- Recommended Change:
  - Add a shared internal cache/JSON decoding utility with explicit modes: `strict`, `degraded`, `best-effort`.
  - Standardize outcomes to `{ ok, reason, payload, updatedAt }` and require callers to consciously choose fail-closed vs fail-soft behavior.
  - Start with the five loaders above before expanding further.
- Risk Assessment:
  - Converging loaders can change edge-case behavior in multiple endpoints at once.
  - Mitigate by migrating one loader at a time, preserving existing outward behavior with fixture tests before tightening semantics.

### 3. Explorer URL construction is copy-pasted and already diverged

- Location:
  - `src/components/key-info-card.tsx` lines 19-23
  - `src/components/stablecoin-cemetery.tsx` lines 10-17
  - `worker/src/cron/blacklist/shared.ts` lines 19-31
- Category: Redundancy
- Severity: Medium
- Current State:
  - Three separate explorer URL builders exist.
  - `StablecoinCemetery` handles `solana`, `starknet`, and `aptos`; `KeyInfoCard` only special-cases `tron`; worker blacklist helpers also normalize Tron addresses differently.
  - The logic has already diverged, so new chains or URL-format changes require multi-file edits and can produce broken links.
- Recommended Change:
  - Move explorer URL generation into a shared runtime-neutral helper under `shared/lib/`.
  - Keep one input contract for chain metadata + entity type (`tx`, `address`, `contract`) and reuse it from frontend and worker code.
- Risk Assessment:
  - URL generation changes can break external links if chain-specific cases are mis-modeled.
  - Mitigate with table-driven tests covering all currently supported chain formats before swapping call sites.

### 4. Formatting helpers are duplicated and inconsistent

- Location:
  - `shared/lib/format.ts` lines 1-227
  - `src/lib/chain-ui.ts` lines 3-15
  - `src/components/site-header.tsx` lines 9-12
  - `src/lib/peg-stability.ts` lines 74-81
  - `src/components/depeg-tracker-table.tsx` lines 212-223
- Category: Redundancy
- Severity: Medium
- Current State:
  - Currency abbreviations, count formatting, address truncation, and tracking-span formatting are implemented in multiple places.
  - The tracking-span helper in `peg-stability.ts` uses month math (`30.44`) while the depeg table uses `365/30`, so the same concept can render differently depending on screen.
- Recommended Change:
  - Promote a small shared formatter surface for counts, chain USD values, address display, and tracking spans.
  - Replace duplicate local helpers incrementally, starting with the depeg-tracking span pair and explorer-address truncation.
- Risk Assessment:
  - UI copy will shift slightly when formats are unified.
  - Mitigate with snapshot/unit tests for affected displays and accept only deliberately reviewed copy deltas.

## Code Quality Findings

### 5. `syncStablecoins()` is still a single high-risk orchestration hotspot

- Location:
  - `worker/src/cron/sync-stablecoins.ts` lines 328-870
- Category: Code Quality
- Severity: High
- Current State:
  - One function still owns upstream fetch, fallback routing, structural validation, discovery residuals, ID remapping, supplemental merges, price consensus, enrichment, GT probes, authoritative overrides, supply-history fill, staleness checks, cache writes, depeg execution, and metadata synthesis.
  - The repo has already started extracting stages into `sync-stablecoins/*`, but the main function remains the mandatory edit point for most behavior changes.
- Recommended Change:
  - Continue the stage-structured refactor already in progress.
  - Extract three next units with no behavior change:
    - intake/fallback gate
    - canonicalization/discovery merge
    - final metadata assembly + status return
  - Keep the exported function as a thin stage orchestrator.
- Risk Assessment:
  - Refactoring can accidentally reorder side effects in a production-critical cron.
  - Mitigate with characterization tests around fallback, cache-write blocking, and depeg-pipeline invocation order before moving code.

### 6. `syncYieldData()` mixes source arbitration, persistence, and cache publication in one function

- Location:
  - `worker/src/cron/sync-yield-data.ts` lines 289-930
- Category: Code Quality
- Severity: High
- Current State:
  - The function loads sources, computes safety coverage, writes `report_card_cache`, performs source-history compatibility handling, evaluates candidates, writes two tables, assembles alternate-source payloads, validates cache output, and synthesizes cron degradation metadata.
  - This makes the yield pipeline hard to change in isolation and increases the chance of regressions when touching ranking logic.
- Recommended Change:
  - Extract the remaining pure subdomains into focused modules:
    - candidate evaluation/arbitration
    - D1 persistence
    - rankings payload assembly
    - degradation metadata synthesis
  - Preserve the current SQL and payload contracts; this is a decomposition, not a redesign.
- Risk Assessment:
  - The main risk is subtle output drift in rankings ordering or provenance fields.
  - Mitigate with golden tests on the final rankings payload before and after each extraction.

### 7. The status core depends on API-layer modules

- Location:
  - `worker/src/lib/status-evaluation.ts` lines 17-24
  - `worker/src/api/status-data-quality.ts` lines 53-203
  - `worker/src/api/status-derived-data.ts` lines 87-462
- Category: Code Quality
- Severity: Medium
- Current State:
  - `worker/src/lib/status-evaluation.ts` imports `../api/status-derived-data` and `../api/status-data-quality`.
  - This inverts the layer boundary: core status logic depends on API-oriented modules instead of the API using reusable library modules.
- Recommended Change:
  - Move status data loaders into `worker/src/lib/status/` (or equivalent) and make the API handler consume that library layer.
  - Keep the public response shape unchanged.
- Risk Assessment:
  - Mostly organizational risk; the behavior should not change.
  - Mitigate by moving files first, then updating imports, then running the existing `status` test suite unchanged.

### 8. Query polling defaults are hidden in `Providers` and can override “static” query intent

- Location:
  - `src/components/providers.tsx` lines 72-79
  - `src/hooks/use-api-query.ts` lines 82-100
  - `src/hooks/api-hooks.ts` lines 75-82
- Category: Code Quality
- Severity: Medium
- Current State:
  - `QueryClient` sets a global `refetchInterval` of 5 minutes.
  - `createStaticQueryOptions()` does not explicitly disable polling, so “static” queries like `useDigestSnapshot()` inherit the global refetch loop unless they override it.
  - This hides behavior in a global default instead of the hook that owns the polling contract.
- Recommended Change:
  - Remove the global `refetchInterval` from `Providers`, or set `refetchInterval: false` in `createStaticQueryOptions()`.
  - Keep polling decisions local to `usePollingQuery()` and hook-specific code.
- Risk Assessment:
  - Some pages may currently rely on the accidental refetch behavior.
  - Mitigate by checking live consumers of `createStaticQueryOptions()` first; today the blast radius is small.

### 9. `methodology-sections.tsx` is a very large content-and-layout monolith

- Location:
  - `src/app/methodology/methodology-sections.tsx` lines 1-2831
- Category: Code Quality
- Severity: Medium
- Current State:
  - The file contains the bulk of the methodology page’s content, structure, diagrams, and repeated mobile/desktop variants in one place.
  - This makes methodology updates harder to review, raises merge-conflict frequency, and increases the odds of docs drift when touching a single section.
- Recommended Change:
  - Split by section into separate components or content modules, leaving the route-level file as composition only.
  - Start with the highest-churn sections: pricing pipeline, scoring, yield, and mint/burn.
- Risk Assessment:
  - The main risk is content-only regressions.
  - Mitigate with route snapshots and one section-at-a-time extraction instead of a single bulk rewrite.

## Sustainability Roadmap

Ordered by impact-to-effort ratio:

1. Make transformed cache endpoints fail closed on malformed JSON and add regression tests.
2. Introduce a shared strict/lenient JSON-cache reader and migrate `report-card-cache`, `fx-rate-state`, and `live-reserves-store`.
3. Remove global React Query polling defaults so query cadence stays explicit at each hook.
4. Extract remaining orchestration stages from `syncStablecoins()` and `syncYieldData()` without changing payloads.
5. Move status data loaders out of `worker/src/api/` into a library package boundary.
6. Consolidate explorer URL and formatting helpers into shared utilities.
7. Split `methodology-sections.tsx` into per-section modules to reduce doc-edit blast radius.

## Quick Wins

1. Add corrupt-cache tests for `handleYieldRankings()` and `handleMintBurnFlows()`; the current suites only cover happy-path and empty-cache behavior.
2. Set `refetchInterval: false` for `createStaticQueryOptions()` as a one-line guard against unintended polling.
3. Replace the duplicate depeg tracking-span formatter with a shared helper to remove immediate user-visible inconsistency.
4. Consolidate `getExplorerUrl()` between `KeyInfoCard` and `StablecoinCemetery` before the next chain-specific UI addition.
5. Clean up the existing ESLint warning in `worker/src/cron/__tests__/yield-resolve.test.ts:487`.

## Verification

- `npm run lint` — passed with 1 existing warning in a test file
- `npm test` — passed (`279` files, `2583` tests)
- `cd worker && npx tsc --noEmit` — passed
- `npm run build` — passed
