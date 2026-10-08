# Chain Health Score

Chain Health Score is the 0-100 composite used by `GET /api/chains`, `/chains/`, and `/chains/[chain]/` to summarize the quality and concentration of stablecoin supply on each supported chain.

- **Current methodology version:** <!-- GENERATED-START: methodology-version-chain-health -->`v1.7`<!-- GENERATED-END: methodology-version-chain-health -->
- **Runtime source:** `shared/lib/chains/health.ts` (the canonical implementation; no compatibility shim is retained)
- **Version source:** `shared/lib/methodology-versions/registry.ts` (shared constants: `shared/lib/methodology-versions/constants.ts`)
- **API source:** `worker/src/api/chains.ts`
- **Route contract:** [chains-page.md](./chains-page.md)
- **Public changelog route:** `/methodology/chain-health-changelog/`
- **Structured changelog:** `shared/data/methodology-changelogs/chain-health/`

## Inputs

`GET /api/chains` loads the strict stablecoins cache, restricts it to `CORE_AGGREGATE_ACTIVE_IDS`, derives non-USD peg references with `derivePegRates(...)`, and hydrates Safety Score inputs only from a fresh accepted V9 publication. The endpoint returns `503` if the stablecoins cache is unavailable. A missing, held, stale, or invalid V9 dependency does not fail the route; the score map stays empty, so quality and the composite are `null`/NR.

The Chain Environment factor reads the static L2BEAT chain-risk snapshot in `shared/lib/chains/l2beat-risk.ts` before using the legacy Pharos resilience tier. The snapshot is sourced from `https://l2beat.com/api/scaling/summary` and is not fetched live at request time.

The response reports the V9 dependency as degraded, stale, or unavailable as appropriate and switches to `no-store`; it never carries stale or held ratings into Chain Health.

The frontend chain profile coordinates `GET /api/chains` with `GET /api/stablecoins`. It renders top-level summary data from the chain snapshot first, then shows composition, backing breakdown, and stablecoin tables only when the stablecoins snapshot includes authoritative freshness metadata, both snapshots share the same `updatedAt`, and the chain's summary total matches the per-chain stablecoin total exactly (within float tolerance).

## Formula

Current `v1.7` composite:

```text
0.30 * quality
+ 0.20 * chainEnvironment
+ 0.20 * concentration
+ 0.20 * pegStability
+ 0.10 * backingDiversity
```

The composite requires non-null `quality` and `pegStability` factors and peg-observation coverage that is `complete`, or `partial` with `coverage >= 0.95` (`PEG_COVERAGE_COMPOSITE_MIN` in `shared/lib/chains/health.ts`); only then is the weighted total rounded to the nearest integer. Partial coverage below 0.95, or `unavailable` coverage, keeps the composite `null`. Peg weight is 0.20, so an unobserved share of at most 5% can move the observed-only peg factor by at most 5 points and the composite by at most 1 point; the unobserved share stays published in `pegStabilityCoverage` and is never imputed. Nominal par references are not observed prices: their supply remains in the peg coverage denominator without entering its observed numerator.

## Factors

| Factor             | Weight | Source                                                                   | Semantics                                                                                                                                                                                                                                                                |
| ------------------ | -----: | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `quality`          |    30% | report-card cache                                                        | Supply-weighted Safety Score average over rated supply only. Not-rated supply is excluded from both the numerator and the denominator; the factor returns `null` when rated supply is below 50% of chain supply.                                                        |
| `chainEnvironment` |    20% | L2BEAT snapshot first, then `shared/lib/chains/index.ts` resilience tier | Matched L2BEAT scaling projects use `40%` stage score plus `60%` average risk sentiment across Sequencer Failure, State Validation, Data Availability, Exit Window, and Proposer Failure. Unmatched chains fall back to tier `1 -> 100`, tier `2 -> 60`, tier `3 -> 20`. |
| `concentration`    |    20% | chain supply shares                                                      | `100 * (1 - HHI)`. A single dominant coin scores `0`; an even N-way split approaches `100 * (1 - 1/N)`.                                                                                                                                                                  |
| `pegStability`     |    20% | cached prices + peg rates | Observed-supply-weighted peg proximity from shared `deriveDepegSignal(...)`. Missing prices/references receive no imputed score. Zero observed supply is `null`; partial observation publishes the observed-only factor and full-positive-supply coverage; the composite is withheld below 95% coverage (see [Peg Coverage](#peg-coverage)). |
| `backingDiversity` |    10% | active stablecoin backing flags                                          | Normalized Shannon entropy across the two active backing cohorts: `rwa-backed` and `crypto-backed`. Coins without backing metadata are excluded.                                                                                                                         |

## Not-Rated Policy

Chain Health has two not-rated (NR) gates: the 50% rated-supply coverage gate on `quality`, and the 95% peg-observation coverage gate for the composite (see [Peg Coverage](#peg-coverage)).

Supply whose stablecoin has no published Safety Score is excluded from the `quality` average — it contributes to neither the numerator nor the denominator. Pharos does not impute a score for unrated supply, because any imputed number is a risk judgement that has not been made. Below 50% rated supply the factor is `null`, which nulls the whole composite (`healthScore` and `healthBand` are `null`) rather than publishing a number derived from a minority of the chain's supply.

Consequence: on a chain with partial coverage, `quality` describes the rated portion of that chain's supply, and the coverage gate — not a synthetic score — is what withholds publication when coverage is too thin.

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

**Active policy since v1.7 (DEC-04; owner threshold 2026-09-28):** zero observed peg coverage makes `healthFactors.pegStability` `null` (NR) and therefore the composite NR. Partial coverage publishes `observedScore` as the factor together with full-positive-supply coverage; the composite (`healthScore`/`healthBand`) is published when `coverage >= 0.95` (`PEG_COVERAGE_COMPOSITE_MIN`) and stays null below it. The bound: with peg weight 0.20, an unobserved share of at most 5% moves the observed-only peg factor by at most 5 points and the composite by at most 1 point. Quality's 50% gate is not reused. Complete coverage retains the existing formula and quality gate. At adoption, chains such as Ethereum (coverage 0.999961; $5.9M unpriced of $148.7B), Tron, Base, Polygon, and Scroll (0.98749) regain a composite, while Hemi (0.159) stays NR. v1.6 required complete coverage for any composite. No producer imputes neutral 50. Activation requires observed Release A Worker/Pages readiness; supported rollback is the nullable-compatible A pair. Pre-v1.6 cached payloads remain labelled with their original methodology, not restamped as observed-only results.

Cutover observation: `/api/chains` uses `producerBacked` caching (edge 300 seconds; browser 60 seconds plus 300 seconds stale-while-revalidate). Allow those existing windows to expire and refetch/revalidate before claiming full cutover; confirm `healthMethodologyVersion: "1.7"`, coverage, factor, and composite together. Error/degraded responses remain `no-store`; deployment must not renew source observation clocks.

## Bands

| Band           | Score  |
| -------------- | ------ |
| `robust`       | 80-100 |
| `healthy`      | 60-79  |
| `mixed`        | 40-59  |
| `fragile`      | 20-39  |
| `concentrated` | 0-19   |

## L2BEAT Snapshot

`v1.5` treats L2BEAT as a static methodology input, not as a live API dependency. Matched Pharos chain IDs are explicit aliases to L2BEAT project IDs; examples include `optimism -> optimism` (public slug `op-mainnet`), `zksync -> zksync2`, `polygon-zkevm -> polygonzkevm`, `morph-l2 -> morph`, `manta -> mantapacific`, and `swellchain -> swell`.

Stage scores are `Stage 2 -> 100`, `Stage 1 -> 80`, `Stage 0 -> 55`, and `Not applicable` / `Under review -> 50`. Risk sentiments score as `good -> 100`, `warning -> 60`, `bad -> 20`, and neutral/under-review values as `50`.

L2BEAT audit helpers also expose Interop-backed bridge-route review candidates for Safety Score research. Live Safety Score scoring does not consume the Chain Health snapshot directly in `v1.5`; bridge-route scoring consumes only curated `bridgeRouteRisk` metadata once a reviewer writes a sourced profile.

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
