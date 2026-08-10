# Chain Health Score

Chain Health Score is the 0-100 composite used by `GET /api/chains`, `/chains/`, and `/chains/[chain]/` to summarize the quality and concentration of stablecoin supply on each supported chain.

- **Current methodology version:** `v1.5`
- **Runtime source:** `shared/lib/chains/health.ts` (re-exported by `shared/lib/chain-health.ts`)
- **Version source:** `shared/lib/methodology-versions/chain-health.ts` (shared constants: `shared/lib/methodology-versions/constants.ts`)
- **API source:** `worker/src/api/chains.ts`
- **Route contract:** [chains-page.md](./chains-page.md)
- **Public changelog route:** `/methodology/chain-health-changelog/`
- **Structured changelog:** `shared/data/methodology-changelogs/chain-health/`

## Inputs

`GET /api/chains` loads the strict stablecoins cache, filters it to active non-frozen/non-defunct stablecoins, derives non-USD peg references with `derivePegRates(...)`, and reads the current report-card cache for Safety Score inputs. The endpoint returns `503` if the stablecoins cache is unavailable. Report-card cache misses do not fail the route; they reduce or null out the quality factor depending on coverage.

The Chain Environment factor reads the static L2BEAT chain-risk snapshot in `shared/lib/chains/l2beat-risk.ts` before using the legacy Pharos resilience tier. The snapshot is sourced from `https://l2beat.com/api/scaling/summary` and is not fetched live at request time.

The compact report-card cache carries a `degradedInputs` marker. When cached Safety Scores were computed from stale report-card inputs, Chain Health keeps the cached score map available but downgrades `_meta.dependencies.reportCards` to `degraded`, switches the response to `no-store`, and emits a freshness warning.

The frontend chain profile coordinates `GET /api/chains` with `GET /api/stablecoins`. It renders top-level summary data from the chain snapshot first, then shows composition, backing breakdown, and stablecoin tables only when both snapshots share the same `updatedAt` and the stablecoins snapshot includes authoritative freshness metadata.

## Formula

Current `v1.5` composite:

```text
0.30 * quality
+ 0.20 * chainEnvironment
+ 0.20 * concentration
+ 0.20 * pegStability
+ 0.10 * backingDiversity
```

The score is `null` when `quality` is `null`; otherwise the weighted total is rounded to the nearest integer.

## Factors

| Factor             | Weight | Source                                                                   | Semantics                                                                                                                                                                                                                                                                |
| ------------------ | -----: | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `quality`          |    30% | report-card cache                                                        | Supply-weighted Safety Score average over rated supply only. Not-rated supply is excluded from both the numerator and the denominator; the factor returns `null` when rated supply is below 50% of chain supply.                                                        |
| `chainEnvironment` |    20% | L2BEAT snapshot first, then `shared/lib/chains/index.ts` resilience tier | Matched L2BEAT scaling projects use `40%` stage score plus `60%` average risk sentiment across Sequencer Failure, State Validation, Data Availability, Exit Window, and Proposer Failure. Unmatched chains fall back to tier `1 -> 100`, tier `2 -> 60`, tier `3 -> 20`. |
| `concentration`    |    20% | chain supply shares                                                      | `100 * (1 - HHI)`. A single dominant coin scores `0`; an even N-way split approaches `100 * (1 - 1/N)`.                                                                                                                                                                  |
| `pegStability`     |    20% | cached prices + peg rates                                                | Supply-weighted peg proximity. Deviation comes from the shared `deriveDepegSignal(...)` primitive (`shared/lib/depeg-signals.ts`), the same derivation the depeg pipeline uses. Missing or unusable prices contribute neutral `50`.                                       |
| `backingDiversity` |    10% | active stablecoin backing flags                                          | Normalized Shannon entropy across the two active backing cohorts: `rwa-backed` and `crypto-backed`. Coins without backing metadata are excluded.                                                                                                                         |

## Not-Rated Policy

Chain Health has exactly one not-rated (NR) mechanism: the 50% rated-supply coverage gate on `quality`.

Supply whose stablecoin has no published Safety Score is excluded from the `quality` average — it contributes to neither the numerator nor the denominator. Pharos does not impute a score for unrated supply, because any imputed number is a risk judgement that has not been made. Below 50% rated supply the factor is `null`, which nulls the whole composite (`healthScore` and `healthBand` are `null`) rather than publishing a number derived from a minority of the chain's supply.

Consequence: on a chain with partial coverage, `quality` describes the rated portion of that chain's supply, and the coverage gate — not a synthetic score — is what withholds publication when coverage is too thin.

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

Maintenance commands:

- `npm run audit:coverage -- --domain=l2beat-snapshot -- --check` validates that explicit Pharos aliases still point at checked-in snapshot projects.
- `npm run audit:coverage -- --domain=l2beat-snapshot -- --live --report agents/l2beat-snapshot-coverage.md` compares the checked-in snapshot against the current L2BEAT summary payload for manual review.
- `npm run candidates:l2beat-bridge-routes` writes an advisory `agents/l2beat-bridge-route-candidates.md` queue for reviewed `bridgeRouteRisk` profiles. Safety Score V9 can consume a profile only after it is verified and curated into per-coin metadata.

## Update Contract

When Chain Health behavior changes, update these files together:

1. `shared/lib/chains/health.ts`, `shared/lib/chains/l2beat-risk.ts`, `shared/lib/depeg-signals.ts` (shared peg-deviation primitive), and the `shared/lib/chain-health.ts` facade if exports change
2. `shared/lib/methodology-versions/chain-health.ts` and `shared/lib/methodology-versions/constants.ts` if exports change
3. `docs/chain-health.md`
4. `shared/data/methodology-changelogs/chain-health/`
5. `docs/chains-page.md`
6. `docs/api-reference.md` (`GET /api/chains`)
7. `/methodology` Chain Health copy and changelog route when user-facing methodology text changes
