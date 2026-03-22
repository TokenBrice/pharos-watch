# Redemption Backstop Audit

Date: 2026-03-22

Scope:
- Shared route-family config adapters: `shared/lib/redemption-backstop-configs/offchain-issuer.ts`, `shared/lib/redemption-backstop-configs/psm-and-basket.ts`, `shared/lib/redemption-backstop-configs/collateral-redeem.ts`, `shared/lib/redemption-backstop-configs/queue-redeem.ts`, `shared/lib/redemption-backstop-configs/stablecoin-redeem.ts`
- Shared scoring/confidence/types: `shared/lib/redemption-backstop-scoring.ts`, `shared/lib/redemption-backstop-confidence.ts`, `shared/types/redemption.ts`
- Worker runtime: `worker/src/lib/redemption-backstop-sources.ts`, `worker/src/lib/redemption-backstops-store.ts`, `worker/src/cron/sync-redemption-backstops.ts`, `worker/src/api/redemption-backstops.ts`
- Live reserve adapters that feed redemption-specific metadata: `worker/src/cron/reserve-adapters/openeden.ts`, `worker/src/cron/reserve-adapters/gho.ts`, `worker/src/cron/reserve-adapters/reservoir.ts`, `worker/src/cron/reserve-adapters/infinifi.ts`, `worker/src/cron/reserve-adapters/single-asset.ts`, `worker/src/cron/reserve-adapters/evm-branch-balances.ts`
- Frontend consumer: `src/components/stablecoin-detail/redemption-backstop-card.tsx`
- Guardrails/tests: `scripts/check-redemption-backstops.ts` plus the focused redemption-backstop Vitest files

Validation run:
- `npm run check:redemption-backstops`
- `npx vitest run shared/lib/__tests__/redemption-backstops.test.ts shared/lib/__tests__/redemption-backstop-scoring.test.ts shared/lib/__tests__/redemption-backstop-consistency.test.ts worker/src/lib/__tests__/redemption-backstop-sources.test.ts worker/src/lib/__tests__/redemption-backstops-store.test.ts worker/src/cron/__tests__/sync-redemption-backstops.test.ts worker/src/api/__tests__/redemption-backstops.test.ts src/components/stablecoin-detail/__tests__/redemption-backstop-card.test.tsx`
- Result: 8 files passed, 82 tests passed

## Executive Summary

The module is structurally sound and reasonably well isolated, but the recent coverage expansion materially outpaced the evidence model behind it.

Audit observations:
- 137 configured routes total
- 102 use `supply-full`
- 31 use `supply-ratio`
- 4 use `reserve-sync-metadata`
- 107 routes use `dynamic-or-unclear` fee models
- 101 routes sit in the `undisclosed-reviewed` fee bucket
- 3 routes have explicit `reviewedAt` plus structured `docs`
- 131 routes are low-confidence by construction if they resolve successfully; only 6 can currently resolve to `medium` or `high`

Bottom line:
- The module is good at expressing modeled coverage breadth.
- It is not yet equally strong at proving that breadth.
- There is one concrete correctness bug in the confidence pipeline.
- There is one important freshness problem where stale reserve metadata can remain “resolved” indefinitely.
- The biggest non-bug issue is evidence quality: the public data often looks more precise than the supporting evidence actually is.

## Priority Findings

### 1. `reserve-sync-metadata` fallback is mislabeled as `dynamic` confidence

Severity: High

Files:
- `worker/src/lib/redemption-backstop-sources.ts:240-289`
- `shared/lib/redemption-backstop-confidence.ts:12-16`
- `worker/src/lib/report-cards-snapshot.ts:295-296`

Problem:
- `resolveCapacityConfidence()` returns `dynamic` for any `reserve-sync-metadata` model.
- `resolveCapacityFromReserveSyncMetadata()` reuses that same confidence even when it falls back to a configured static ratio (`provider: "reserve-sync-fallback"`, `sourceMode: "estimated"`).
- Report cards only exclude routes whose `modelConfidence === "low"`.

Impact:
- A route can silently degrade from live reserve telemetry to a static fallback ratio while still remaining eligible for liquidity uplift.
- Today this primarily affects `iusd-infinifi`, because it is the only route with `kind = "reserve-sync-metadata"` plus `fallbackRatio`.

Why it matters:
- This is the clearest correctness bug in the module. A degraded route should not preserve dynamic-confidence semantics.

Recommended remediation:
- Split “configured model type” from “resolved evidence class”.
- When the resolver uses `reserve-sync-fallback`, emit `capacityConfidence = "heuristic"` or introduce a new explicit tier.
- Add a direct test asserting that fallback resolution cannot produce `medium` or `high` model confidence.

### 2. Stale reserve metadata never ages out of the scored dataset

Severity: High

Files:
- `worker/src/lib/redemption-backstop-sources.ts:252-274`
- `worker/src/lib/redemption-backstop-sources.ts:156-170`

Problem:
- If reserve metadata exists but is older than `LIVE_RESERVE_FRESHNESS_SEC`, the module downgrades `sourceMode` from `dynamic` to `estimated` and appends a note.
- It still keeps the route `resolved`.
- There is no hard staleness ceiling and no dependency on `lastStatus`.

Impact:
- A dynamic route can keep publishing stale immediate-capacity or stale live-fee data indefinitely after the upstream reserve adapter stops succeeding.
- The DEX-liquidity side is stricter: stale DEX data suppresses `effectiveExitScore` materialization. Reserve-backed redemption data is treated more leniently.

Affected routes:
- `usdo-openeden`
- `gho-aave`
- `iusd-infinifi`
- `wsrusd-reservoir`
- Any formula-fee route consuming `redemptionFeeBps` via reserve metadata

Recommended remediation:
- Add a hard expiry policy for reserve-derived redemption metadata.
- After the expiry window, return `missing-capacity` or force a low-confidence unresolved row unless an explicitly weaker fallback model exists.
- Treat stale fee telemetry and stale capacity telemetry separately if necessary, but stop classifying both as indefinitely usable scored inputs.

### 3. Evidence/provenance is too weak for the size of the registry

Severity: High

Files:
- `worker/src/lib/redemption-backstop-sources.ts:67-132`
- `shared/lib/redemption-backstop-configs/offchain-issuer.ts:153-160`
- `shared/lib/redemption-backstop-configs/psm-and-basket.ts:32-42`
- `shared/lib/redemption-backstop-configs/stablecoin-redeem.ts:68-76`
- `src/components/stablecoin-detail/redemption-backstop-card.tsx:256-269`

Problem:
- Only 3 routes currently provide explicit reviewed documentation metadata in config.
- For the other 134 routes, `resolveDocs()` falls back to:
  - the live reserve display URL
  - a proof-of-reserves URL
  - a generic `Docs` / `Transparency` / `Website` link from coin metadata
- The detail card only renders a single top-level link and ignores `docs.sources[]` entirely.

Impact:
- The UI can present a generic “Source” link that does not actually support the modeled redemption route, fee schedule, access restrictions, or settlement semantics.
- The registry is therefore much less auditable than it appears.

Recommended remediation:
- Require structured `docs` plus `reviewedAt` for any route that is intended to be more than heuristic coverage.
- Make the fallback source behavior explicit in the API, or stop presenting generic fallbacks as if they were reviewed route evidence.
- Update the card to render structured provenance with per-source `supports` badges.

### 4. Heuristic models dominate the registry, and most routes are low-confidence by design

Severity: High

Files:
- `shared/lib/redemption-backstop-configs/shared.ts:93-160`
- `worker/src/lib/redemption-backstop-sources.ts:316-342`
- `shared/lib/redemption-backstop-scoring.ts:106-139`
- `shared/lib/redemption-backstop-confidence.ts:73-84`
- `shared/lib/redemption-backstop-configs/offchain-issuer.ts:266-273`
- `shared/lib/redemption-backstop-configs/stablecoin-redeem.ts:78-100`
- `shared/lib/redemption-backstop-configs/collateral-redeem.ts:16-25`

Problem:
- Most families default to `supply-full` or `supply-ratio` from shared base configs.
- `supply-full` always scores against full supply as eventual redeemability.
- `supply-ratio` uses hand-picked ratios with no typed evidence source attached.
- Only `bold-liquity` and `lusd-liquity` currently upgrade full-system redeemability to `documented-bound`.

Impact:
- The registry has broad surface coverage, but only 6 routes can currently become `medium` or `high` confidence.
- 5 routes still carry explicit placeholder notes saying their `15%` capacity ratio is pending protocol-specific research:
  - `dusd-standx`
  - `usdf-astherus`
  - `usr-resolv`
  - `yusd-aegis`
  - `usn-noon`

Interpretation:
- This is not a code bug by itself.
- It is the central evidence-quality weakness of the module.
- The current implementation is better described as “coverage-first with conservative confidence gating” than “precise redeemability measurement”.

Recommended remediation:
- Separate the registry into evidence tiers:
  - `dynamic`
  - `documented-bound`
  - `heuristic-reviewed`
  - `placeholder`
- Add a remediation backlog specifically for placeholder-ratio routes.
- Consider suppressing the headline score entirely, or visually downgrading it harder, for routes that remain `low` confidence.

### 5. Top-level methodology metadata can drift from the stored snapshot

Severity: Medium

Files:
- `worker/src/lib/redemption-backstops-store.ts:377-401`

Problem:
- `buildRedemptionBackstopsSnapshot()` always returns the current in-code methodology constants.
- It does not derive the top-level methodology version from the stored rows.
- Each row still carries `methodologyVersion`, but the envelope can advertise a newer version before the next hourly cron recomputes the table.

Impact:
- For up to one cron interval after a methodology-changing deploy, the API can return old rows with a new top-level methodology version and `isCurrent: true`.

Recommended remediation:
- Derive snapshot-level methodology metadata from stored rows.
- If rows are mixed or stale relative to the in-code version, expose that explicitly.

### 6. Adapter-specific semantics are not always modeled at the stress state that matters

Severity: Medium

Files:
- `shared/lib/redemption-backstop-configs/stablecoin-redeem.ts:18-25`
- `shared/lib/redemption-backstop-configs/psm-and-basket.ts:32-38`
- `worker/src/cron/reserve-adapters/gho.ts:404-426`

Problem:
- `honey-berachain` is modeled as a standard stablecoin redemption route, but its own note says stress conditions can switch it into basket-mode redemptions.
- `gho-aave` computes live `buyFeeBpsMin` / `buyFeeBpsMax` in the reserve adapter, but the redemption route still uses a fixed 10 bps config bound.

Impact:
- `honey-berachain` likely overstates output quality precisely when the backstop matters most.
- `gho-aave` is intentionally conservative, but the current model throws away useful live-fee granularity that the adapter already measures.

Recommended remediation:
- For Honey, model the stress-state route explicitly, or at minimum downgrade output quality / certainty when basket mode is the real fallback behavior.
- For GHO, decide whether the redemption scorer should consume live fee bounds directly instead of freezing a conservative static fee.

### 7. The reserve-to-redemption metadata contract is stringly typed and under-tested

Severity: Medium

Files:
- `worker/src/lib/live-reserves-store.ts:45-56`
- `worker/src/lib/redemption-backstop-sources.ts:156-170`
- `worker/src/lib/redemption-backstop-sources.ts:248-273`
- `worker/src/cron/reserve-adapters/__tests__/openeden.test.ts:1-25`
- `worker/src/cron/reserve-adapters/__tests__/reservoir.test.ts:1-83`
- `worker/src/cron/reserve-adapters/__tests__/infinifi.test.ts:1-147`

Problem:
- `ReserveSyncStateRecord.metadata` is `Record<string, unknown>`.
- The redemption module relies on magic keys:
  - `immediateRedeemableUsd`
  - `immediateRedeemableRatio`
  - `redemptionFeeBps`
- The generic redemption-source tests cover the resolver logic, but several adapter-level tests only assert slice construction and not the metadata fields that actually drive redemption scoring.

Impact:
- A key rename or semantic drift in a reserve adapter can quietly degrade redemption outputs without a strong schema-level failure.

Recommended remediation:
- Introduce a typed reserve-metadata schema for redemption consumers.
- Validate adapter metadata at write time.
- Add adapter-level tests asserting the exact metadata contract for OpenEden, Reservoir, and infiniFi.

### 8. Guardrails focus on registry shape, not evidence quality

Severity: Medium

Files:
- `scripts/check-redemption-backstops.ts:17-111`

Problem:
- The current guard script checks duplicates, route-family placement, unknown IDs, doc-count lines, negative fees, and ratio bounds.
- It does not check:
  - `reviewedAt` / `docs` coverage
  - placeholder-ratio flags
  - confidence distribution
  - reserve-sync routes having real adapter support
  - route-specific evidence expectations

Impact:
- Large coverage expansions can land cleanly in CI while materially weakening evidence quality.

Recommended remediation:
- Add policy checks for:
  - placeholder-route allowlist
  - reviewed-doc minimums
  - reserve-sync coverage integrity
  - explicit evidence tagging per route

## Adapter Review

### Route-family config adapters

| Adapter file | Count | Audit verdict |
| --- | ---: | --- |
| `offchain-issuer.ts` | 78 | Broadest weak spot. Default `issuerBase` (`supply-full`, undisclosed fee) is useful for coverage but too generic for precision. Most routes are low-confidence. |
| `psm-and-basket.ts` | 11 | Mixed quality. `gho-aave` is one of the strongest routes. DAI/USDS are plausible but still heuristic. Basket routes are thinly evidenced. |
| `collateral-redeem.ts` | 18 | Best conceptual fit for full-system redeemability. Only Liquity `BOLD` and `LUSD` currently get documented-bound treatment. |
| `queue-redeem.ts` | 12 | Strongly heuristic. Capacity is mostly hand-modeled ratios with limited evidence. `iusd-infinifi` is the only dynamic route and is currently exposed to the fallback-confidence bug. |
| `stablecoin-redeem.ts` | 18 | Mixed. `wsrusd-reservoir` is dynamic. Several long-tail routes still use placeholder 15% ratios. `honey-berachain` has a real stress-mode modeling gap. |

### Live reserve / fee adapters that directly feed redemption

| Adapter file | Used by | Audit verdict |
| --- | --- | --- |
| `openeden.ts` | `usdo-openeden` | Good dynamic capacity source, but adapter tests do not assert redemption metadata. |
| `gho.ts` | `gho-aave` | Strongest dynamic route implementation. Good warning behavior. Fee telemetry is partially measured but not fully consumed by the scorer. |
| `reservoir.ts` | `wsrusd-reservoir` | Reasonable immediate-capacity heuristic from USDC bucket, but route evidence is still sparse and tests do not assert metadata. |
| `infinifi.ts` | `iusd-infinifi` | Useful dynamic capacity source, but fallback semantics are currently too permissive and tests do not assert metadata. |
| `single-asset.ts` | formula-fee reserve adapters | Fee-probe helper is clean and tested. Good candidate for wider reuse. |
| `evm-branch-balances.ts` | formula-fee reserve adapters | Same as above. Typed enough locally, but the downstream metadata contract remains untyped. |

## Maintainability Review

### What is good

- Clear module boundary between static config, scoring, worker resolution, persistence, API, and frontend rendering.
- Route-family split in `shared/lib/redemption-backstop-configs/*` is the right direction.
- The cron intentionally has no live HTTP work.
- Failure-safe rows are better than leaving stale resolved rows live after a redemption-sync exception.

### Main maintainability weaknesses

1. The evidence model is implicit.

- Confidence depends on a chain of conventions spread across config, reserve metadata keys, and resolver inference.
- The most important semantics are not expressed as a single typed contract.

2. The registry is still too handwritten for its size.

- 137 entries now live as large object literals.
- Reviewability is getting worse as coverage expands.
- Repeated patterns like `...issuerBase, costModel: ...` are already large enough to justify table-driven helpers.

3. Guard and test logic duplicates structural knowledge.

- `familyModules` is duplicated in `scripts/check-redemption-backstops.ts` and `shared/lib/__tests__/redemption-backstop-consistency.test.ts`.
- The same registry-policy concepts are maintained in more than one place.

4. Entry construction is duplicated.

- `buildRedemptionBackstopEntry()` and `buildFailedRedemptionBackstopEntry()` rebuild a large overlapping object shape.
- That increases drift risk when fields are added.

5. The frontend leaves useful fidelity information on the floor.

- `docs.sources`, `supports`, and `capsApplied` are stored but barely surfaced.
- The card shows a score, source mode, and model confidence, but not enough context to explain why a route is low-confidence.

## Recommended Remediation Sequence

### Phase 1: Correctness fixes

1. Fix reserve-sync fallback confidence so static fallback ratios cannot remain `dynamic`.
2. Add a hard expiry policy for stale reserve-derived capacity and fee metadata.
3. Make snapshot-level methodology metadata derive from stored rows, not current constants alone.

### Phase 2: Evidence contract hardening

1. Introduce a typed redemption-supporting reserve metadata schema.
2. Add adapter-level metadata assertions for OpenEden, Reservoir, and infiniFi.
3. Extend `check:redemption-backstops` with evidence-quality rules.

### Phase 3: Modeling quality upgrade

1. Promote more routes from heuristic to documented-bound only when backed by reviewed sources.
2. Eliminate placeholder ratios or quarantine them behind an explicit placeholder tier.
3. Revisit adapter-specific semantics:
   - `honey-berachain`
   - `gho-aave`
   - placeholder 15% routes

### Phase 4: Maintainability refactor

1. Centralize registry-family metadata used by both script and tests.
2. Refactor entry construction into shared builders for resolved and failed rows.
3. Convert the largest config families to table-driven declarations plus helper constructors.

## Planning Implication

If the next implementation cycle has to pick only a few things, the best order is:

1. Fix fallback confidence and stale-data aging.
2. Type the reserve metadata contract.
3. Upgrade provenance and reviewed docs coverage.
4. Then spend effort on long-tail heuristic adapter refinement.

Without those first three steps, more coverage expansion will mostly add low-confidence modeled surface area, not materially better redeemability intelligence.
