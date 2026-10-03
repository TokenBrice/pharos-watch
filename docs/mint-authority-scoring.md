# Mint Authority Score (retired lane)

**Retired at safety methodology `9.1` (2026-08-08).** Mint risk is now graded once,
by the Safety Score V9 Economic Control pillar's mint component. This document is
kept because the methodology lane still renders its history at
`/methodology/#mint-authority-score`; nothing on the site scores from it.

> **Agent navigation** — Start at [Mint authority entry](#mint-authority-entry). Current V9 guidance and the retired standalone score are separate; do not apply historical formulas to live grades.

## Mint authority entry

For current scoring and evidence, read [Current V9 scope](#current-v9-scope), the [Mint Authority Taxonomy](./classification.md#mint-authority-taxonomy), and the [native issuance / Bridge Risk authoring boundary](./stablecoin-data.md#mint-authority-and-bridge-risk-ownership). [Report cards](./report-cards.md) owns the live Safety Score methodology.

The sections from [Methodology Versioning](#methodology-versioning) through the historical formula, caps, and bands describe the retired lane only. Read them for historical interpretation, not live score changes.

### Retired signal migration

Where the signals went:

| Retired signal | Where it lives now |
| --- | --- |
| Incident age decay | `semantic.control.mintMergedSignals.resolvedIncidentQualityCaps` |
| MPC/HSM key custody | `semantic.control.mintMergedSignals.attestedKeyCustodyQuality` / `unattestedEoaPenalty` |
| Multisig threshold ladder | `semantic.control.mintMergedSignals.multisigQuorumAdjustment` |
| Modules/guards evidence | `semantic.control.mintMergedSignals.modulesOrGuardsAdjustment` |
| Native route-family pricing | Excluded by design — `capSemantics` already prices it (anti-double-counting) |
| Bridge capabilities | Route-scoped Bridge Risk controls in V9 Economic Control |
| `authorityPosture` | Validated annotation only; `npx tsx scripts/maintenance/generate-safety-score-v9-mint-posture-queue.ts --replay <path> --output <path>` |

See [report-cards.md](./report-cards.md) for the live methodology. DDR uses the derived published mint posture from version `4.5`, retaining this curated annotation as its unavailable-publication fallback. Both `none-resolved` scopes reject unknown direct mint ability: unresolved authority is not evidence of absence; known upgrade-only and parameter-only controls remain permissible in the mint-scoped variant.

## Current V9 scope

Since Safety methodology `9.23`, the live V9 mint component assesses native issuance on the canonical deployment(s) and controls that can expand, relax, or replace that issuance. Bridge Risk separately assesses representations and cross-chain machinery, including bridge mint/burn, adapters, lockboxes or escrow, messaging, limits, upgrades, and administrators. The same controller can appear in both domains for different powers, but a bridge capability never compiles as global Mint Authority risk.

Mint controls and mutable mint-logic upgrade paths on active multi-deployment assets are bound to reviewed native deployments. Structured bridge controls compile once per referenced route; when structured evidence is absent, conservative route-derived controls remain. This corrects the USDai scope bug in which satellite OToken administration had classified canonical Arbitrum issuance as `unbounded-or-compromised`; separating the evidence moved USDai from D to B. [Classification](./classification.md#mint-authority-taxonomy) owns the taxonomy boundary, and [Stablecoin Data Registry](./stablecoin-data.md#mint-authority-and-bridge-risk-ownership) owns the exact authoring and enforcement contract.

In Safety Score V10, every durable non-bridge mint path participates in worst-score selection; binding breaks score ties, rather than hiding a worse minority authority. Deployment-local adverse components and signals remain published and their known exposure is priced proportionally, while binding root/global authorities continue to set the whole-claim Control pillar. An unresolved or expired aggregate mint review cannot erase a control's own adverse evidence, and an unreviewed mint-capable path remains an `unknown` component until that path is positively reviewed.

Unresolved deployment pricing uses the full admitted cohort: joined unresolved deployments, unknown route supply, and unreviewed route supply not already counted in the join. Below the policy's 5% blend start it receives proportional Control pricing; from 5% to 15% the composite ceiling linearly blends the proportionally priced score toward the whole-coin control ceiling, published as `unresolved-deployment-share-band`. At 15% or above, or without admitted exact shares, the full ceiling remains; individual rows cannot relax an aggregate at or above that boundary.

### V10 exact execution scope and weighted signing

The unreleased methodology 10.0 accepts optional `executionScope` on each native or bridge control. The certificate names an exact chain-qualified controller, target deployments and entrypoints, actual capabilities and economic semantics, affected liabilities, activation, review/observation/expiry dates, independent reviewer and sources. `pin` and `observedState` bind runtime/build and signer identities; changes invalidate the certificate. Complete inventory requires every closure flag (entrypoints, mutable targets, delegate/fallback execution, permissions, upgrades, bypasses and liability inventory). Partial, future, expired or mismatched reviews retain the unresolved remainder and cannot exclude another authority on the same deployment.

Partial execution inventories and weighted-quorum facts do not create new authority-resolution requirements: legacy-equivalent controls retain their existing grading, nonbinding inventory treatment and conservative stale-route fallback. Partial scopes publish diagnostics and add newly verified adverse reach, but unknown or unsearched closure is not a new score charge. Only admitted complete, closure-proven execution scopes may narrow capabilities, exclude paths, waive module presence, or replace the legacy inventory policy; those inventories retain stale or uncertified siblings so favorable proof cannot erase another authority. Existing issuer non-disclosure charges remain. Mint-control canonical keys preserve the authored permission identity (including label and deployment references), so two permissions held by the same controller and role cannot collapse into one row. Native/representation reclassification requires an admitted reviewed economic-supply plan; legacy route inventories retain their reviewed native classification.

A fresh `mintAuthority.review.scopedQuestions` entry naming a controller whose admitted partial execution scope records an active mint path with unknown reach or economic-loss scope keeps that controller `bounded-unknown` under the existing `scoped-control-question` / 69 `control-scoped-gap` treatment, even when the aggregate review is `scoreable` with no aggregate unresolved questions, unless another reviewed reachable mint path on that controller independently establishes global-claim economic reach with unbounded cap or claim impairment. Such an established adverse path retains its economic scope, evaluated mint posture and centralized-mint structural failure; adding an unknown-reach path cannot soften it. Without that adverse proof, the compiler retains verified unbounded caps and claim impairment, but does not replace the investigated unknown with global-claim reach or infer incident absence. Verified siblings stay known. This structural check does not interpret the question's prose: a custody-only question with verified reach adds no new charge, and generic partial inventories without a fresh scoped question and complete closure-proven scopes keep their existing treatment.

`active`, `counterfactual` and `disabled-reactivatable` paths remain reachable. A counterfactual Safe needs its same-chain factory/build, CREATE2 address/salt, fixed full initialization, owners/threshold/modules/handler and account-state pin; no runtime code does not mean EOA or renunciation. Only execution-complete `disabled-final` proof removes that specific issuance action. Re-enable, grant and upgrade paths, outstanding receipt liabilities, freeze/exit powers and other failure domains remain. CCIP shutdown never means ordinary ERC20 transfers are prohibited. Chain-local execution does not bound root issuance economically: local sizing still requires the independently admitted complete liability partition.

A `disabled-final` label in partial execution evidence cannot remove established issuance economics: positively known liability reach and adverse semantics persist until current execution-complete closure proves that action removed. Unknown activation or reach cannot establish adverse promotion.

Safe extensions retain the coarse `modulesOrGuards` inventory fact. A fresh controller/runtime/signer-bound review can establish `relevant` module impact from a runtime-identified extension's exact `pathRefs` and positively proven reachable liability path, even when the inventory, source/runtime correspondence census or mutable-target closure is incomplete. Unknown reach, unknown activation and unsearched closure cannot establish that positive proof or create a new score charge. Only a fresh exhaustive module/guard/module-guard/fallback-handler census with pagination end, exact executable correspondence and execution-complete noninterference removes the **presence penalty**. It grants no absence, quorum, human-independence or custody credit. One relevant or unresolved extension restores the existing presence penalty; acknowledging a proven relevant path does not add a second penalty or imply arbitrary minting, exfiltration or quantified loss. Module purpose labels and constants alone cannot prove exclusion.

`weightedQuorum` is mutually exclusive with uniform `threshold`/`signerCount`; it names unique positive-weight signers, an attainable quorum, scheme, exact controller deployment, executable/signing identity and dated evidence. The compiler derives total weight and minimum cryptographic signatures by descending-weight accumulation. XRPL additionally requires observed master-key and RegularKey disposition; either live alternative is one signature and unknown alternatives block known relief. Weighted paths use only the existing single-, two-, or three-plus-signature penalty, never majority/four-plus credit or inferred independent humans. Known one-signature weighted paths project single-entity governance. Issuer nondisclosure, liability reconciliation and key custody keep their independent charges.

Native XRPL issued-currency contracts use `amountEncoding: {kind: "xrpl-issued-currency"}` and `decimals: null`. Issuer/currency plus the quoted decimal value normalize losslessly to a signed 16-digit coefficient and exponent under `semantic.control.exactScope.issuedCurrencyAmount`; zero is canonical, overprecision/out-of-range values are rejected without rounding. Fixed raw-integer readers do not scale this branch or substitute 6/18 decimals. This introduces no XRPL supply source, supply override or automatic favorable curation.

### Reviewed absence is a fact, not a gap (`9.24`)

`9.23` bound the two domains but compiled three reviewed answers as missing evidence, collapsing the Economic Control pillar to its neutral default and withholding otherwise rateable assets. `9.24` reads each as the measured fact it is:

- **No bridge.** An inventory whose every reviewed route is native issuance is not bridge-exposed, even where structured controls govern those canonical deployments — such a control administers the canonical liability, not a representation. It scores `single-chain-or-native` rather than the `opaque-or-unknown` fallback. A reviewed representation route keeps Bridge Risk applicable even when no control compiled for it, and an unresolved zero-share deployment stays an audit fact rather than proof of no bridge.
- **Incomplete bridge materiality.** A bridge review that could not attribute all supply keeps the routes it did review when the unattributed share sits below the deployment materiality threshold, or when a known supply review selected no bridge route at all. A material residual, an unmeasured share, and a supply review that is not itself a known fact all keep the previous discard. Each route still fails closed individually, so an inventory whose rows are all unresolved reaches the unverified fallback regardless.
- **No local issuance.** A reviewed `mintAuthority.review.noLocalIssuance` exception scores the mint component `none-resolved` only when the displaced risk is carried elsewhere: an `inherited-parent-issuance` claim must compile a serial-claim dependency edge to its named parent, and an `external-only-representation` must carry the reviewed route inventory that already has to cover every authored deployment. Any authored control keeps the mint review in force so no reviewed upgrade authority is dropped from the grade. Absence is never inferred.

An inherited claim is curated as a wrapper reserve slice naming the parent, not as a copy of the parent's collateral composition; the copy both double-counts the parent's exposure and leaves no edge for the parent's mint risk to travel along.

### A reviewer-scoped open question is limited evidence (`9.27`)

`mintAuthority.review.scopedQuestions` records an open question a reviewer investigated and could not close, scoped to exactly one control named by `chain:address` or by its label, with the question text, its own `reviewedAt`, `reviewer`, and sources. While that review date sits inside a 90-day freshness window, the named control's gap publishes `scoped-control-question` and takes the 69 `control-scoped-gap` ceiling instead of the 55 `control-unverified` ceiling — an investigated, dated, bounded unknown is limited evidence, not absent evidence. Past the window the gap reverts to the hard ceiling, so a named gap cannot become a permanent softener; the row stays in the `DEPLOYMENT_CONTROLS` curation queue either way. A scoped question softens only the control it names: the whole-asset inventory reason softens only when every unresolved control carries a fresh scoped question, and the legacy all-or-nothing `unresolvedQuestions` list keeps its existing semantics. Deployment-scoped controls with a null supply share also gain a materiality release in `9.27`: when the supply partition is complete and reconciled, the deployment's measured rows bound the share — zero when no row exists for it — and a proven sub-threshold bound stops binding the ceiling; a missing or unreconciled partition keeps the fail-closed treatment, and global-claim controls are never released by materiality.

Since `9.28` the same contract covers structured bridge controls via `bridgeRouteRisk.scopedQuestions`, with `controlRef` naming the control by `id`, exact label, or `controllerChain:controllerAddress`. Because the compiled bridge fact is the route-level merge of its structured controls, the merged overlay inherits the softening only when every unresolved contributor on that route is named by a fresh question — one unnamed unresolved sibling keeps the hard treatment. Conservative route-derived fallback controls, which have no reviewer behind them, never take a scoped question.

Since `9.3` the live mint component's top rung is 100: a derived `none-resolved` posture states that no reviewed control can mint, authorize minting, or expand issuance on this component's scope, so the component scores its proven maximum instead of reserving five unreachable points. The motivating LUSD/BOLD case proves the absence outright on immutable, owner-renounced deployments. The oracle and bridge tier tables are independent calibrations and keep their existing values.

V10 reviewed `opaque-or-unknown` oracle topology is bounded issuer non-disclosure: oracle quality remains 45 with `oracle-topology-undisclosed` (ceiling 55), not measured adversity or a critical `weak-oracle-branch`, common-mode or wrapper-NAV adverse signal. `single-source-or-laggy` retains high risk/cap 59; verified unsafe topology and measured privileged/manual pricing retain their treatment. PHT's verified owner-set manual feed is `single-source-or-laggy`. Public coverage and API expose the new reason and route it to oracle-profile curation, retaining issuer ownership.

### Mint posture derivation and quality ladder (`9.32`)

The live mint component derives its posture from reviewed control facts in a fixed order. An active mint incident first pins `compromised`. A missing control derives `none-resolved` when the reviewed mechanism qualifies as immutable, and otherwise stays `unknown`; unknown economic-loss scope also stays `unknown`. For economically unbounded cap semantics or claim impairment, continuous or periodic reconciliation with prudential or attestation-only supervision first derives graded `unbounded-reconciled`; otherwise qualifying [governed issuance](#governed-unbounded-issuance-1002) derives `unbounded-governed`. Remaining continuous or periodic reconciliation, or prudential supervision alone, derives base `unbounded-reconciled`; `unknown` or `internal-ledger` reconciliation derives `unbounded-reconciliation-unknown`; and a confirmed `none` or `not-applicable` answer without prudential supervision derives `unbounded-unreconciled`. Outside that unbounded branch, an unknown cap or claim-impairment fact stays `unknown`. A reviewed absence of claim impairment then derives `none-resolved` before cap grading. After that check, verified `collateral-gated` semantics derive the collateral-gated rung, followed by raiseable or periodic controls, bounded controls, and finally concentrated administration.

These are posture qualities before quorum, custody, module, incident-decay, and other merged mint signals:

| Derived posture or grading | Quality | Public band |
| --- | ---: | --- |
| `none-resolved` | 100 | Hardened |
| `bounded-admin` | 85 | Hardened |
| Prudentially reconciled | 80 | Managed / Concentrated |
| `partially-bounded-admin` or attestation-only reconciled | 70 | Governed / Managed / Concentrated |
| `unbounded-governed` | 60 | Governed |
| `concentrated-admin` | 55 | Concentrated |
| `unbounded-reconciled` (base) | 55 | Managed |
| `collateral-gated` | 50 | Concentrated |
| `unknown` | 50 | NR |
| `unbounded-reconciliation-unknown` | 55 | Exposed |
| `unbounded-unreconciled` or `compromised` | 25 | Exposed |

The published band is derived from the posture, never from the graded quality. The prudential and attestation-only gradings apply only where the review recorded a `continuous` or `periodic` reconciliation, to an `unbounded-reconciled` or a `concentrated-admin` posture; an `unbounded-reconciled` posture reached through prudential supervision alone - reconciliation `none`, `not-applicable`, or `unknown` - keeps the base 55 rung. An 80 or a 70 therefore publishes under whichever of those two bands its posture carries.

The reconciliation vocabulary records what the reviewer established, not interchangeable empty states:

| Value | Meaning |
| --- | --- |
| `continuous` | Supply and backing are reconciled continuously. |
| `periodic` | Reconciliation occurs on a reviewed recurring cadence. |
| `internal-ledger` | The issuer discloses an internal mint/ledger reconciliation process, without establishing a continuous or periodic supply-to-reserve reconciliation cadence or independent financial assurance. |
| `none` | The reviewer positively established that no reconciliation regime exists. |
| `not-applicable` | The reviewer established that reconciliation cadence does not apply to this mechanism; it is not an unknown answer. |
| `unknown` | The review did not establish whether a reconciliation regime exists. |

For an unbounded path that does not qualify as governed, `unknown` reconciliation receives the 55 reconciliation-unverified rung, above the generic unreviewed-control quality of 50 and the confirmed 25 floor. `none` and `not-applicable` take the confirmed floor unless prudential supervision independently qualifies the path as reconciled.

V10 keeps disclosed internal mint reconciliation separate from independent reserve-to-total-liability assurance. `internal-ledger` clears only the issuer-backend `mint-control-question` for reconciliation, across the native mint paths covered by that issuer-level review; it grants neither the 80/70 reconciled grading nor seasoned reconciliation credit. Without qualifying governed issuance or prudential supervision an unbounded path retains the 55 reconciliation-unverified rung; with prudential supervision alone it retains the base 55 reconciled rung. Active compromise and signer/custody risks remain independently charged, and Backing retains financial-assurance non-disclosure. Quantoz EURQ and USDQ use this value for the NEXUS process disclosed in their 30 April 2026 whitepapers, not an inferred cadence or ISAE 3402 reserve attestation.

The curated authoring field is `mintAuthority.economicCapSemantics`, whose vocabulary is `unbounded`, `collateral-gated`, `raiseable`, `bounded`, and `unknown`; the compiled control fact the derivation reads, `capSemantics.kind`, adds `not-applicable` for a control with no mint capability, which is the fall-through graded as concentrated administration. `collateral-gated` is curator-asserted with sources: every live mint path must require collateral by construction and reviewed authorization/raise powers must admit only collateral- or deposit-backed minting. `raiseable` records a numeric bound an administrator can change; `bounded` records a bound that cannot be raised through a live privileged path. Neither a current numeric ceiling nor an execution delay disproves economically `unbounded` power: D14 asks whether any root can cause durable unbacked supply to reach a chosen recipient. When bounded construction cannot be verified, use `unknown`, not an unproved favorable cap value or an unproved adverse fact, and author the posture derived from the compiler's existing encoding.

Seasoned credit remains 10 points after at least 60 months. The existing reconciled-posture path is unchanged. `unbounded-governed` uses the ordinary ladder, with a ceiling one point below the next rung (69); adding its 60 rung clips both seasoned and positive merged-signal credits on 55-base rows at 59. `unbounded-unreconciled` and `unbounded-reconciliation-unknown` remain eligible without a reconciliation requirement. The unreconciled adverse floor keeps its dedicated ceiling of 39; reconciliation-unknown keeps its existing treatment and is not added as a ladder boundary. `compromised` is never eligible, and resolved-incident decay caps still apply after seasoning.

### Governed unbounded issuance (`10.02`)

**D29: economic bound and actor process are separate axes.** D14 still asks only whether any root can cause durable unbacked supply to reach a recipient of its choosing. Such power is economically `unbounded`, including when exercised by governance; numeric adjustable ceilings do not make it bounded. D29 derives `unbounded-governed` only when that unbounded power is held exclusively by delayed, flash-resistant on-chain token governance. Every gate must be positively established from pinned evidence; an unknown fails the rung.

- **G1 — Sole governor-rooted unbounded power.** Every reachable unbounded issuance path must belong to the referenced governor itself or to a governor-rooted authored `authorityType: "contract"` executor. For that executor, case-fold the admitted complete `executionScope.pin.signerIdentity` and extract every standalone `0x[0-9a-f]{40}` address token, delimited by non-hex characters. The token set must contain the governor address; every other token must identify another authored `authorityType: "contract"` control in the same profile, an execution hop itself subject to coverage and rooting. The identity must contain no threshold/multisig phrasing: numeric forms matching `/\b\d+\s*(?:of|\/|-of-)\s*\d+\b/`, `safe`, `multisig`, `threshold`, `signer`, or `owner(s)` as a party list. A raw substring match is insufficient. The governor's own paths are rooted by identity; anything else goes into `nonGovernorUnboundedPathKeys` (fail-closed). A Safe, EOA, multisig, council, timelock control, issuer backend, custodian, validator quorum, bridge, or second governor cannot qualify as that executor merely by forwarding through a delay. Author every party able to authorize, raise, upgrade, or bypass this power.
- **Admissible non-unbounded actors.** Delegated stock with bounded/raiseable/collateral-gated caps and non-unbounded impairment may coexist and adds no delay requirement, but still needs complete scope certification. A non-governor actor is admissible without governor rooting only when none of its complete-scope paths is an unbounded issuance path. Restriction-only controls can carry parameter-change paths with bounded/none impairment, such as monetary policy or fees; those paths do not themselves disqualify, but any unbounded issuance path does, regardless of capability. Signer custody, such as an EIP-7702 owner, is identity evidence, not an execution path.
- **G2 — Enforced public delay and flash-resistant votes.** The compiled minimum unavoidable delay from public calldata visibility to earliest execution must be at least the policy's `minUnavoidableDelaySec` (172800 seconds). It is the **minimum**, never the sum, of certified `unavoidableDelaySec` across every reachable unbounded issuance path on every covered control. Overlapping clocks are not added. Any such path with a null delay, or an inventory with no such path, produces null and fails. Voting power must be `lock-escrowed` or `past-block-checkpoint`, not power acquired and cast in one transaction; `live-balance` and `unknown` fail. Restriction-only and delegated non-unbounded paths add no delay requirement.
- **G3 — Enumerable issuance.** `governedIssuance.enumerability` must carry non-empty `authorizationEvents` and `capacityReads`, identifying observable authority changes and readable issuance capacity.
- **G4 — Closed, fresh inventory.** Every authored `mintAuthority.controls[]` entry, including parameter-only, restriction-only, delegated, and contract-minter controls, must carry an execution-scope certificate admitted as complete by `compileReviewedControlScope`. Runtime/build and signer identity, observations, freshness, and every closure flag must be certified. Prose or a reverted sample expansion call cannot substitute for that certificate. The aggregate `reviewComplete` must be true: stale review, unresolved disposition/questions, or non-known confidence fails. Any fresh scoped question on the profile or active mint incident also fails, and the governed review must be neither future-dated nor older than `V9_REVIEW_EVIDENCE_MAX_AGE_SEC`. The referenced governor must project as `governance`; with qualifying token voting power it must carry neither `weightedQuorum` nor signer `threshold`/`signerCount` (R-g, mirrored as `governor-not-governance`). Its complete scope must have a reachable path with capability `mint`, `upgrade`, or `bridge-mint`, tested without the unbounded-liability filter; otherwise coverage reports `governor-without-issuance-path`.

For this rule an **unbounded issuance path** is a reachable path in a complete scope projection whose `capSemantics.kind` or `claimImpairment` is `unbounded` or `unknown`, with **any capability**: there is no mint/upgrade/bridge-mint capability filter. `governedIssuance` requires at least one such path across the authored controls' execution scopes (R-i), and is invalid when `inheritedFrom` is set or `mintPath` is `wrapped-or-variant-inherited` (R-h). Its `governorControlRef` is EVM-only (`<chain>:<lowercase 0xaddress>`); non-EVM governors cannot express governed issuance in `10.02` and fail closed. The compiled `issuanceGovernance` fact is computed once per asset and stamped identically on every emitted mint control row, including per-path rows. No authored `governedIssuance` block means no such fact.

Coverage fails closed with sorted, unique `incompleteReasons`: `review-incomplete`, `scoped-question-open`, `active-incident`, `governed-review-expired`, `governor-control-missing`, `governor-not-governance`, `control-scope-incomplete:<label>`, and `governor-without-issuance-path`. Qualification additionally requires complete coverage, no incomplete reason, no `nonGovernorUnboundedPathKeys` (`<controlLabel>:<pathId>`), the non-null minimum delay meeting policy, admissible voting power, and `enumerable: true`. Missing any condition preserves the ordinary fallback posture; a curated label cannot grant the rung.

Precedence is graded reconciled (continuous/periodic plus prudential/attestation-only supervision) → governed → base reconciled → reconciliation-unknown → unreconciled. An active incident always overrides these as `compromised`. The governed base quality is 60, its public band is **Governed**, and its `centralized-mint` signal is **low**: "Minting is economically unbounded but held only by delayed on-chain governance." It receives ordinary seasoning; the new ladder boundary caps both seasoned and positive merged-signal credits on 55-base rows at 59. The Governed band describes "A partially bounded administrator, or unbounded issuance held only by delayed on-chain token governance." It is not proof of an economic bound: governed issuance remains in DDR's fragile and unbounded sets, relaxing no verdict.

The vocabulary now separates `compromised` (active incident; quality 25; critical signal "Minting authority is under an active incident."; no seasoning) from `unbounded-unreconciled` (quality 25; high signal "Economically effective minting is unbounded and unreconciled."; adverse seasoning ceiling 39). Both publish **Exposed**, whose copy is "Economically effective minting is unbounded — unreconciled, unverified, or under an active incident." Historical retired-lane classifications remain historical.

**D14 anti-drift authoring.** A profile retaining `economicCapSemantics: "raiseable"`, `"bounded"`, or `"collateral-gated"` must carry a sourced `capSemanticsReview` when any authored control has `directMintAbility: "direct"` or `"can-authorize"`, or `canRaiseCap: true` regardless of `directMintAbility` (R-c). The verdict must be `raiseable-collateral-only` for raiseable semantics, or `bounded-by-construction` for bounded/collateral-gated semantics, proving the authorization/raise power admits only collateral- or deposit-backed minting. Proven arbitrary-recipient unbacked minting requires `unbounded` and the derived-consistent posture. If bounded construction cannot be verified from verified source or bytecode-matched artifacts, set semantics to `unknown`, omit `capSemanticsReview`, and record the gap; never keep an unproved favorable value or assert an unproved adverse fact. The compiler's conservative control encoding determines the fallback posture (direct/can-authorize encodes an unbounded branch); correct stale control fields only from evidence. `capSemanticsReview` is forbidden for `unbounded` or `unknown` semantics; upgrade authority alone does not add a new D14 review trigger. Collateral/basket admission or price-provider/oracle changes alone are Backing/oracle powers, not arbitrary-mint triggers. Deposit/collateral-only construction retains its cap semantics with the matching sourced review naming those governance parameter powers. The [registry authoring contract](./stablecoin-data.md#governed-issuance-and-cap-semantics-review) owns the exact fields and validation rules.

For wrappers with `inheritedFrom`, D14 examines the wrapper's own token/share minting. Inherited issuer controls represent parent issuance already carried by the serial-claim dependency (D08: never charge parent risk twice). Keep the current wrapper cap semantics with the matching sourced `capSemanticsReview` when verified source establishes deposit/collateral-only wrapper minting and no local role can mint without a deposit or authorize such a minter. Its rationale identifies the parent controls/dependency and proves the deposit-only construction. A wrapper becomes `unbounded` only for a proven wrapper-local privileged mint path.

### The external validator-quorum authority rung (`9.46`)

The compiled authority model is derived from the authored `authorityType` on a mint or bridge control, and until `9.46` it had no value for a controlling party that is a rotating external validator population rather than a key holder. A LayerZero DVN set, a Chainlink CCIP DON/RMN, a Bantu AMTP validator group and an IBC light-client validator set are all public, documented and citable, but none of them has a single controller address, so a reviewer who recorded the quorum with its failure domains and its sources still compiled to `unknown`. Because the compiled bridge fact is the route-level merge of its structured controls and that merge keeps the *weakest* covering authority, one such control set every route it referenced to `unknown` and published an unresolved-control gap owned by the issuer for a fact the issuer had in fact published.

`validator-quorum` names that party. It is known but weak, and the ruling behind it is explicit: it grades at or below a named issuer backend and never above a named multisig, because an anonymous rotating quorum is not stronger than a 3-of-5 Safe. Concretely, on the control-quality ladder above it holds the `unknown` rung's 45, exactly where `issuer-backend` sits and strictly below the `concentrated-admin` 55 a multisig grades from, so naming a validation domain can never lift a control into the multisig class. On the route-level weakest-authority merge it ranks below `issuer-backend` and above `eoa`: a route co-controlled by an unattested single key still reports that key as its weakest link, while a route co-controlled by a Safe reports the quorum. Curate it only where the controlling party genuinely is the validation domain; a named operator behind that domain is still that operator.

`9.46` also closes a fall-through in the same mappers. `bridge` and `custodian` are authored `authorityType` values that had no branch and silently produced `unknown`. `bridge` now compiles to `contract`, the treatment `timelock` already takes, because bridge machinery is a contract-scoped authority; `custodian` compiles to `issuer-backend`, the grouping the issuer authority-key derivation already applied to it. Both mappers — the mint-authority one and the bridge one — carry the identical ladder, so one authored `authorityType` cannot compile to two different authority models depending on which review carries it.

The historical description follows.

## Methodology Versioning

- **Current methodology version:** <!-- GENERATED-START: methodology-version-mint-authority -->`v1.3`<!-- GENERATED-END: methodology-version-mint-authority --> (terminal — lane closed)
- **Runtime/version source:** `shared/lib/methodology-versions/mint-authority.ts`
- **Structured changelog:** `shared/data/methodology-changelogs/mint-authority/`
- **Scoring source:** none — the retired engine module was deleted with the lane; the live mint component lives in `shared/lib/safety-score-v9/control.ts`
- **Public methodology anchor:** `/methodology/#mint-authority-score`

## Historical purpose

Mint Authority Score measures how much durable stablecoin supply can be created, authorized, expanded, or routed by privileged actors. It focuses on the mint path itself: issuer minters, allowlisted minters, cap admins, proxy admins, facilitators, bridges, off-chain attestation systems, backend signers, governance, Safes/multisigs, custodians, and wrapper inheritance.

Mint Authority Score began as a display and review-coverage methodology. From Safety `8.0`, it also fed the retired V8 Decentralization dimension through a 35% penalty-only blend. Safety `9.1` removed that separate engine and now evaluates the underlying facts once inside the Economic Control pillar; the sections below describe the retired v1.2 formula as shipped.

## Inputs

Historical scores were derived from curated `mintAuthority` metadata now authored in `shared/data/stablecoins/domains/mint-authority/<id>.json` and merged into runtime projections. Missing or unresolved data returns `NR`; it never implies that mint authority is safe.

Primary fields:

- `mintPath` - route family, such as immutable user collateral, permissioned minter, issuer direct mint, bridge/OFT synthetic, M0 minter, or inherited wrapper.
- `authorityPosture` - reviewed posture band: none resolved (whole-of-chain), none resolved mint (mint-scoped), bounded admin, partially bounded admin, unbounded reconciled, concentrated admin, collateral gated, unbounded reconciliation unknown, unbounded or compromised, or unknown.
- `confidence` - evidence quality: verified, probable, manual-review, or unknown.
- `controls[]` - mint-capable or mint-adjacent control paths, including role, authority type, direct mint ability, threshold, signer count, timelock, cap status, cap-mutability evidence, Safe module/guard state, key-custody attestation, sources, and evidence.
- `inheritedFrom` - parent stablecoin id for wrappers and variants that inherit mint authority from a reviewed parent.
- `mintIncidents` - historical unbacked-mint or privileged-mint exploit evidence (one entry per incident) used for the hard incident cap.

## Formula

For direct reviewed profiles, Pharos computes four components and combines them as:

```text
rawScore = round(
  route * 0.30 +
  controller * 0.40 +
  bounds * 0.15 +
  posture * 0.15
)
```

| Component  | Weight | Meaning                                                                                                                                                          |
| ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route      | 30%    | Structural mint route family. Immutable user/protocol minting scores highest; bridge, off-chain attested, and issuer-direct routes score lower.                  |
| Controller | 40%    | Weakest mint-capable controller. Single-key, backend, bridge, custodian, Safe/multisig, timelock, DAO, and contract controls are scored by weakest active route. |
| Bounds     | 15%    | Whether mint-capable paths are quantitatively bounded and whether caps can be raised.                                                                            |
| Posture    | 15%    | Curated operator posture from no privileged route through unbounded or compromised authority.                                                                    |

The controller component is weakest-link by design. If any mint-capable path can directly mint, authorize a minter, raise a cap, or upgrade mint logic, the lowest controller score among those paths constrains the component.

The bounds component treats cap-limited mint-capable controls as bounded, but the immutable-cap bonus is stricter in `v1.2`: every cap-limited mint-capable control must explicitly record `canRaiseCap: false`. Controls with `canRaiseCap: true`, `canRaiseCap: "unknown"`, or omitted cap-mutability evidence keep the capped-path score but do not receive the immutable-cap bonus.

## Caps

Caps apply after the weighted raw score:

| Cap            | Limit         | Trigger                                                                                                                                                                                                                                                                                       |
| -------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Incident cap   | 10 / 15 / 20  | `authorityPosture: "unbounded-or-compromised"` with at least one recorded entry in `mintIncidents`. The limit decays purely with the age of the most recent incident: under 2 years = 10, 2-4 years = 15, 4+ years = 20 (v1.1). Unparseable dates stay at 10. Always below the unbounded cap. |
| Unbounded cap  | 25            | Unbounded or compromised posture without a recorded incident.                                                                                                                                                                                                                                 |
| EOA cap        | 40            | Non-issuer-context EOA can directly mint or authorize minting without MPC/HSM key-custody attestation.                                                                                                                                                                                        |
| Confidence cap | 100 / 90 / 85 | Verified = 100, probable = 90, manual-review = 85. Unknown confidence returns `NR`.                                                                                                                                                                                                           |

Caps are reported in the detail-page breakdown so users can distinguish a weak raw score from a hard governance, incident, or evidence cap.

## Inheritance

Rows with `mintPath: "wrapped-or-variant-inherited"` inherit from `inheritedFrom`. If the parent is scoreable, the wrapper score is the lower of the parent score and a blend of 60% parent score plus 40% weakest wrapper-control score. This prevents a wrapper from outranking the base mint authority when the wrapper itself adds an extra weak control path.

Inheritance returns `NR` when the parent is missing, unscoreable, cyclic, or beyond the depth limit.

## Bands

| Band         | Range     | Meaning                                                                                 |
| ------------ | --------- | --------------------------------------------------------------------------------------- |
| Hardened     | 80-100    | No resolved privileged mint path or strongly bounded, high-confidence controls.         |
| Governed     | 65-79     | Governance or admin controls exist, but they are comparatively bounded or slow.         |
| Managed      | 50-64     | Active mint management exists with some controls or route limits.                       |
| Concentrated | 35-49     | A small operator, backend, custodian, bridge, or low-threshold route can affect supply. |
| Exposed      | 0-34      | Unbounded, compromised, single-key, or otherwise weak authority dominates the score.    |
| NR           | Not rated | Missing, unknown, inherited-but-unresolved, or insufficient review data.                |

## Historical Surfaces

- Stablecoin detail pages showed the retired score, band, component breakdown, weakest controller, caps, custody labels, incident callout, reviewed date, and sources when compact review data existed.
- The current homepage and `/screener/` mint columns read Safety Score V9's published mint component, not this retired engine. `/coverage/` still counts curated review breadth by route bucket.
- The `Mint Authority Status` kind (`resolveMintAuthorityStatusKind()` in `src/lib/mint-authority-display.ts`) is a label over **curated metadata** — `mintPath`, `authorityPosture`, and the reviewed `controls` list — not a re-binning of the published component score. The retired v1.x band used numeric score thresholds; the current V9 public band is derived from the published mint posture and is intentionally stable across small merged-signal score movements. Read the kind as "what route exists" and the V9 band as the posture-level control assessment.
- Safety Score V9 compiles the underlying reviewed control evidence directly into Economic Control facts (see `docs/report-cards.md`). There is no current raw `mintAuthorityScore` input from this retired lane.

## Maintenance Checklist

When adding or updating `mintAuthority` metadata:

1. Verify source links, current controls, thresholds, module/guard status, cap authority, proxy/admin reads, bridge route checks, and unresolved questions.
2. Do not publish scanner output directly. `scripts/maintenance/audit-mint-authority.ts` writes candidates under `agents/mint-authority-candidates/`; a reviewer must curate metadata by hand.
3. Use the advisory audits for review breadth and ownership: `npm run audit:mint-authority-review` for the curated review backlog and cited-source probe, and `npm run audit:mint-bridge-ownership` for authored mint/bridge domain ownership. Neither gates a merge; see [Curation Audits](./scripts.md#curation-audits).
4. Regenerate stablecoin projections and run metadata checks.
5. Run focused scoring and surface tests when score-affecting fields change.
6. Update this doc, `/methodology`, and route docs if weights, caps, bands, inheritance, or public display semantics change.
