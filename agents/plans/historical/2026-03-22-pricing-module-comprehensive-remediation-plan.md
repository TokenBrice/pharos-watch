# 2026-03-22 Pricing Module Comprehensive Remediation Plan

> Execution plan for the findings in [../audits/2026-03-22-pricing-module-comprehensive-audit.md](../audits/2026-03-22-pricing-module-comprehensive-audit.md).
> Goal: remediate the pricing-integrity weaknesses identified in the audit, harden the module against USR-class failures, and reduce source-policy drift across runtime, status, and UI surfaces.

## Objectives

1. Prevent severe price publication mistakes caused by weak identity, unsafe source admission, or stale replay.
2. Make source trust policy explicit and centralized instead of duplicated across runtime/UI/status code.
3. Reduce maintenance overhead by mutualizing pricing-source metadata and removing known fallback heuristics that guess too much.
4. Ship the remediation with tests and docs aligned to the runtime contract.

## Execution Status

Status as of `2026-03-22`: implemented.

Delivered in code:

- shared pricing-source registry and policy helpers
- primary-consensus admission hardening, including non-`geckoId` eligibility and DEX-inclusive pool-challenge policy
- tracked-deployment-only enrichment fallback and unique-symbol CMC/DexScreener fallback gates
- direct-API DEX quote conversion backed by tracked live stablecoin prices
- replay-safe cache writes, shorter replay TTL, and severe fixed-peg downside publication corroboration
- methodology/docs/version updates and expanded regression coverage

Validation completed during implementation:

- targeted pricing suite: passed
- broader pricing/status/detail suite: passed
- `npm run lint`: passed
- `cd worker && npx tsc --noEmit`: passed
- `npm run build`: passed

Residual medium issues after implementation and validation: `0`

## Scope

This plan covers the full remediation set for the audit findings that are actionable without introducing new external providers or schema-heavy redesigns:

1. primary-consensus admission hardening
2. enrichment/fallback identity hardening
3. DEX quote-derivation safety improvements
4. cached fallback replay hardening
5. shared pricing-source registry/taxonomy cleanup
6. docs, methodology, and validation

Out of scope:

- adding new price providers
- redesigning the entire consensus engine or DEX-liquidity storage model
- introducing manual overrides for arbitrary assets

## Success Criteria

1. No enrichment pass can synthesize cross-chain DefiLlama identities by reusing the same `0x` address on unrelated chains.
2. CMC and DexScreener symbol fallbacks are fail-closed for collision-prone assets instead of best-effort guessing.
3. Primary consensus is no longer globally gated on `geckoId`; assets with valid non-CG voices can still participate.
4. Promoted DEX protocol sources no longer exempt a result from pool challenge merely by being labeled as “hard”.
5. Direct-API DEX price conversion no longer treats tracked USD quote symbols as unconditional `$1` when current tracked prices are available.
6. Fixed-peg severe-downside publication requires corroboration strong enough to distinguish a real crash from a lone bad print.
7. `price_cache` only stores replay-safe prices and stale replay lifetime is materially reduced.
8. Source taxonomy is defined once and reused by runtime metadata, status, and frontend source displays.
9. Tests cover the new guardrails, including USR-class failure patterns.
10. After implementation and validation, residual medium issues for this remediation set are `0`.

## Design Decisions

### D1. Fail closed on identity ambiguity

Any fallback path that cannot bind a price to a tracked asset with chain-aware or curated metadata should skip the price rather than guess.

### D2. Separate “independent hard source” from “DEX-derived source”

Promoted DEX protocol prices are useful, but they are still derived from pool state and should not be treated like Pyth/CEX/Curve oracle data for pool-challenge exemption.

### D3. Cache only prices we are willing to replay

`price_cache` is a replay mechanism, not an archive of every accepted print. Fallback-only and low-confidence prices should not become durable recovery inputs.

### D4. Centralize pricing-source metadata

Source labels, source-health buckets, and human-readable source formatting should live in one shared registry. Runtime trust policy may layer on top of that registry, but the registry itself should be canonical.

### D5. Preserve real deep-depeg publication only when corroborated

The system must still publish real catastrophic depegs, but fixed-peg prices far below reference should require stronger corroboration than a lone live print.

## Workstreams

| ID | Priority | Outcome | Main surfaces |
| --- | --- | --- | --- |
| `P1` | P0 | Shared pricing-source registry and status/UI mutualization | `shared/lib/*`, status/frontend source displays, metadata builder |
| `P2` | P0 | Primary consensus admission hardening | `worker/src/cron/enrich-prices.ts`, `worker/src/lib/redstone.ts`, pricing-source policy helpers |
| `P3` | P0 | Enrichment fallback identity hardening | `worker/src/cron/enrich-prices-passes.ts` |
| `P4` | P0 | DEX quote derivation uses tracked live stablecoin prices when available | `worker/src/lib/dex-api-common.ts`, `worker/src/cron/dex-liquidity/orchestrator.ts` |
| `P5` | P0 | Cache replay writes/TTL narrowed to replay-safe prices | `worker/src/cron/sync-stablecoins/post-enrichment.ts`, `worker/src/cron/sync-stablecoins.ts` |
| `P6` | P1 | Docs, methodology versioning, and validation alignment | pricing docs, methodology copy, tests |

## Implementation Order

```text
Phase 0  Add shared source registry and policy helpers
Phase 1  Harden enrichment identity and primary-source admission
Phase 2  Harden DEX quote derivation and cache replay behavior
Phase 3  Update docs/version surfaces
Phase 4  Validate, self-audit, and iterate until no medium issues remain
```

This order keeps the policy layer in place before touching multiple call sites, then lands the highest-risk integrity fixes before docs and final review.

## Detailed Plan

### P1. Shared Pricing-Source Registry

Problem:
- source labels, source-health buckets, and source ordering are duplicated across:
  - `worker/src/cron/sync-stablecoins/metadata.ts`
  - `src/components/stablecoin-detail/price-transparency-card.tsx`
  - `src/app/coverage/client.tsx`
  - `src/components/status/price-source-health.tsx`

Implementation:

1. Add a shared runtime-neutral pricing-source registry module under `shared/lib/`.
2. Move canonical source labels and source-health bucket ordering into that module.
3. Include currently missing operationally-relevant source keys in the health registry:
   - `curve-oracle`
   - `fluid-dex`
   - `balancer-dex`
   - `raydium-dex`
   - `orca-dex`
4. Update runtime metadata generation and frontend source-formatting consumers to use the shared registry instead of local maps.

Acceptance criteria:

- there is one canonical label map / health-bucket order
- status and detail views no longer maintain separate pricing-source label registries
- source-health metadata can report per-protocol promoted DEX sources and `curve-oracle`

### P2. Primary Consensus Hardening

Problem:
- assets without `geckoId` can be excluded from primary processing even when they have other valid sources
- RedStone can admit effectively single-venue quotes
- pool challenge skips DEX-derived consensus clusters because promoted protocol DEX sources are treated as “hard”
- GeckoTerminal probe only cross-checks single-source CoinGecko results
- severe fixed-peg downside can survive too easily if source admission misses a bad print

Implementation:

1. Remove the `geckoId`-only candidate gate from `fetchPrimaryPrices()`.
2. Let any asset with at least one plausible primary voice participate:
   - DL list
   - Pyth
   - supported CEX venue
   - RedStone
   - Curve on-chain/oracle
   - promoted DEX bridge
3. Tighten RedStone admission to require a real venue set, not just a percentage on a single venue.
4. Replace the current hard/soft source exemption logic with a policy that exempts only genuinely independent non-DEX voices from pool challenge.
5. Expand GT probe eligibility from CG-only single-source assets to the relevant single-source aggregator cases.
6. Add a corroboration gate for severe fixed-peg downside before publication/replay:
   - real multi-source/high-confidence crashes remain publishable
   - lone extreme prints fail closed

Acceptance criteria:

- assets with valid non-CG sources are no longer blocked by missing `geckoId`
- DEX-derived consensus can still be challenged when no independent hard source is present
- single-venue RedStone cannot enter consensus
- severe downside on fixed pegs requires stronger corroboration than a lone source

### P3. Enrichment Identity Hardening

Problem:
- DefiLlama pass `1b` can fabricate same-address cross-chain identity
- CMC and DexScreener symbol fallback remain too permissive for collision-prone assets

Implementation:

1. Replace pass `1b` same-address chain synthesis with tracked-deployment expansion from stablecoin metadata.
2. Query only exact metadata-backed alternate deployments that are known for the tracked asset.
3. Restrict CMC symbol fallback to unique-symbol cases; keep slug as the preferred path.
4. Restrict DexScreener symbol-search fallback to unique-symbol, chain-aligned cases after exact-address lookup fails.

Acceptance criteria:

- pass `1b` never invents alternate chains from the current address string alone
- CMC and DexScreener symbol-only fallback skip ambiguous tracked symbols
- the fallback path still preserves coverage for unique-symbol long-tail assets

### P4. DEX Quote-Derivation Hardening

Problem:
- direct-API DEX quote conversion still treats well-known USD quote symbols as unconditional `$1`

Implementation:

1. Load current tracked stablecoin prices from the stablecoins cache for DEX-liquidity direct-API processing.
2. Pass that reference-price map into `dex-api-common.ts`.
3. When a quote token resolves to a tracked stablecoin, prefer its current tracked price over an unconditional `$1`.
4. Use peg reference only as a fallback when no current tracked price is available.
5. Avoid unconditional symbol-only `$1` behavior for quote tokens when no tracked binding exists.

Acceptance criteria:

- direct-API DEX price derivation uses tracked live prices for tracked stablecoin counterparties
- broad stablecoin stress can no longer be masked by a baked-in `$1` assumption

### P5. Cache Replay Hardening

Problem:
- `price_cache` currently stores every accepted price and can replay stale/weak values for `24h`

Implementation:

1. Introduce explicit replay-safe cacheability rules:
   - exclude `fallback`, `low`, and already-`cached` prices from writes
   - exclude known weak enrichment-only sources from writes
2. Reduce replay TTL from `24h` to a materially shorter operational window.
3. Keep replay validation in place on read.
4. Add tests that prove weak/fallback prices are not persisted for replay.

Acceptance criteria:

- weak enrichment prices do not become replay inputs
- stale replay window is meaningfully shorter
- trusted prior primary prices remain reusable for short outage recovery

### P6. Docs, Versioning, and Validation

Implementation:

1. Update `docs/pricing-pipeline.md`.
2. Update `docs/pricing-pipeline-timeline.md`.
3. Update `/methodology` pricing copy in `src/app/methodology/sections/core-sections.tsx`.
4. Bump `shared/lib/pricing-pipeline-version.ts`.
5. Expand tests for:
   - tracked-deployment DL fallback
   - unique-symbol-only CMC fallback
   - unique-symbol-only DexScreener search fallback
   - non-`geckoId` primary-source eligibility
   - DEX-derived pool challenge eligibility
   - RedStone venue-count gating
   - DEX quote conversion with tracked stablecoin reference prices
   - replay-safe `price_cache` writes and shorter TTL behavior
   - severe-downside corroboration gate

## Validation Plan

Required local validation after implementation:

1. pricing-focused Vitest slice:
   - `worker/src/cron/__tests__/enrich-prices.test.ts`
   - `worker/src/lib/__tests__/price-consensus.test.ts`
   - `worker/src/lib/__tests__/price-validation.test.ts`
   - `worker/src/lib/__tests__/geckoterminal-price-probe.test.ts`
   - `worker/src/lib/__tests__/authoritative-price-sources.test.ts`
   - `worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts`
   - `worker/src/cron/__tests__/dex-liquidity-process-pools.test.ts`
   - `worker/src/cron/__tests__/dex-api-common.test.ts`
   - `worker/src/cron/__tests__/sync-stablecoins.test.ts`
2. `npm run lint`
3. `cd worker && npx tsc --noEmit`
4. if pricing-source shared modules touch frontend/runtime types materially, run `npm test`

## Self-Review Gate

This remediation is not complete until all of the following are true:

1. No remaining medium issue exists in the implemented remediation set.
2. Source taxonomy duplication is reduced rather than increased.
3. Coverage regressions are intentional and documented where safety won over permissiveness.
4. Docs describe the runtime that actually shipped, not the previous one.

Residual medium issues after this plan definition: `0`
