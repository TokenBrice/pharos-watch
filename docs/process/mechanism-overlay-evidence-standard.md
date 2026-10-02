# Mechanism-overlay evidence standard

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
- Component and metric applicability on cdp, synthetic-delta-neutral and rwa-credit-fund
  overlays supports `measured`, `not-applicable` and `unavailable`; wave-7 decision D2
  ratified sdn/rwa, and V10 extends sourced unavailable metrics to cdp.
- Native `ucits-trs-fund`, `shared-reserve`, and `protocol-position` reviews in unreleased
  methodology 10.0 use the [native-family contract](#native-family-admission-and-grading)
  below. Every component remains applicable; no generic PoR or audit metadata auto-grades
  these families.

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

## Scoped reports and bounded observations

Scoped financial engagements retain exact deployment/book/exclusion identities and a matched historical denominator. Financial-assurance fragments require an admitted current economic partition plus a complete verified current-book/exclusion join; remaining share keeps bounded-unknown quality and issuer-undisclosed responsibility. Report units never substitute for current USD liabilities, and scoped reconciliation never silently upgrades whole-token reconciliation or recovery design.

Without that current partition and book join, exact coverage is diagnostic and preserves exactly the legacy report treatment, including the authored legacy reconciliation label, recovery and overlay treatment. A null current-liability share does not withdraw legacy credit. The only exception without a partition is an admitted verified current report envelope explicitly excluding nonzero or unknown-amount liabilities that are affirmatively still owed, with exclusion sources accessed no later than the scope review. Such evidence may remove overbroad legacy credit; merely omitting catalog deployment refs (including escrow-backed representations) may not.

Portfolio, on-chain and standing-structure envelopes have independent clocks and never grant financial assurance, reconciliation or seasoning; a code-security audit is not a financial engagement. Standing feeder identity establishes only a conservative whole-holder instrument, not current holdings, NAV or legal priority. Bounded on-chain observations may identify exact reviewed reserve/escrow contracts and native technical subjects such as `gnosis:native:xdai`, independently of holder `contracts[]` and financial-coverage liability refs. These identities grant no financial, supply or assurance credit; reserve contracts cannot be reused as financial liabilities.

Full independent and operational financial assurance require complete applicable scope; overlays cannot bypass that gate. Exact authoring and producer contracts live in [Stablecoin Data](../stablecoin-data.md#registry-editing-entry) and [Live Reserves](../live-reserves.md#snapshot-metadata-and-warning-effects).


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
    `proofOfReserves.latestReport` supplies both period end and publication date, known
    assurance method and scope, and genuinely supports the report's own grade, leave
    the component out of `components` entirely rather than curating it unavailable.
    An uncertain dated review reference alone is not eligible assurance evidence and
    does not prevent an explicit unavailable review.
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
- CDP `unavailable` requires a null value, nonempty rationale and cited evidence. It
  creates neither numeric adverse signals nor favorable credit. Applicable components
  without authenticated quality stay bounded-unknown with their policy charge and
  evidence trace; independently evidenced component quality remains intact.

Owner ruling 12 removes measured adversity from unauthenticated BUCK liquidation and
dormant FXD funded-backing claims. suiUSDe's July upstream measurements are analogous
context, not direct coverage; these scope corrections do not refresh evidence dates.

## Measured collateralization

The optional collateralization measurement is a sourced reserve-to-liability
pin, not a reserve-composition or surplus-credit claim. The compiler carries
its source URL, evidence references, and `measuredAt` (the overlay's evidence-pin
`reviewedAt` date); it uses the existing
`evidenceExpiry.mechanismOverlayMaxAgeSec` budget, including the elapsed-UTC-day
admission guard. An expired, undated, or unevidenced measurement is unknown and
produces neither a haircut nor credit; a current measured ratio below one
scales Backing and its ceiling, while ratios at or above one grant no credit.

Every authored measurement requires a stable `measurementId` identifying the
measured subject and immutable pin (for an on-chain census: asset, chain, block).
A serial wrapper that
inherits already-haircut parent Backing carries the application identity,
date, evidence references, originating asset, and immediate inheritance parent
in its Backing trace; the same pin is never multiplied again. A distinct
wrapper-local shortfall remains chargeable. Copy the parent's `measurementId`
unchanged when asserting the same measurement, even when an overlay review is
re-pinned or its rationale is reworded; only a genuinely different measurement
receives a new identity.

## Process requirements

- Every overlay entry carries `reviewedAt` (ISO date of the evidence pin), descriptive
  source labels, and notes stating what was measured, at what timestamp/block, and why each
  grade was assigned.
- Date-only overlay claims become score-bearing only after the reviewed UTC day has elapsed.
  During that day the admission gap is method-owned; clocks before the review date receive
  neither the future overlay nor its disposition.
  Curate with the evidence date, never the capture date: a same-day promotion starts with the next capture and temporarily re-attributes the component `method-unsupported` (the elapsed-UTC-day guard in `worker/src/lib/safety-score-v9/extension-mechanism.ts`).
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

## Native-family admission and grading

`MECHANISM_ARCHETYPE_VALUES` owns family vocabulary; strict review schemas in
`shared/types/safety-score-v9-backing.ts` own the component contract. A native family requires
an exact-token `mechanismArchetype` and a resolved, sourced `mechanismArchetypeReview` naming
the current holder claim, deployment and model. The compiler admits that review only after
its UTC day and before the existing mechanism-overlay expiry boundary. A label, a similarly
named token, an issuer fallback configuration, or a retired deployment never establishes
identity: a missing, unresolved, mismatched or noncurrent claim remains `missing-archetype`/NR.
After identity is established, absent protection or unreconciled quantitative detail is
bounded, not a new unsupported-family blocker.

| Family | Required component fields |
|---|---|
| `ucits-trs-fund` | `fundClaimAndSegregation`, `navAndReconciliation`, `portfolioHedge`, `counterpartyAndCollateral`, `custodyContinuity`, `defaultRecovery` |
| `shared-reserve` | `holderClaim`, `liabilityConservation`, `reserveCustody`, `encumbranceAndAllocation`, `defaultRecovery` |
| `protocol-position` | `holderClaim`, `liabilityConservation`, `positionCustody`, `encumbranceAndAllocation`, `defaultRecovery` |

The claim component is serial: a missing or unsupported exact claim cannot earn a rating.
A documented operational claim can be limited while enforceable legal priority is unknown;
it is not a statutory fiat claim or proof of segregation. Every unproved component remains
a required fact with null quality priced at `semantic.backing.boundedUnknownQuality`.
Unvalued circular positions, residual modules, contingent derivatives and unknown liabilities
are charged in conservation/NAV and allocation/collateral components; absence never becomes
zero economic exposure. Issuer nondisclosure keeps `issuer-undisclosed` attribution and its
charge. Explicit `unavailable` rows name the missing fact and source searched; `not-applicable`
and position metrics are rejected for these families.

Grade the lowest fully established rung for the **whole named component**, using the evidence
classes above:

- **Claim:** limited needs the current exact-token operational claim in primary code/terms
  plus deployment or external corroboration. Adequate additionally needs enforceable fund,
  holder-right and segregation terms for the protections claimed. Strong needs complete
  independent reconciliation and enforceable legal prerequisites, not merely UCITS status.
- **Conservation/NAV:** limited needs dated itemized assets and matching liabilities/share
  classes, a reproducible valuation basis and an external anchor. Adequate requires independent
  component-scoped reconciliation at quarterly-or-better cadence; strong requires monthly
  signed complete reconciliation and enforceable protections. Unknown residual scope,
  exclusions, liability denominator or accounting timestamp keeps the component bounded.
- **UCITS hedge:** limited needs current identity-bound physical and signed derivative
  inventory plus the filed portfolio-wide TRS strategy. Adequate additionally reconciles
  every covered and uncovered sleeve with independently verified valuation; strong meets
  complete monthly independent/legal prerequisites. Gross holdings, notional, signed MTM
  and cash are different concepts: never normalize absolute swap marks into reserve weights.
- **UCITS counterparty/collateral:** limited needs dated exact counterparties and posted/
  received collateral exposure with an external anchor. Adequate adds independently verified
  current netting, collateral and reuse scope; strong adds complete independent reconciliation
  and enforceable protections. A rating or daily-unwind promise alone is insufficient.
- **Custody:** limited needs itemized current immediate holders/custodians with chain or filing
  anchors. Adequate adds evidenced segregation and continuity/replacement protections;
  strong meets complete independent/legal prerequisites. A Safe identifies location, not
  signer independence or insolvency priority. Protocol positions price receipt/vault/manager
  continuity locally; underlying stablecoin reserve quality remains upstream.
- **Allocation/encumbrance:** limited needs current complete inventory, liabilities and
  documented allocation/encumbrance rights. Adequate/strong add independent reconciliation
  and enforceable protections at their respective cadences. Unknown pool membership, other
  creditors, residual modules, reuse or external recovery stays bounded.
- **Recovery:** limited needs the exact current loss/withdrawal/default procedure and scoped
  priority from primary code/terms plus an external anchor. Adequate adds enforceable priority,
  funded resources and independent verification; strong meets monthly complete independent/
  legal prerequisites. Happy-path quotes, bridge withdrawals, ERC-4626 conversion and daily
  swap unwind alone do not establish stressed recovery.
- **Weak/failed:** require demonstrated deficiency, never unsuccessful research. Existing
  structural machinery prices proven failure; unknowns retain unresolved ownership.

The numeric authority is only `semantic.backing.archetypes` in the methodology policy JSON,
including component weights, serial and structural keys. Its required
`allowCompleteLiveParentMechanismBypass` is false for these families and true for existing
families: complete live parent quality can price the reserve group but cannot erase the
native family's local mechanism components. Serial adverse parent limits, current measured
collateralization shortfalls, withholding, supply and controls remain unchanged.

Mento reserve-backed currencies all use one shared-reserve rubric, including USDm/EURm with
their current V3 FPMM claim rather than deprecated V2 pools. CDP-backed GBPm/CHFm/JPYm remain
CDPs. Shared pool liabilities include noncatalog PHPm/NGNm where applicable; reserve assets
are not counted once per liability. EURSAFO's exact SAFO EUR share-class fund interest is
not Treasury backing; a zero-unmapped fund-share feed does not close hedge or recovery gaps.
USDB/USDU operational position claims do not prove fiat ownership; external swaps do not
value endogenous modules or grant favorable oracle tiers. USDR remains unresolved absent
current exact-token claim evidence.

This capability uses existing reserve envelopes and curated dated overlays (`metrics: {}`).
It introduces no position producer, circular netting, look-through allocation feed, reserve
percentage/supply override or oracle-tier change. Future position packets would need exact
identity, observation clocks/blocks, complete census, valuation provenance, nullable assets/
liabilities/encumbrances with explicit reasons and separate signed derivative legs; no such
packet or producer is admitted here. Later data authoring must be a uniform Mento cohort
cutover, not an AUDm/CADm-only restoration; token-specific grades may differ under one rule.

## Mixed allocation and legal-layer scope

`shared/types/safety-score-v9-allocation.ts` owns the strict `scopeKind` union:
`whole-allocation` retains legacy whole-book date semantics; `per-dimension` carries exact
scoped claims and cannot satisfy the whole-book branch merely by omitting an uncertain field.
Each claim records `claimKey`, `dimension`, `layer`, exact `target`, `coverage`, `disposition`,
dimension-specific `statement`, rationale, `reviewedAt`, `observedAtSec`, `expiresAtSec`,
sources and source-bound observations. Scoped reviews use exact UTC ISO timestamps or
conservative date-only end-of-day admission and never admit future observations.

Contract targets name chain/address, immutable code or exact proxy implementation, block,
observation time/source and the complete reachable target set. Legal reserve-leg targets name
nullable `sourceKey`/`providerOrEntity`, conditional or whole-book applicability and conditions.
Conditional coverage keeps `shareFraction: null` absent a measurement. Whole-dimension proof
requires the accepted-reserve-envelope denominator, complete nonoverlapping `reserveSourceKeys`
and `shareFraction: 1`; identifying a legal provider alone does not establish full-book coverage.
Compiler-owned `allocationScopeIdentityReview.registeredDeploymentKeys` comes from the supplied
registry contract roster; implementation observations must bind those registered deployments.
An idle-custody N/A additionally requires source-bound `idleCustodyProof` naming the
`burn-parent-mint-parent` mechanism, `upstreamAssetId`, `parentTokenAddress`, `burnSourceUrl`
and `mintSourceUrl`, matched to the actual serial dependency and its parent's exact same-chain
registered token.

The compiler emits private `allocationScopeFacts` for wrappers and nonwrappers and derives
required contract/entity/holder layers from verified reserve/custody facts. Partial, expired,
mismatched or incomplete scopes retain fallback risk; reviewed adverse facts remain adverse.
Synthesized omitted required scopes are `integration-missing` diagnostics, not invented issuer
nondisclosure findings; authored exhaustive `issuer-undisclosed` findings retain their original
aggregate charge.
Burn-parent/mint-parent idle-token custody absence is a contract-only N/A, not legal segregation
or bankruptcy protection. Parent claims must match a real dependency edge and remain adverse-only
diagnostics: they never grant supervision, holder rights, favorable parent Backing, cap relief
or supply changes. Per-coin facts are deferred to the later authoring wave.

## Bounded reserve maturity and liquidity facts

Unreleased methodology 10.0 admits B12 through `ReserveBoundedFactSchema` and the
asset-keyed `reserve-bound-facts-v1.json` registry (initially empty), or the same
payload on a live reserve slice's `boundedFacts`. These are independent scoped
facts, not reserve composition, dependency weights, supply or Exit capacity.
Keep the original category intact; use an exact source/exposure key or a named
sub-instrument. A sub-instrument without a same-snapshot `coveredShare` is diagnostic
only. Every fact pins its primary URLs, publisher, assertion, content digest and
own `asOfSec`; reviewed research additionally names reviewer/date/confidence,
while a producer names observer/source/run/timestamp/confidence without a fake review.

- Contractual maturity maxima require a legally binding instrument claim covering
  all instruments in their exact scope. Calendar months use the longest Gregorian
  calendar duration, not a 30-day conversion. Observed maxima never become covenants,
  WAM/WAL or fund-share expiry: reconcile a dated gross-value roster to its gross
  denominator, use the worst residual tenor, cap informational credit at the policy
  quality selector, and retain the uncovered factor. Already matured instruments
  are not assumed paid. Observations contradicting a covenant withhold its positive
  credit and retain a machine-readable rejection.
- Exhaustive enforceable eligibility envelopes constrain a worst-feasible allocation,
  satisfying minima before filling permitted capacity in ascending quality order.
  Non-exhaustive marketing lists and infeasible constraints grant nothing. Eligibility
  does not create composition: missing-composition gaps, issuer-undisclosed responsibility,
  unknown concentration and all original ceilings remain.
- Current availability requires a reproducible native-asset numerator and positive
  same-snapshot denominator. Reject numerator above denominator; never clamp.
  The evidenced fraction resolves only the unknown liquidity factor at the policy's
  `limited` current-availability quality. It is neither stressed realization nor an
  executable USD exit. Positive independently scoped bounds are not summed where
  coverage could overlap; adverse information and known whole-scope classifications
  continue to bind.
- Structural maturity absence requires the governing instrument and complete scope;
  an open-ended subholding cannot clear the whole-mechanism WAM signal. Stressed
  realization facts separately identify collateral, gross coverage, stress scenario,
  haircut budget, execution conditions, settlement asset and elapsed bound.
  Collateral transfer, ordinary T+1 targets and gated redemptions are not stressed
  final USD settlement. Partial stress coverage never sets the entire horizon.

Admission uses the fact's own snapshot, never its fresh review to renew an old
portfolio. Hard constraints use `reviewedReserveClassificationMaxAgeSec`; portfolio
observations use composition maximum age plus reporting grace; current availability
uses `currentLiquidFractionMaxAgeSec` (10,800 seconds), further restricted by the
producer/run budgets. Date-only reviews must have fully elapsed. Live observations
must match `boundedFactsGeneration` exactly. Compiled `reserveBoundFacts` retain
independent status, evidence references, source generation, resolved freshness budget
and rejection reason. Contradictory same-scope/same-generation records quarantine the
asset; historical captures without new facts retain their original scores.

Origin's producer emits same-pin idle USDC / total vault USDC on the existing keyed
row, without increasing its idle-only redemption capacity. The separate itemized
collateral API observer verifies cache generation around its fetch and retains a
`diagnostic-unreconciled` observation: Ethereum/Base/Hyper strategy figures are not
joined to the Ethereum vault denominator without explicit reconciliation.

Authoring procedure: pin governing identity/scope and assertion; obtain the complete
same-date gross coverage or leave it null; choose the factual kind (never reinterpret
an observation as a covenant); record the true source/review clocks; compile and inspect
the independent admission diagnostics; replay against an unchanged capture and review
directional factor changes, unknown tails, original ceilings and public evidence references.
Issuer non-disclosure keeps its charge. Registry entries and coin data require a separate
reviewed authoring pass; this capability does not manufacture evidence closure.
