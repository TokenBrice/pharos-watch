# Safety Scores

Safety Score V9 is the sole active stablecoin safety model. It publishes evidence-backed grades from A+ through F, with NR reserved for assets whose required facts cannot be bounded honestly.

## Methodology Identity

- Active model: `v9`
- **Current methodology version:** `v9.0`
- Public response schema: report v4 with score trace v3
- Policy: `shared/data/safety-score-v9/methodology-policy-candidate-v1.json`
- Implementation: `shared/lib/safety-score-v9/`
- Structured changelog: `shared/data/methodology-changelogs/safety-score/`
- Public methodology: `/methodology/#safety-scores-methodology`
- Scoring history: `/methodology/scoring-changelog/`

Historical V8 methodology is documented in the scoring changelog. It is not a production API, fallback, selector input, or frontend model.

## V9 Model

V9 evaluates three pillars:

| Pillar | Aggregation weight | Scope |
| --- | ---: | --- |
| Backing | 40% | Reserve quality, mechanism solvency, custody, assurance, and loss-bearing structure |
| Exit | 35% | Same-notional executable capacity, cost, settlement, confidence, diversification, and stress horizon |
| Economic Control | 25% | Mint, upgrade, oracle, bridge, and other binding control paths |

The weights allocate bounded headroom; they are not an unrestricted weighted average. The evaluator applies evidence ceilings, peg behavior, track record, dependencies, wrapper-local risk, structural caps, and causally attributed danger after pillar evaluation.

Missing evidence is classified by reason and ownership. A bounded documentation or integration gap can remain rateable under an explicit ceiling. An unbounded required fact returns NR. F is reserved for causally attributed measured danger rather than ordinary uncertainty.

Serial dependencies remain binding because the child cannot diversify away the parent claim. Basket dependencies contribute at their live exposure weights. Wrapper-local risks are evaluated separately from the parent asset so a wrapper cannot inherit safety it does not possess.

Rateable report-v4 cards include complete Backing, Exit, and Economic Control breakdowns. Each breakdown reconciles evaluator and published values through ordered adjustments. NR cards carry explicit reason rows and have `breakdowns: null`.

## Canonical Publication

The publication pipeline has two active stages:

1. `prepare-safety-score-v9-input` runs every 15 minutes. It captures the publication-exact base input and peg-provenance seed used by the V9 compiler.
2. `compute-safety-score-v9` runs at minutes 14 and 44. It waits for the matching core slot, compiles the V9 fact set, evaluates the policy, and publishes the accepted result.

The private upstream input remains encoded in the exact V8-shaped fixed-input schema because the V9 compiler and deterministic replay contract consume that structure. This is a narrow internal bridge, not an active V8 rating publication. The bridge owns:

- `report-cards:fixed-input:exact`
- `report-cards:v9-peg-provenance-seed:exact`
- the V8 evaluation-build identity required to verify that exact input

V9-only enrichment is loaded directly by the canonical compiler. Supply attribution runs on its dedicated fenced schedule and is admitted only when its identity matches the fixed scoring generation.

Canonical accepted state is stored in:

- `report-cards:v9`
- `report-cards:v9:publication-health`

Both rows carry matching model, schema, methodology, policy, evaluation-build, base-input, and publication identities. The canonical writer accepts only newer publications and commits an accepted publication with its current health atomically.

Publication is fail-closed at the identity and system level. Missing, malformed, stale, or incompatible score-bearing inputs hold the last accepted ratings. Asset-local producer failures do not freeze unrelated ratings while at least 90% of active assets remain unaffected. A held attempt updates publication health only; it does not rewrite the accepted ratings or their timestamp.

The legacy shadow cache keys are read only by migration `0226_safety_score_v9_canonical_cache.sql`, which copies existing accepted state into the canonical keys during rollout. Runtime code does not publish or consume shadow keys. Deleting the old D1 keys requires a later coordinated cleanup migration because migrations run before the new Worker is active.

## API

`GET /api/report-cards/v9` is the only live Safety Score API.

The handler reads the canonical publication and matching health row, validates the complete current response, and never recomputes or falls back to V8. Missing or incompatible state returns `503`. The retired unversioned `/api/report-cards` route and preview aliases return `404`.

A current response emits `X-Safety-Score-Status: current`. A held response serves the last accepted ratings, emits `X-Safety-Score-Status: held`, uses the accepted timestamp for freshness, and forces `Cache-Control: no-store`.

The response includes:

- complete V9 identity and source digests
- methodology and policy identity
- active-set completeness
- current or held publication health
- native three-pillar cards and numeric breakdowns
- the canonical serial/basket dependency graph
- accepted `updatedAt`

See [API Reference](./api-reference.md) for the wire contract.

## Consumers

All active safety consumers resolve the canonical V9 publication:

- Safety Scores, homepage, stablecoin detail, comparison, portfolio, and dependency map
- Yield Intelligence safety hydration
- daily digest and mint/burn flight-to-quality classification
- Telegram grade-change alerts
- OG cards, public datasets, and coverage/status surfaces
- append-only safety-grade history

Consumers that require current ratings reject held publications. Display surfaces may show the held accepted snapshot with an explicit notice. No active consumer uses the V8 compact score cache or computes V8 cards on request.

Selector creation currently fails closed with `503` because its recommendation policy has not been approved for V9. Existing signed selector snapshots remain readable through their historical contract.

## History

`snapshot-safety-grade-history` appends identified V9 organic transitions and suppresses writes while publication is held. Each V2 row records model, methodology, policy, evaluation-build, base-input, publication generation, and transition kind.

`GET /api/safety-score-history` remains the public per-asset timeline. Historical V8 and activation-boundary rows remain readable as archive data; they are never live publication inputs.

## Frontend

- `src/app/safety-scores/v9-client.tsx` owns the active ratings grid, filters, sorting, and held-state presentation.
- `src/components/report-card-mini-v9.tsx` renders the V9 card treatment.
- `src/components/stablecoin-detail/stablecoin-safety-score-v9-card.tsx` renders detail-page score, pillars, evidence, and breakdowns.
- `src/components/radar-chart-v9.tsx` renders Backing, Exit, and Economic Control comparisons.
- `src/components/safety-score-v9-status-notice.tsx` renders held and unavailable publication state.
- `src/hooks/api-hooks.ts` exposes `useReportCardsV9` and `useSafetyScoreHistory`.

The retired V8 report-card components, V8 portfolio synthesis, and contagion stress simulator have been removed. A future stress feature must define native V9 semantics rather than recomputing retired V8 dimensions.
