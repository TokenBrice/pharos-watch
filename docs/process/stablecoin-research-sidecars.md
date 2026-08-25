# Stablecoin Research Sidecars

Research-heavy metadata can move independently from a coin's scalar identity and routing metadata. Sidecars reduce conflict pressure without changing the merged `StablecoinMeta` contract or any generated projection.

## Domain Ownership

| Domain         | Sidecar path                                               | Owned fields                                                                  |
| -------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Reserves       | `shared/data/stablecoins/domains/reserves/<id>.json`       | `reserves`, `reserveReview`, `custodyProfile`                                 |
| Mint authority | `shared/data/stablecoins/domains/mint-authority/<id>.json` | `mintAuthority`                                                               |
| Compliance     | `shared/data/stablecoins/domains/compliance/<id>.json`     | `mica`, `genius`                                                              |
| Risk review    | `shared/data/stablecoins/domains/risk-review/<id>.json`    | `blacklistabilityReview`, `oracleRisk`, `bridgeRouteRisk`                     |

The table mirrors `STABLECOIN_SOURCE_DOMAIN_FIELDS` in `shared/lib/stablecoins/schema.ts`, which is the enforced owner of the domain-to-field mapping; if the two disagree, the constant is right.

Sidecars are selective. Fields such as identity, flags, contracts, links, jurisdiction, classification overrides, notices, launch metadata, and other scalar catalog metadata remain in `coins/<id>.json`.

The layout migration is complete: no base coin file carries a domain-owned field. Every coin whose research a domain covers has that domain's sidecar, so a base file's absence of a domain directory entry now means the coin has no such research, not that the field is still awaiting migration. Author new research directly in the sidecar.

`reserveReview` records the human review of a reserve composition: review date and reviewer, confidence, sources, composition basis and optional as-of date, reviewed scope, known-unknown exposure, and fingerprinted dispositions for selected unlinked slices. A disposition stores the current reserve index, exact name, and percentage, so changing, resizing, or reordering a reviewed slice makes validation fail until the review is revisited. Candidate IDs are research leads only; they do not create dependency edges. The reserves sidecar may contain any of `reserves`, `reserveReview`, and `custodyProfile`, but a merged coin may only carry a review when it also has reserve composition.

Reserve slices may carry a namespace-qualified stable `sourceKey` plus review-useful structured backing facts: `assetClass`, `issuerOrObligor`, `riskFactors`, `liquidityHorizon`, and `maturityDaysMax`. These supplement the existing risk, dependency-link, and blacklistability fields. A source key identifies an adapter-owned upstream category and must match the live adapter/config output; it must not encode the row's percentage or mutable display label. A keyed live row fails closed when its reviewed key is absent, different, or duplicated; historical unkeyed live captures retain the unique-name compatibility path. Do not infer a maturity maximum from weighted-average maturity, preserve false precision in an opaque basket, or assign issuer/custodian shares that the source does not disclose.

`custodyProfile` is the reviewed evidence behind the current `custodyModel` summary. It records named providers and their roles, optional sourced shares and jurisdictions, segregation, bankruptcy remoteness, rehypothecation, provenance, and explicit uncertainty. Unknown safeguards stay `unknown`; a provider share is omitted rather than estimated. The reserve coverage audit reports advisory inconsistencies between this profile and `custodyModel`, but does not automatically replace the v8 summary tier.

`proofOfReserves.latestReport` remains inside the base `proofOfReserves` object because proof configuration was already base-owned. A latest report records period end, publication date, assurance method, assets-only versus assets-and-liabilities scope, liability reconciliation, and review provenance. An `independent-audit` label without a verifiable current report remains valid metadata but is surfaced in the audit backfill queue.

`dependencyReview` remains base metadata. It is required only for authored `dependencies` relationships that are not already represented by a linked reserve slice. When present, its relationship list must exactly cover those manual-only edges plus the implicit `variantOf` wrapper edge, including an explicit dependency type; a wrapper-only review that documents just the `variantOf` edge is valid. Reserve-derived dependencies use the reserve composition and `reserveReview` provenance instead of duplicating evidence per edge.

Once a coin has a sidecar for a domain, all fields owned by that domain must stay out of its base file. This keeps the evidence and its coupled decision fields together. `blacklistabilityReview.reviewedStatus` is the sole authored freeze/blacklist verdict.

Research review envelopes, including `reserveReview` and `custodyProfile`, remain server/repository evidence and are intentionally omitted from `coins.client.generated.json`. Structured reserve-slice facts travel with the already client-visible `reserves` field. The global client registry does not project `proofOfReserves`, so `latestReport` remains on full/server paths. The full generated registry retains all P5 evidence for audits and report-card compilation.

`bridgeRouteRisk.routes` and `bridgeRouteRisk.controls` belong to the risk-review domain. Each route row joins an exact authored `contracts` chain/address pair through its normalized `chain:contractAddress` ID and records route class, issuance model, transfer semantics, scope, controllers, failure-domain keys, and an observation point. Active assets with multiple deployments require complete route rows. Each structured bridge control references one or more route IDs and records the bridge capabilities, controller, failure domains, Safe/multisig facts, limits, observation point, and evidence that apply to those routes. A reviewed `bridge-representation` or `wrapped-representation` route referenced by structured controls must have a covering `bridge-mint` capability; if the minter cannot be identified, omit the route from every structured control's `routeRefs` so the conservative route-derived fallback remains scoreable; otherwise the ownership gate reports `representation-route-without-bridge-mint`. Safety Score V9 compiles a structured control separately for each referenced route; when structured control evidence is absent, the compiler retains conservative route-derived controls.

`mintAuthority` remains mint-authority-domain evidence for native issuance only. Controls may record canonical deployment references, observation points, and reviewed failure-domain keys; mutable `upgradeability` records the native deployments it can replace, proxy model, implementation/admin path, delay, and the exact control that can change mint logic. Incidents have explicit `active` or `resolved` state, with `resolvedAt` only for resolved incidents. A deliberately unscoreable review uses `review.disposition: "unresolved"` and retains its unresolved questions instead of being mistaken for an accidental coverage gap. Shared controller analysis joins normalized onchain addresses and reviewed failure-domain keys across mint, upgrade, bridge, and oracle paths without merging their capabilities.

The Safety Score V9 cross-domain incident registry is deliberately outside the sidecar split. `shared/data/safety-score-v9/incident-reviews-v1.json` stores reviewed events that need a typed control, wrapper-local, operational, or peg destination and an explicit root-claim, deployment, integration-only, or holder-exit scope. The compiler routes each record into the existing domain fact and applies the worst applicable posture once; it does not create a generic incident dimension. Continue to use domain-native sidecar fields, including `mintAuthority.mintIncidents`, when they already express the event, and never duplicate one incident across both sources.

### Deciding which sidecar owns a control

Ask what capability the control exercises, not where the controller is deployed or whether the same Safe appears elsewhere:

- Put it in Mint Authority when it can create native liabilities on a canonical deployment or expand, relax, or replace that deployment's issuance constraints.
- Put it in Bridge Risk when it governs a representation or transfer rail: bridge mint/burn, an adapter, lockbox or escrow, messaging/peers, validators, limits, pause, bridge upgrade, or bridge administration. A canonical-chain adapter is still Bridge Risk.
- Split a mixed controller into both modules when evidence proves distinct native-mint and bridge capabilities. Preserve its shared identity and adverse facts, but do not author the same bridge capability twice.
- Do not move blacklist, seizure, oracle, reserve, custody, redemption, or unrelated pause facts merely because their administrator is shared; those remain with their existing domain owner.

USDai is the reference boundary correction. Its Arbitrum deployment creates the canonical liability, so the canonical minter and mint-logic upgrade path remain in Mint Authority with only the Arbitrum deployment ID. Ethereum and other satellite OTokens are bridge representations: their `DEFAULT_ADMIN` and `BRIDGE_ADMIN` exposure remains adverse evidence, but belongs in route-scoped Bridge Risk controls. Treating those satellite powers as global mint authority had classified canonical USDai issuance as `unbounded-or-compromised`; separating the domains moved the reviewed Safety Score from D to B. See [Stablecoin Data Registry](../stablecoin-data.md#mint-authority-and-bridge-risk-ownership) for the exact fields and enforcement rules.

## Updating Research

1. Check whether `domains/<domain>/<id>.json` exists.
2. If it exists, edit the sidecar. Do not copy its fields back into `coins/<id>.json`.
3. If it does not exist, create it. Do not author domain-owned fields in the base file; the migration below exists for legacy layouts, not for new research.
4. Preserve existing evidence and values unless the task includes reviewed research. A layout migration must not invent or refresh facts.
5. Run focused schema/loader tests before regenerating artifacts.

Sidecars use strict schemas. Unknown keys, a sidecar ID that differs from its filename/base ID, orphan sidecars, unsupported domain directories, and any base/sidecar domain split are errors.

## Migration Workflow

The catalog migration is complete; new research goes directly into the owning sidecar. If an old branch or malformed source reintroduces domain-owned fields into a base coin file, use `scripts/maintenance/migrate-stablecoin-sidecar.ts --help` and preview with `--dry-run` before applying. The tool moves only authored fields and refuses the write unless the complete merged projection, including other domain sidecars and cross-domain refinements, remains deeply equal.

## Coordinated Generation

In parallel work, finish all base/sidecar moves before regenerating shared projections. Record hashes or retain an in-memory snapshot of the generated projections before a layout-only batch, then regenerate once:

```bash
npx tsx scripts/maintenance/generate-stablecoin-per-coin-asset.ts
node scripts/build-data/build-client-registry.mjs
npx tsx scripts/maintenance/generate-report-card-registry-fingerprint.ts
node --import tsx scripts/maintenance/generate-legacy-stablecoin-redirects.ts
```

For a layout-only move, the full, client, compliance, Telegram Mini App, report-card fingerprint, and legacy-redirect artifacts must remain byte-identical. If they change, stop and inspect the projection before proceeding.

Validation:

```bash
npm run check:stablecoin-data
npm run check:generated-artifacts
npm run typecheck
npm run typecheck:worker
```
