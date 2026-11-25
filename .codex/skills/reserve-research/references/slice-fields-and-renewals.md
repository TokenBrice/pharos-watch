# Slice Fields And Renewals

The schema files win over this list: `shared/types/reserves.ts`, `shared/types/stablecoin-meta-primitives.ts`, and the refinements in `shared/lib/stablecoins/schema.ts`.

## Trap Fields

- `sourceKey`: namespace-qualified stable key for keyed live-row matching. Required on a `0`% reviewed slice and on a `publishedResidualCategory`.
- `intermediary`: the bridge, wrapper token or vault share a slice is held through; requires `coinId`.
- `unclassifiedResidual: true` with `residualReason: "insufficient-evidence"`: a producer-declared unknown quantity. Both or neither.
- `publishedResidualCategory: true`: an issuer-named, measured category in a complete published book, never a computed coverage plug.
- `reserveReview.nonLinkDispositions[].ownLiability: true`: the claim holds or redeems into the subject coin itself; valid only with the `self-reserve` disposition.
- `reserveReview.knownUnknownExposurePct`: must equal the total `pct` of unresolved dispositions.
- `reportScopeId`: binds a report-derived composition to its exact `proofOfReserves.latestReport.coverage` scope and period. A review cannot be both report-derived and independently observed.
- `assetClass: "commodity-allocated"`: only for commodity-pegged coins (`npm run check:stablecoin-data` rejects it elsewhere).
- Base `collateral` prose must not drift from the slices; `npm run check:stablecoin-data` reports the drift.

## Renewal Guardrails

- **PoR lockstep.** `reserveReview.compositionAsOf` must equal `proofOfReserves.latestReport.periodEnd`. Move the base `latestReport` in the same edit, with `publishedAtBasis: "signed-date-standin"` when the report prints only a signature or as-of date. The date decouples only through `compositionSource: "live-adapter"` with `liveReservesConfig`, verified `reserveReview.observations`, or a verified `reserveReview.compositionFiling`; [Editing Rules](../../../../docs/stablecoin-data.md#editing-rules) owns the conditions. `reserveReview.reviewedAt` must not predate `compositionAsOf`.
- **No favorable re-dating.** A standing-structure composition (no dated composition report) is re-dated only when its rows carry conservative high risk tiers. Favorable-tier standing claims expire until dated evidence exists ([worklist rules](../../../../docs/process/safety-score-curation-expiry-sweep.md#3-generate-the-worklist)).
- **Exact token denominator.** Shares describe the subject token, not a staked or wrapped sibling; reconcile the denominator to the same book and date as the numerators.
- **A renewal re-verifies.** An unchanged fact still needs a newly dated source; if the issuer has published nothing newer, record the blocker and let the composition expire.
