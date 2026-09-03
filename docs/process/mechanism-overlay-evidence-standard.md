# Mechanism-overlay evidence standard (fiat-cash, tbill, commodity-claim, and partial metrics)

Status: canonical. Ratified by the owner on 2026-07-27 (wave-7 decision D3); extended to the
`commodity-claim` archetype by methodology v9.14. This is the owner-approved evidence standard
referenced by the compiler-bounded overlay gate in
`worker/src/lib/safety-score-v9/extension-mechanism.ts`. Until this document existed, curated
overlay claims on fiat-cash and tbill mechanism components were procedurally forbidden; they
are now admissible only under the rules below.

## Scope

- Curated component claims in `shared/data/safety-score-v9/mechanism-review-overlays-v1.json`
  for the **fiat-cash** components (`claimAndSegregation`, `custodyContinuity`,
  `assuranceAndReconciliation`), **tbill** components (`fundClaimAndSeniority`,
  `navValuation`, `durationAndLiquidity`, `lossRecoveryDesign`), and **commodity-claim**
  components (`titleAndAllocation`, `custodyContinuity`, `assuranceAndReconciliation`,
  `physicalRedemption`). These components are compiler-bounded by design, except
  `assuranceAndReconciliation` (fiat-cash, commodity-claim) and `lossRecoveryDesign`
  (tbill), which the compiler grades from `proofOfReserves.latestReport`. A curated
  overlay claim overrides that conservatism — or that restated report quality — and is
  therefore held to the strictest sourcing bar in the scoring system.
- For `commodity-claim`, the curated `physicalRedemption` component is also the single source
  of the asset's `physical-redemption` mechanism-exit fact: the Exit pillar reads a projection
  of the same statement rather than a second declaration. A `measured` component projects a
  `supported` exit fact at the same quality, an `unavailable` component projects an
  `issuer-undisclosed` exit fact, and a `not-applicable` component projects nothing — a
  structurally absent redemption right is not evidence that an exit route exists.
- The `not-applicable` / `unavailable` component-applicability states and the
  corresponding metric-applicability states on cdp (two-state: `measured` /
  `not-applicable`), synthetic-delta-neutral, and rwa-credit-fund overlays; wave-7
  decision D2 ratified the three-state sdn / rwa schema.

## Evidence classes

A curated quality claim must be supported by at least one **primary** source pinned in the
overlay's `sources` array. Quality grades map to evidence strength; when the evidence class
for a grade is not met, claim the lower grade or leave the component uncurated (bounded).

| Grade | Minimum evidence |
|---|---|
| `strong` | Independent, named attestor or auditor; dated reserve-to-liability (or NAV) reconciliation at monthly-or-better cadence; the legal claim/segregation structure documented in enforceable filings (prospectus, trust deed, regulatory register) — all three, each pinned. |
| `adequate` | A dated independent attestation, regulatory filing, or independently operated oracle feed (Chronicle-class) covering the specific component; cadence quarterly-or-better; no unresolved contradiction with issuer statements. |
| `limited` | Issuer-published structured data (API, dashboard with itemized figures) corroborated by at least one verifiable external anchor: an on-chain read, a regulatory register entry, or a named third-party service agreement. |
| `weak` / `failed` | Documented evidence of the deficiency itself (a measured shortfall, a lapsed attestation, an adverse event), pinned like any other claim. Never grade `weak` merely because evidence is missing — absence of evidence keeps the component bounded, it is not a measured weakness. |

## Explicitly insufficient (never admit these)

Wave-6 packet research produced the canonical negative examples; they remain the test:

- A regulatory license or registration alone (BMA licensing is not reconciliation evidence —
  `fusd-finchain`).
- Announced or in-preparation attestations ("public attestations are being prepared" —
  `gbpe-monerium`).
- Issuer dashboards without an itemized, dated reconciliation or any external anchor
  (`usdu-usdu-finance`).
- Marketing pages, blog posts, or press releases, except as corroboration of a primary
  filing they link to.
- Any source that cannot be pinned (login-walled, undated, or mutable without archive).

## Component applicability states

- `measured` — the component has a sourced quality claim that meets the evidence class for
  that quality. Omitting applicability on a quality claim has the same meaning.
- `not-applicable` — the component structurally does not apply to the mechanism. Requires a
  rationale and a pinned primary source demonstrating the structural absence. It is not a
  shortcut for a disclosure that could exist but was not found.
- `unavailable` — the component applies, but the reviewed disclosure location does not
  publish enough evidence to assign a quality. Requires a rationale naming the missing
  disclosure and a `sourceUrl` matching the overlay's `sources` array. The component remains
  bounded-unknown, its penalty is retained, and responsibility re-attributes to
  issuer-undisclosed. This is a sourced nondisclosure disposition, not a quality claim or an
  evidence closure.
  - **Do not use `unavailable` on the auto-known assurance component without checking
    `proofOfReserves.latestReport` first.** `assuranceAndReconciliation` (fiat-cash,
    commodity-claim) and `lossRecoveryDesign` (tbill) are the one case where the compiler
    fallback (`assuranceFact()` in `worker/src/lib/safety-score-v9/extension-mechanism.ts`)
    can already be `known` rather than bounded. `expandOverlayReview` gives any curated
    component entry priority over that fallback, so a curated `unavailable` row on that
    field demotes a known fact to bounded-unknown with no warning. When the asset's
    `proofOfReserves.latestReport` exists and genuinely supports the report's own grade,
    leave the component out of `components` entirely rather than curating it unavailable.
    `shared/types/__tests__/safety-score-v9-overlays.test.ts` fails the build if a row does
    this.

## Metric applicability states (cdp / sdn / rwa)

- `measured` — a numeric value with a pinned source. Default when applicability is absent.
- `not-applicable` — the metric structurally does not apply to this mechanism (for example
  a maturity ladder on a demand-deposit claim). Requires a rationale AND a pinned source
  demonstrating the structural absence. Skips the linked structural penalty signal.
- `unavailable` — the metric applies but the issuer publishes no measurable value. Requires
  a rationale naming what was searched and a pinned source for where the disclosure should
  live. The linked conservative structural signal may keep firing, but it remains
  issuer-undisclosed rather than measured-adverse: an absent value is never converted into
  a measured finding. Use this state honestly — it records nondisclosure, it does not clear
  it.
- CDP metrics never use `unavailable` (the collateralization banding needs a numeric
  ratio); the adapter rejects it with a directed error.

## Process requirements

- Every overlay entry carries `reviewedAt` (ISO date of the evidence pin), descriptive
  source labels, and notes stating what was measured, at what timestamp/block, and why each
  grade was assigned.
- Date-only overlay claims become score-bearing only after the reviewed UTC day has elapsed.
  During that day the admission gap is method-owned; clocks before the review date receive
  neither the future overlay nor its disposition.
- Curated overlay claims expire. An overlay stops being score-bearing 365 days after its
  `reviewedAt` date (`evidenceExpiry.mechanismOverlayMaxAgeSec`); its components re-bound to
  the conservative compiler path until the evidence is re-pinned.
- Metric-applicability and non-measured component `sourceUrl`s must match an entry in the
  overlay's `sources` array (validator-enforced).
- Overlays are identity-bound: every batch lands through a replay on the pinned production
  envelope with an attributed mover list before push. Unexplained movers stop the batch.
- Adverse-pinned assets take no overlay edits without an explicit owner ruling.
- Fabricating, extrapolating, or averaging a metric to satisfy schema completeness is
  prohibited; the `unavailable` state exists precisely so honesty and schema validity never
  conflict.
