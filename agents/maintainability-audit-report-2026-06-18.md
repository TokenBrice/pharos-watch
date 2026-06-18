# Pharos Maintainability Audit Report

Date: 2026-06-18

Scope: production-critical maintainability audit focused on redundancy elimination, code quality, sustainability, and data accuracy/availability risks. This report reflects the current working tree at the time of verification, including unrelated in-progress changes.

## Current Verification Snapshot

- `npx vitest run scripts/__tests__/client-registry-field-contract.test.ts src/app/compliance/model.test.ts`: passed, 13 tests.
- `npm run check:client-registry-imports`: passed.
- `node scripts/build-data/build-client-registry.mjs --check`: failed because `shared/data/stablecoins/coins.client.generated.json` is stale.
- In-memory generated-registry comparison: 406 current entries, 406 expected entries, 212 changed entries; sampled diffs are `mintAuthoritySummary.controls[].canRaiseCap`, not GENIUS fields.
- `npx vitest run shared/lib/__tests__/mint-authority-scoring.test.ts`: passed, 13 tests.
- `npm run check:provider-resilience`: passed.
- `npm run check:unused-code`: passed.

## GENIUS Situation Verification

The earlier GENIUS client projection failure has evolved and is no longer reproduced.

Location:
- `scripts/build-data/build-client-registry.mjs` lines 43-67, 169-239.
- `shared/types/stablecoin-client-meta.ts` lines 76-101.
- `scripts/__tests__/client-registry-field-contract.test.ts` lines 165-260.
- `src/app/compliance/model.ts` lines 194-254.

Current State:
- `GENIUS_CLIENT_FIELDS` now includes the broader public GENIUS fields used by the compliance model: applicability basis, federal/state regulator fields, foreign exception evidence, enforcement/DASP status, attestation/report fields, negative evidence review, reviewer, and reviewed date.
- `GeniusClientProfile` now matches those fields.
- The focused client-registry contract test now expects the broader projection and passes.
- The generated client registry already contains broad GENIUS projection data.

Recommendation:
- Remove the original GENIUS projection-contract finding from the active blocker list.
- Keep one maintainability follow-up: make `GENIUS_CLIENT_FIELDS` derive from a single exported allowlist or add a targeted assertion that the generator field list and `GeniusClientProfile` stay aligned.
- Do not regenerate the client registry as a GENIUS fix. The stale generated registry is currently caused by mint-authority projection changes.

Risk Assessment:
- The main remaining GENIUS risk is future drift between the type and generator field list. The passing test lowers immediate regression risk, but the duplicated allowlist is still a modest maintenance hazard.

## Executive Summary

Top recommendations, ordered by severity and implementation value:

1. Fix the current generated client registry staleness caused by mint-authority projection changes before merging related work.
2. Unify CI runtime-admission logic and Worker on-chain supply selection so assets cannot pass validation but be skipped at runtime.
3. Validate Worker response-ready cache rows before serving them, or store a trusted schema/version marker that proves validation happened at write time.
4. Strengthen cache contracts for public chain aggregation; it currently consumes richer fields than the default stablecoins cache schema guarantees.
5. Add runtime schemas to the highest-impact frontend API descriptors instead of passing schema plumbing with `undefined`.

## Critical Findings

No confirmed Critical-severity production defect was proven. The following High-severity findings are the closest because they can affect data accuracy, availability, or release safety.

### 1. Generated Client Registry Is Stale After Mint-Authority Projection Changes

Location:
- `scripts/build-data/build-client-registry.mjs` lines 341-357.
- `shared/data/stablecoins/coins.client.generated.json`.
- `shared/lib/mint-authority-scoring.ts` lines 415-421.
- `shared/lib/__tests__/mint-authority-scoring.test.ts` line 51.

Category: Production Risk

Severity: High

Current State:
- The generator now projects `mintAuthoritySummary.controls[].canRaiseCap`.
- `node scripts/build-data/build-client-registry.mjs --check` fails.
- In-memory comparison shows 212 client-registry entries differ from expected output, all sampled under `mintAuthoritySummary.controls[].canRaiseCap`.
- The related mint-authority focused test now passes, and the client-registry test suite now includes score-equivalence coverage for projected mint-authority summaries.

Recommended Change:
- Finish the mint-authority change as one coherent unit: regenerate `shared/data/stablecoins/coins.client.generated.json`, rerun the mint-authority focused tests, and rerun the client-registry check.
- Keep this separate from GENIUS review work; the current stale generated artifact is not GENIUS-driven.

Risk Assessment:
- Regenerating the file without reviewing the broad `canRaiseCap` diff could ship an unintended client payload change. Mitigate by requiring the focused mint-authority test, the client-registry projection test, and `build-client-registry --check` to pass in the same change.

### 2. Runtime Admission Logic Diverges From Worker Fetching

Location:
- `scripts/ci/check-stablecoin-data.ts` lines 76-112.
- `worker/src/cron/sync-stablecoins/supplemental-assets/onchain-supply.ts` lines 53-75 and 198-225.
- Example asset: `shared/data/stablecoins/coins/mmxn-moneta-digital.json`.

Category: Production Risk

Severity: High

Current State:
- CI admission treats an active CoinGecko-detail asset as runtime-admissible when any supported on-chain contract exists.
- The Worker generic on-chain supply path only selects curated overrides or a single-contract fallback; uncurated multi-contract assets can be skipped at runtime.
- This creates a validation/runtime mismatch where an asset can pass checks but produce no runtime supply path.

Recommended Change:
- Extract one shared runtime-neutral helper, for example `selectRuntimeSupplyPath(asset)`, and use it in both CI and Worker code.
- Encode explicit outcomes: curated override, single supported contract, unsupported multi-contract asset, and unsupported chain/address.

Risk Assessment:
- Tightening CI can expose existing catalog gaps. Mitigate with table tests for known assets before enforcing the helper globally.

### 3. Response-Ready Cache Rows Bypass Schema Validation

Location:
- `worker/src/api/cache-handlers.ts` lines 19-29.
- `worker/src/lib/api-cache-read.ts` lines 155-199.

Category: Production Risk

Severity: High

Current State:
- Stablecoin cache handlers define a Zod schema.
- The response-ready companion cache path can return a cached response body before parsing and schema validation happen.
- Canonical cache reads validate; response-ready reads can bypass that protection.

Recommended Change:
- Validate response-ready companion rows against the same schema before serving, or validate at write time and store a schema/version/hash marker that the read path checks before returning the companion row.

Risk Assessment:
- Read-time validation may add CPU overhead on hot endpoints. Mitigate by validating at write time and using read-time fallback to canonical cache when the marker is absent or stale.

### 4. Public Chain Aggregation Consumes Fields Not Guaranteed By Its Cache Contract

Location:
- `worker/src/lib/stablecoins-cache.ts` lines 7-15, 139-148, 196-260.
- `worker/src/api/chains.ts` lines 143-170.

Category: Production Risk

Severity: High

Current State:
- `handleChains` loads stablecoins through the default `critical-fields` cache contract.
- Chain aggregation depends on richer fields such as chain-level circulation data.
- The default contract validates only a minimal subset and passes through the rest.

Recommended Change:
- Change `handleChains` to request `contract: "published"` or add a narrower chain-aggregation schema that explicitly validates every field consumed by `aggregateChains`.

Risk Assessment:
- Stricter validation may reject legacy cache rows. Mitigate with last-good fallback behavior and an explicit health signal when chain aggregation falls back.

## Redundancy Report

### 5. GENIUS Client Field Contract Exists In Multiple Places

Location:
- `scripts/build-data/build-client-registry.mjs` lines 43-67.
- `shared/types/stablecoin-client-meta.ts` lines 76-101.
- `scripts/__tests__/client-registry-field-contract.test.ts` lines 165-260.

Category: Redundancy

Severity: Medium

Current State:
- The immediate GENIUS mismatch is fixed, but the generator field list and TypeScript client type are still separate declarations.

Recommended Change:
- Move the public GENIUS projection keys to a single shared runtime-neutral constant, or add a test that programmatically asserts generator keys match the `GeniusClientProfile` public contract.

Risk Assessment:
- Moving constants across script/runtime boundaries can create import problems. Mitigate with `npm run check:client-registry-imports`.

### 6. On-Chain Supply Support Semantics Are Duplicated

Location:
- `scripts/ci/check-stablecoin-data.ts` lines 76-112.
- `worker/src/cron/sync-stablecoins/supplemental-assets/onchain-supply.ts` lines 53-75.

Category: Redundancy

Severity: High

Current State:
- CI and Worker code independently define which chain/address shapes are supported.
- Their behavior has drifted.

Recommended Change:
- Create one shared `supportsOnchainSupplyProbe(chain, address)` helper and table-test it for Solana, Ethereum/EVM, Tron, Stellar, and unknown chains.

Risk Assessment:
- A shared helper can change behavior broadly. Mitigate by landing it first in assertion-only mode, then enforcing it in CI and Worker paths.

### 7. Depeg Freshness Settings Are Hardcoded Outside The Shared Health Config

Location:
- `src/app/depeg/client.tsx` lines 247-252.
- `src/lib/data-health-config.ts` lines 8-24.

Category: Redundancy

Severity: Medium

Current State:
- Depeg resolver freshness uses literal `900_000` stale-time values instead of the shared producer/freshness config pattern.

Recommended Change:
- Add depeg resolver presets to the shared data-health config and consume them from the depeg client.

Risk Assessment:
- Incorrect intervals can increase UI staleness or backend load. Mitigate by matching existing API freshness metadata.

## Code Quality Findings

### 8. Frontend API Runtime Schemas Are Mostly Absent

Location:
- `src/lib/api-query-runtime-registry.ts` lines 17-23, 56-62, 152-175.
- `src/hooks/api-hooks.ts` lines 48-69.
- `src/lib/api.ts` lines 200-261.

Category: Code Quality

Severity: High

Current State:
- The frontend API layer supports schema validation, but critical descriptors pass `undefined`.
- `validateApiPayload` returns raw data when no schema is present.

Recommended Change:
- Add schemas incrementally for highest-impact endpoints: stablecoins, peg summary, depeg, chains, and report-card data.

Risk Assessment:
- Schemas may reject tolerated legacy payload shapes. Mitigate endpoint-by-endpoint with fixtures and existing UI tests.

### 9. Generic JSON Parse Context Weakens Worker Observability

Location:
- `worker/src/lib/api-cache-read.ts` lines 41-48.
- Example callers: `worker/src/api/daily-digest.ts` line 25; `worker/src/api/stress-signals.ts` lines 313, 326, 403.

Category: Production Risk

Severity: Medium

Current State:
- Several critical `safeJsonParse` calls omit context, so malformed-row logs can collapse into generic messages.

Recommended Change:
- Require an explicit context argument for `safeJsonParse` in Worker API/cron code and update all callers.

Risk Assessment:
- Low implementation risk. Mitigate with a small static check that forbids default context use outside tests.

### 10. Serial Scheduled Groups Continue After Upstream Failures

Location:
- `worker/src/handlers/scheduled/slot-groups.ts` lines 58-66.
- `worker/src/handlers/scheduled/hourly-live-reserves.ts` lines 65-98.

Category: Sustainability

Severity: Medium

Current State:
- Serial scheduled groups keep running downstream tasks even when an earlier task fails.
- For dependent data jobs, that can compound stale or partial data.

Recommended Change:
- Add an opt-in dependency policy such as `stopOnFailure` for serial groups where downstream correctness depends on upstream freshness.

Risk Assessment:
- Stopping downstream jobs can reduce data availability. Mitigate with last-good data behavior and operator-visible failure metrics.

## Sustainability Roadmap

1. Finish the current mint-authority/generated-registry work so release checks are green.
2. Unify runtime admission and on-chain supply selection between CI and Worker code.
3. Add validation or trusted schema markers to response-ready cache reads.
4. Tighten chain aggregation cache contracts.
5. Add frontend runtime schemas for critical API hooks in small endpoint-by-endpoint changes.
6. Reduce critical coverage and hotspot waivers in batches, prioritizing Worker cron/data correctness modules first.

## Quick Wins

- Regenerate `shared/data/stablecoins/coins.client.generated.json` only after the mint-authority focused test passes.
- Add explicit context labels to `safeJsonParse` callers in API and cron code.
- Add depeg resolver freshness constants to `src/lib/data-health-config.ts`.
- Add table tests for CI vs Worker on-chain supply eligibility.
- Add one assertion keeping GENIUS generator projection fields aligned with the client type contract.
