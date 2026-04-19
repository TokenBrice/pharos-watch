# Chain Health Score

Chain Health Score is the 0-100 composite used by `GET /api/chains`, `/chains/`, and `/chains/[chain]/` to summarize the quality and concentration of stablecoin supply on each supported chain.

- **Current methodology version:** `v1.2`
- **Runtime source:** `shared/lib/chain-health.ts`
- **Version source:** `shared/lib/chain-health-version.ts`
- **API source:** `worker/src/api/chains.ts`
- **Route contract:** [chains-page.md](./chains-page.md)
- **Version timeline:** [chain-health-timeline.md](./chain-health-timeline.md)

## Inputs

`GET /api/chains` loads the strict stablecoins cache, derives non-USD peg references with `derivePegRates(...)`, and reads the current report-card cache for Safety Score inputs. The endpoint returns `503` if the stablecoins cache is unavailable. Report-card cache misses do not fail the route; they reduce or null out the quality factor depending on coverage.

The frontend chain profile coordinates `GET /api/chains` with `GET /api/stablecoins`. It renders top-level summary data from the chain snapshot first, then shows composition, backing breakdown, and stablecoin tables only when both snapshots share the same `updatedAt` and the stablecoins snapshot includes authoritative freshness metadata.

## Formula

Current `v1.2` composite:

```text
0.30 * quality
+ 0.20 * chainEnvironment
+ 0.20 * concentration
+ 0.20 * pegStability
+ 0.10 * backingDiversity
```

The score is `null` when `quality` is `null`; otherwise the weighted total is rounded to the nearest integer.

## Factors

| Factor | Weight | Source | Semantics |
| --- | ---: | --- | --- |
| `quality` | 30% | report-card cache | Supply-weighted Safety Score average. Unrated coins default to `40`, but the factor returns `null` when rated supply is below 50% of chain supply. |
| `chainEnvironment` | 20% | `shared/lib/chains.ts` resilience tier | Tier `1 -> 100`, tier `2 -> 60`, tier `3 -> 20`. |
| `concentration` | 20% | chain supply shares | `100 * (1 - HHI)`. A single dominant coin scores `0`; an even N-way split approaches `100 * (1 - 1/N)`. |
| `pegStability` | 20% | cached prices + peg rates | Supply-weighted peg proximity. Missing prices contribute neutral `50`. |
| `backingDiversity` | 10% | active stablecoin backing flags | Normalized Shannon entropy across the two active backing cohorts: `rwa-backed` and `crypto-backed`. Coins without backing metadata are excluded. |

## Bands

| Band | Score |
| --- | --- |
| `robust` | 80-100 |
| `healthy` | 60-79 |
| `mixed` | 40-59 |
| `fragile` | 20-39 |
| `concentrated` | 0-19 |

## Update Contract

When Chain Health behavior changes, update these files together:

1. `shared/lib/chain-health.ts`
2. `shared/lib/chain-health-version.ts`
3. `docs/chain-health.md`
4. `docs/chain-health-timeline.md`
5. `docs/chains-page.md`
6. `docs/api-reference.md` (`GET /api/chains`)
7. `/methodology` Chain Health copy and changelog route when user-facing methodology text changes
