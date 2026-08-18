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

`mintAuthority.review.scopedQuestions` records an open question a reviewer investigated and could not close, scoped to exactly one control named by `chain:address` or by its label, with the question text, its own `reviewedAt`, `reviewer`, and sources. While that review date sits inside a 90-day freshness window, the named control's gap publishes `scoped-control-question` and takes the 69 `control-scoped-gap` ceiling instead of the 55 `control-unverified` ceiling — an investigated, dated, bounded unknown is limited evidence, not absent evidence. Past the window the gap reverts to the hard ceiling, so a named gap cannot become a permanent softener; the row stays in the `DEPLOYMENT_CONTROLS` curation queue either way. A scoped question softens only the control it names: the whole-asset inventory reason softens only when every unresolved control carries a fresh scoped question, and the legacy all-or-nothing `unresolvedQuestions` list keeps its existing semantics. Deployment-scoped controls with a null supply share also gain a materiality release in `9.27`: when the supply partition is complete and reconciled, the deployment's measured rows bound the share and a proven sub-threshold bound stops binding the ceiling; global-claim controls are never released by materiality.

Since `9.28` the same contract covers structured bridge controls via `bridgeRouteRisk.scopedQuestions`, with `controlRef` naming the control by `id`, exact label, or `controllerChain:controllerAddress`. Because the compiled bridge fact is the route-level merge of its structured controls, the merged overlay inherits the softening only when every unresolved contributor on that route is named by a fresh question — one unnamed unresolved sibling keeps the hard treatment. Conservative route-derived fallback controls, which have no reviewer behind them, never take a scoped question.

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
- `authorityPosture` - reviewed posture band: none resolved (whole-of-chain), none resolved mint (mint-scoped), bounded admin, partially bounded admin, unbounded reconciled, concentrated admin, unbounded or compromised, or unknown.
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
3. Regenerate stablecoin projections and run metadata checks.
4. Run focused scoring and surface tests when score-affecting fields change.
5. Update this doc, `/methodology`, and route docs if weights, caps, bands, inheritance, or public display semantics change.
