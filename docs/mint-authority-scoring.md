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
| Route-family pricing | Excluded by design — `capSemantics` already prices it (anti-double-counting) |
| `authorityPosture` | Validated annotation only; `npm run safety-score-v9:mint-posture-queue` |

See [report-cards.md](./report-cards.md) for the live methodology.

The historical description follows.

## Methodology Versioning

- **Current methodology version:** `v1.3` (terminal — lane closed)
- **Runtime/version source:** `shared/lib/methodology-versions/mint-authority.ts`
- **Structured changelog:** `shared/data/methodology-changelogs/mint-authority/`
- **Scoring source:** `shared/lib/mint-authority-scoring.ts`
- **Public methodology anchor:** `/methodology/#mint-authority-score`

## Purpose

Mint Authority Score measures how much durable stablecoin supply can be created, authorized, expanded, or routed by privileged actors. It focuses on the mint path itself: issuer minters, allowlisted minters, cap admins, proxy admins, facilitators, bridges, off-chain attestation systems, backend signers, governance, Safes/multisigs, custodians, and wrapper inheritance.

Historically Mint Authority Score was a display and review-coverage methodology that never fed the canonical Safety Score. Safety `9.1` merged its distinct signals into the Economic Control pillar and closed this lane; the sections below describe the retired v1.2 formula as shipped.

## Inputs

Scores are derived from curated `mintAuthority` metadata in `shared/data/stablecoins/coins/*.json`, projected through the slim client registry. Missing or unresolved data returns `NR`; it never implies that mint authority is safe.

Primary fields:

- `mintPath` - route family, such as immutable user collateral, permissioned minter, issuer direct mint, bridge/OFT synthetic, M0 minter, or inherited wrapper.
- `authorityPosture` - reviewed posture band: none resolved, bounded admin, partially bounded admin, concentrated admin, unbounded or compromised, or unknown.
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

## Surfaces

- Stablecoin detail pages show the score, band, component breakdown, weakest controller, caps, custody labels, incident callout, reviewed date, and sources when compact review data exists.
- The homepage table and `/screener/` show sortable Mint Score columns. `/screener/` also supports score threshold and band filters, and CSV export includes status, score, and band. Compact client projections include cap-mutability evidence needed to keep aggregate Mint Authority Scores equivalent to full metadata.
- `/coverage/` counts curated review breadth by route bucket and also exposes score-band breakdown chips.
- Safety Score V9 does not blend this display score; it compiles the underlying reviewed control evidence into Economic Control facts (see `docs/report-cards.md`). Raw inputs expose `mintAuthorityScore`.

## Maintenance Checklist

When adding or updating `mintAuthority` metadata:

1. Verify source links, current controls, thresholds, module/guard status, cap authority, proxy/admin reads, bridge route checks, and unresolved questions.
2. Do not publish scanner output directly. `scripts/maintenance/audit-mint-authority.ts` writes candidates under `agents/mint-authority-candidates/`; a reviewer must curate metadata by hand.
3. Regenerate stablecoin projections and run metadata checks.
4. Run focused scoring and surface tests when score-affecting fields change.
5. Update this doc, `/methodology`, and route docs if weights, caps, bands, inheritance, or public display semantics change.
