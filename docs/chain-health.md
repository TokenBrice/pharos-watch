# Chain Health Score

Chain Health Score is the 0-100 composite used by `GET /api/chains`, `/chains/`, and `/chains/[chain]/` to summarize the quality and concentration of stablecoin supply on each supported chain.

- **Current methodology version:** <!-- GENERATED-START: methodology-version-chain-health -->`v1.7`<!-- GENERATED-END: methodology-version-chain-health -->
- **Runtime source:** `shared/lib/chains/health.ts` (the canonical implementation; no compatibility shim is retained)
- **Version source:** `shared/lib/methodology-versions/registry.ts` (shared constants: `shared/lib/methodology-versions/constants.ts`)
- **API source:** `worker/src/api/chains.ts`
- **Product route:** [Chain Health](https://pharos.watch/chains/)
- **Public changelog route:** `/methodology/chain-health-changelog/`
- **Structured changelog:** `shared/data/methodology-changelogs/chain-health/`

## Inputs

`GET /api/chains` loads the strict stablecoins cache, restricts it to `CORE_AGGREGATE_ACTIVE_IDS`, derives non-USD peg references with `derivePegRates(...)`, and hydrates Safety Score inputs only from a fresh accepted V9 publication. The endpoint returns `503` if the stablecoins cache is unavailable. A missing, held, stale, or invalid V9 dependency does not fail the route; the score map stays empty, so quality and the composite are `null`/NR.

The Chain Environment factor reads the static L2BEAT chain-risk snapshot in `shared/lib/chains/l2beat-risk.ts` before using the legacy Pharos resilience tier. The snapshot is sourced from `https://l2beat.com/api/scaling/summary` and is not fetched live at request time.

The response reports the V9 dependency as degraded, stale, or unavailable as appropriate and switches to `no-store`; it never carries stale or held ratings into Chain Health.

The frontend chain profile reads `GET /api/chains?chain=<chainId>` through `useChainDetail()`. Its summary, composition, backing breakdown, and stablecoin table use that single Worker-owned generation; it does not fetch or reconcile a separate `/api/stablecoins` snapshot.

`chain_supply_history` is an actively collected forward-only internal baseline, not a live `/api/chains` input. Public history/chart activation requires scope, provenance and bounded capacity approval with an explicit UTC baseline strictly after 2026-04-08. A post-fix date or latest completion marker cannot certify the archive; older rows remain internal and missing days stay gaps.

## Formula

Current `v1.7` composite:

```text
0.30 * quality
+ 0.20 * chainEnvironment
+ 0.20 * concentration
+ 0.20 * pegStability
+ 0.10 * backingDiversity
```

The weighted total is rounded to the nearest integer only after the [quality](#not-rated-policy) and [peg-coverage](#peg-coverage) gates pass; otherwise `healthScore` and `healthBand` are `null`.

## Factors

| Factor             | Weight | Source                                                                   | Semantics                                                                                                                                                                                                                                                                |
| ------------------ | -----: | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `quality` | 30% | fresh accepted Safety Score publication | Supply-weighted average over rated supply only; [Not-Rated Policy](#not-rated-policy) owns admission. |
| `chainEnvironment` |    20% | L2BEAT snapshot first, then `shared/lib/chains/index.ts` resilience tier | Matched L2BEAT scaling projects use `40%` stage score plus `60%` average risk sentiment across Sequencer Failure, State Validation, Data Availability, Exit Window, and Proposer Failure. Unmatched chains fall back to tier `1 -> 100`, tier `2 -> 60`, tier `3 -> 20`. |
| `concentration`    |    20% | chain supply shares                                                      | `100 * (1 - HHI)`. A single dominant coin scores `0`; an even N-way split approaches `100 * (1 - 1/N)`.                                                                                                                                                                  |
| `pegStability` | 20% | cached prices + peg rates | Observed-supply-weighted proximity from `deriveDepegSignal(...)`; [Peg Coverage](#peg-coverage) owns denominator and composite admission. |
| `backingDiversity` |    10% | active stablecoin backing flags                                          | Normalized Shannon entropy across the two active backing cohorts: `rwa-backed` and `crypto-backed`. Coins without backing metadata are excluded.                                                                                                                         |

## Not-Rated Policy

Supply without a published Safety Score contributes to neither numerator nor denominator of `quality`; no rating is imputed. Below 50% rated supply, `quality` is `null` and the composite is NR rather than a judgement based on a minority of supply. At sufficient coverage the factor still describes only the rated portion. The independent [peg-coverage gate](#peg-coverage) must also pass.

## Peg Coverage

Every chain row carries `pegStabilityCoverage`, computed by `assessPegStability(...)` in `shared/lib/chains/health.ts` against the chain's **full positive supply** (every coin on the chain, including coins with no peg reference, so missing-reference supply cannot inflate coverage):

| Field                     | Meaning                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `status`                  | `complete` (every coin observed), `partial` (some observed), `unavailable` (no observation at all)       |
| `observedSupplyUsd`       | Supply with a usable price and a usable (finite, positive) peg reference                                 |
| `eligibleSupplyUsd`       | Full positive chain supply (the coverage denominator)                                                    |
| `coverage`                | `observedSupplyUsd / eligibleSupplyUsd`                                                                  |
| `noUsablePriceSupplyUsd`  | Supply with a usable reference but no usable price                                                       |
| `noPegReferenceSupplyUsd` | Supply without a usable peg reference                                                                    |
| `neutralImputedSupplyUsd` | Always `0` for v1.6+ producers; retained to interpret pre-v1.6 cached payloads that used neutral `50` |
| `observedScore`           | Supply-weighted peg proximity over observed supply only; `null` when nothing was observed                |

Zero observed peg supply makes the factor and composite NR. Partial observation publishes `observedScore`, but the composite requires `coverage >= 0.95` (`PEG_COVERAGE_COMPOSITE_MIN`). With peg weight 0.20, the at-most-5% unobserved share bounds the peg-factor difference to 5 points and the composite difference to 1 point; missing supply is never imputed. Nominal par supply stays in the denominator, not the observed numerator. Legacy payloads retain their methodology labels and `neutralImputedSupplyUsd` compatibility field; they are not restamped as observed-only results.

Activation requires observed nullable-compatible Worker/Pages readiness; rollback is limited to that pair. Verify methodology, coverage, factor and composite together after standard cache revalidation. Error/degraded responses remain `no-store`, and deployment never renews source clocks.

## Bands

| Band           | Score  |
| -------------- | ------ |
| `robust`       | 80-100 |
| `healthy`      | 60-79  |
| `mixed`        | 40-59  |
| `fragile`      | 20-39  |
| `concentrated` | 0-19   |

## L2BEAT Snapshot

L2BEAT is a static methodology input, not a live dependency. `resolveL2BeatProjectId()` in `shared/lib/chains/l2beat-risk.ts` owns explicit Pharos-to-project aliases; public slugs are not inferred project IDs.

Stage scores are `Stage 2 -> 100`, `Stage 1 -> 80`, `Stage 0 -> 55`, and `Not applicable` / `Under review -> 50`. Risk sentiments score as `good -> 100`, `warning -> 60`, `bad -> 20`, and neutral/under-review values as `50`.

Interop audit candidates are research leads only. Safety Score consumes separately reviewed `bridgeRouteRisk` metadata, not the Chain Health snapshot.

`GET /api/chains` keeps the numeric `healthFactors.chainEnvironment` field and adds `chainEnvironmentEvidence` beside it. Matched projects return the consumed L2BEAT project ID, slug, stage score, risk score, five risk fields, and snapshot source date; unmatched chains return the fallback Pharos resilience tier. This is evidence/provenance only and does not introduce live L2BEAT fetching.

These are available manual maintenance tools; unscheduled does not mean disabled. They never automatically import upstream data into the static snapshot.

- `npm run audit:coverage -- --domain=l2beat-snapshot --check` validates explicit aliases against the checked-in snapshot only. Without observed input, passing does not establish current upstream parity.
- Add `--input <saved-summary.json> --check` for consumed-field drift against a saved observation; retain its source/access date. Saved input establishes parity with that capture, not today's live API.
- `npm run audit:coverage -- --domain=l2beat-snapshot --live --check --report agents/l2beat-snapshot-coverage.md` explicitly fetches the current L2BEAT summary for manual review. Alias-integrity and consumed-field drift fail `--check`; observed-only additions do not become authority.
- `npm run candidates:l2beat-bridge-routes` writes heuristic research leads to `agents/l2beat-bridge-route-candidates.md`. The current Safety Score consumes only reviewed bridge evidence after exact deployed-route, control, contract, and source verification and per-coin curation. Text matches never author a profile or backing edge, and host-chain context does not prove backing exposure.

## Update Contract

When Chain Health behavior changes, update these files together:

1. `shared/lib/chains/health.ts`, `shared/lib/chains/l2beat-risk.ts`, and `shared/lib/depeg-signals.ts` (shared peg-deviation primitive) if exports change
2. `shared/lib/methodology-versions/registry.ts` and `shared/lib/methodology-versions/constants.ts` if exports change
3. `docs/chain-health.md`
4. `shared/data/methodology-changelogs/chain-health/`
5. `docs/chains-page.md`
6. `docs/api-reference.md` (`GET /api/chains`; generated from `scripts/maintenance/generate-api-reference.ts`)
7. `/methodology` Chain Health copy and changelog route when user-facing methodology text changes
8. `src/app/chains/page.tsx` and `src/app/chains/[chain]/client.tsx` if any user-facing factor labels or weights change
