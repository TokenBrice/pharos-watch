# Mint Authority Score (retired lane)

**Retired at safety methodology `9.1` (2026-08-08).** Mint risk is now graded once,
by the Safety Score V9 Economic Control pillar's mint component. This document is
kept because the methodology lane still renders its history at
`/methodology/#mint-authority-score`; nothing on the site scores from it.

Where the signals went:

| Retired signal | Where it lives now |
| --- | --- |
| Incident age decay | `semantic.control.mintMergedSignals.resolvedIncidentQualityCaps` |
| MPC/HSM key custody | `semantic.control.mintMergedSignals.attestedKeyCustodyQuality` / `unattestedEoaPenalty` |
| Multisig threshold ladder | `semantic.control.mintMergedSignals.multisigQuorumAdjustment` |
| Modules/guards evidence | `semantic.control.mintMergedSignals.modulesOrGuardsAdjustment` |
| Native route-family pricing | Excluded by design — `capSemantics` already prices it (anti-double-counting) |
| Bridge capabilities | Route-scoped Bridge Risk controls in V9 Economic Control |
| `authorityPosture` | Validated annotation only; `npm run safety-score-v9:mint-posture-queue` |

See [report-cards.md](./report-cards.md) for the live methodology.

## Current V9 scope

Since Safety methodology `9.23`, the live V9 mint component assesses native issuance on the canonical deployment(s) and controls that can expand, relax, or replace that issuance. Bridge Risk separately assesses representations and cross-chain machinery, including bridge mint/burn, adapters, lockboxes or escrow, messaging, limits, upgrades, and administrators. The same controller can appear in both domains for different powers, but a bridge capability never compiles as global Mint Authority risk.

Mint controls and mutable mint-logic upgrade paths on active multi-deployment assets are bound to reviewed native deployments. Structured bridge controls compile once per referenced route; when structured evidence is absent, conservative route-derived controls remain. This corrects the USDai scope bug in which satellite OToken administration had classified canonical Arbitrum issuance as `unbounded-or-compromised`; separating the evidence moved USDai from D to B. [Classification](./classification.md#mint-authority-taxonomy) owns the taxonomy boundary, and [Stablecoin Data Registry](./stablecoin-data.md#mint-authority-and-bridge-risk-ownership) owns the exact authoring and enforcement contract.

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

### Mint posture derivation and quality ladder (`9.32`)

The live mint component derives its posture from reviewed control facts in a fixed order. An active mint incident first pins `unbounded-or-compromised`. A missing control derives `none-resolved` when no control key is authored and the reviewed mechanism is immutable with a `not-applicable` reconciliation, and otherwise stays `unknown`; an unknown cap, claim-impairment, or economic-loss fact also stays `unknown`. For economically unbounded minting, continuous or periodic reconciliation — or prudential supervision — derives `unbounded-reconciled`; an unknown reconciliation answer derives `unbounded-reconciliation-unknown`; and a confirmed `none` or `not-applicable` answer without prudential supervision derives `unbounded-or-compromised`. A reviewed absence of claim impairment derives `none-resolved` before cap grading. After that check, verified `collateral-gated` semantics derive the collateral-gated rung, followed by raiseable or periodic controls, bounded controls, and finally concentrated administration.

These are posture qualities before quorum, custody, module, incident-decay, and other merged mint signals:

| Derived posture or grading | Quality | Public band |
| --- | ---: | --- |
| `none-resolved` | 100 | Hardened |
| `bounded-admin` | 85 | Hardened |
| Prudentially reconciled | 80 | Managed / Concentrated |
| `partially-bounded-admin` or attestation-only reconciled | 70 | Governed / Managed / Concentrated |
| `concentrated-admin` | 55 | Concentrated |
| `unbounded-reconciled` (base) | 55 | Managed |
| `collateral-gated` | 50 | Concentrated |
| `unknown` | 45 | NR |
| `unbounded-reconciliation-unknown` | 35 | Exposed |
| `unbounded-or-compromised` | 25 | Exposed |

The published band is derived from the posture, never from the graded quality, and the prudential and attestation-only gradings apply to `unbounded-reconciled` and to a continuously reconciled `concentrated-admin`; an 80 or a 70 therefore publishes under whichever of those two bands its posture carries.

The reconciliation vocabulary records what the reviewer established, not interchangeable empty states:

| Value | Meaning |
| --- | --- |
| `continuous` | Supply and backing are reconciled continuously. |
| `periodic` | Reconciliation occurs on a reviewed recurring cadence. |
| `none` | The reviewer positively established that no reconciliation regime exists. |
| `not-applicable` | The reviewer established that reconciliation cadence does not apply to this mechanism; it is not an unknown answer. |
| `unknown` | The review did not establish whether a reconciliation regime exists. |

For an unbounded path, `unknown` therefore receives the intermediate 35 rung, below the unreviewed-control quality of 45 but above the confirmed 25 floor. `none` and `not-applicable` take the confirmed floor unless prudential supervision independently qualifies the path as reconciled.

The curated authoring field is `mintAuthority.economicCapSemantics`, whose vocabulary is `unbounded`, `collateral-gated`, `raiseable`, `bounded`, and `unknown`; the compiled control fact the derivation reads, `capSemantics.kind`, adds `not-applicable` for a control with no mint capability, which is the fall-through graded as concentrated administration. `collateral-gated` is curator-asserted with sources: every live mint path must require collateral by construction, no privileged party may mint arbitrarily, and every minter-authorization or mint-logic replacement or upgrade path must be absent, renounced, or behind a timelock of at least 86400 seconds. Anything weaker remains `unbounded`. `raiseable` records a numeric bound an administrator can change; `bounded` records a bound that cannot be raised through a live privileged path; `unknown` records an unresolved cap fact.

Seasoned credit remains 10 points after at least 60 months. The existing reconciled-posture path is unchanged. A non-active `unbounded-or-compromised` posture and an `unbounded-reconciliation-unknown` posture are now also eligible without a reconciliation requirement because those rungs are unreconciled by definition. The adverse floor uses a dedicated ceiling of 39, rather than the generic next-rung-minus-one result of 34 introduced by the new 35 rung. The reconciliation-unknown rung uses the ordinary ladder ceiling of 44. An active incident is never eligible, and resolved-incident decay caps still apply after seasoning.

### The external validator-quorum authority rung (`9.46`)

The compiled authority model is derived from the authored `authorityType` on a mint or bridge control, and until `9.46` it had no value for a controlling party that is a rotating external validator population rather than a key holder. A LayerZero DVN set, a Chainlink CCIP DON/RMN, a Bantu AMTP validator group and an IBC light-client validator set are all public, documented and citable, but none of them has a single controller address, so a reviewer who recorded the quorum with its failure domains and its sources still compiled to `unknown`. Because the compiled bridge fact is the route-level merge of its structured controls and that merge keeps the *weakest* covering authority, one such control set every route it referenced to `unknown` and published an unresolved-control gap owned by the issuer for a fact the issuer had in fact published.

`validator-quorum` names that party. It is known but weak, and the ruling behind it is explicit: it grades at or below a named issuer backend and never above a named multisig, because an anonymous rotating quorum is not stronger than a 3-of-5 Safe. Concretely, on the control-quality ladder above it holds the `unknown` rung's 45, exactly where `issuer-backend` sits and strictly below the `concentrated-admin` 55 a multisig grades from, so naming a validation domain can never lift a control into the multisig class. On the route-level weakest-authority merge it ranks below `issuer-backend` and above `eoa`: a route co-controlled by an unattested single key still reports that key as its weakest link, while a route co-controlled by a Safe reports the quorum. Curate it only where the controlling party genuinely is the validation domain; a named operator behind that domain is still that operator.

`9.46` also closes a fall-through in the same mappers. `bridge` and `custodian` are authored `authorityType` values that had no branch and silently produced `unknown`. `bridge` now compiles to `contract`, the treatment `timelock` already takes, because bridge machinery is a contract-scoped authority; `custodian` compiles to `issuer-backend`, the grouping the issuer authority-key derivation already applied to it. Both mappers — the mint-authority one and the bridge one — carry the identical ladder, so one authored `authorityType` cannot compile to two different authority models depending on which review carries it.

The historical description follows.

## Methodology Versioning

- **Current methodology version:** `v1.3` (terminal — lane closed)
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
