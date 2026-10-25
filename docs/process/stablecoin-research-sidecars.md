# Stablecoin Research Sidecars

Sidecars separate research from scalar identity and routing without changing `StablecoinMeta` or generated projections.

## Domain Ownership

| Domain         | Sidecar path                                               | Owned fields                                                                  |
| -------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Reserves       | `shared/data/stablecoins/domains/reserves/<id>.json`       | `reserves`, `reserveReview`, `custodyProfile`                                 |
| Mint authority | `shared/data/stablecoins/domains/mint-authority/<id>.json` | `mintAuthority`                                                               |
| Compliance     | `shared/data/stablecoins/domains/compliance/<id>.json`     | `mica`, `genius`                                                              |
| Risk review    | `shared/data/stablecoins/domains/risk-review/<id>.json`    | `blacklistabilityReview`, `oracleRisk`, `bridgeRouteRisk`                     |

The table mirrors `STABLECOIN_SOURCE_DOMAIN_FIELDS` in `shared/lib/stablecoins/schema.ts`, which is the enforced owner of the domain-to-field mapping; if the two disagree, the constant is right.

Sidecars are selective. Fields such as identity, flags, contracts, links, jurisdiction, classification overrides, notices, launch metadata, and other scalar catalog metadata remain in `coins/<id>.json`.

Migration is complete: domain-owned fields live only in sidecars. An absent sidecar means absent research. Author new research directly in its owning sidecar.

`reserveReview` records the human review of a reserve composition: review date and reviewer, confidence, sources, composition basis and optional as-of date, reviewed scope, known-unknown exposure, and fingerprinted dispositions for selected unlinked slices. A disposition stores the current reserve index, exact name, and percentage, so changing, resizing, or reordering a reviewed slice makes validation fail until the review is revisited. Candidate IDs are research leads only; they do not create dependency edges. The reserves sidecar may contain any of `reserves`, `reserveReview`, and `custodyProfile`, but a merged coin may only carry a review when it also has reserve composition.

Reserve slices may carry a namespace-qualified stable `sourceKey` plus review-useful structured backing facts: `assetClass`, `issuerOrObligor`, `riskFactors`, `liquidityHorizon`, and `maturityDaysMax`. These supplement the existing risk, dependency-link, and blacklistability fields. A source key identifies an adapter-owned upstream category and must match the live adapter/config output; it must not encode the row's percentage or mutable display label. A keyed live row fails closed when its reviewed key is absent, different, or duplicated; historical unkeyed live captures retain the unique-name compatibility path. Do not infer a maturity maximum from weighted-average maturity, preserve false precision in an opaque basket, or assign issuer/custodian shares that the source does not disclose.

`custodyProfile` is the reviewed evidence behind the current `custodyModel` summary. It records named providers and their roles, optional sourced shares and jurisdictions, segregation, bankruptcy remoteness, rehypothecation, provenance, and explicit uncertainty. Unknown safeguards stay `unknown`; a provider share is omitted rather than estimated. The reserve coverage audit reports advisory inconsistencies between this profile and `custodyModel`, but does not automatically replace the v8 summary tier.

`proofOfReserves.latestReport` remains inside the base `proofOfReserves` object and is the sole sourced report-date authority. Period end and publication date are separate, independently optional facts; never infer one from the other. A migrated date whose meaning is unproven lives in `reviewReference` with its original review date and `dateKind: "unspecified"`, without filling either date. Sources, reviewer, confidence, assurance method, scope, and reconciliation remain explicit; unknown assurance facts stay `unknown`. Compliance sidecars retain review-qualified evidence in notes and references, not a second authored latest-report date. An `independent-audit` label without a verifiable current report remains valid metadata but is surfaced in the audit backfill queue.

`proofOfReserves.type` describes the linked reporting engagement, not a separate audit at another cadence. Use `agreed-upon-procedures` for procedures that report findings without an assurance opinion, and `attestation` for an independent verification-agent attestation that is neither an audit nor AUP. Neither type enters the V9 `independent-audit` admission or expired-audit fallback paths. The reserve coverage audit counts these types and their missing structured latest reports separately; neither label supplies missing scope, reconciliation, or review evidence.

`dependencyReview` remains base metadata. It is required for manual-only `dependencies`, including a reserve-linked relationship with a reviewed non-default V9 economic role. When present, it must exactly cover those edges plus the implicit `variantOf` wrapper edge, with explicit types and matching weights; a wrapper-only review is valid. Ordinary reserve-derived edges use reserve composition and `reserveReview` provenance, not duplicated per-edge evidence. `shared/lib/stablecoins/schema.ts` owns the distinction.

Keep domain evidence and coupled decisions in their owning sidecar. `blacklistabilityReview.reviewedStatus` is the sole authored freeze/blacklist verdict.

[Source Files](../stablecoin-data.md#source-files) owns generated projection boundaries; sidecars remain complete research inputs even when a consumer omits their evidence envelopes.

For `bridgeRouteRisk` and `mintAuthority` deployment references, route/control fields, mutable upgrade paths and ownership validation, use the [native issuance / Bridge Risk authoring contract](../stablecoin-data.md#mint-authority-and-bridge-risk-ownership). Mint incidents retain explicit active/resolved state, with `resolvedAt` only for resolved incidents. An intentionally unscoreable mint review uses `review.disposition: "unresolved"` and retains its questions, not an accidental missing-profile gap. Shared addresses/failure-domain keys join controller identity without merging capabilities.

Fund NAV oracle reviews bind the exact share class and distinguish administrator valuation from its publication relay. An external NAV feed does not prove independent valuation, redundant pricing or publisher signer closure; issuer-operated relays retain privileged internal pricing. Ordinary fund settlement, gross cash and account-scoped instant withdrawal limits do not establish same-notional executable redemption capacity.

Cross-domain incidents stay outside this split; [Mint Authority Review](../stablecoin-data.md#mint-authority-review) owns the incident-registry routing contract. Keep domain-native incident fields when they express the event, and never duplicate one incident across both sources.

### Deciding which sidecar owns a control

Route by capability, not controller location or reuse of a Safe. Follow the [native issuance / Bridge Risk boundary](../stablecoin-data.md#mint-authority-and-bridge-risk-ownership); a canonical-chain adapter can still be Bridge Risk. Keep blacklist, seizure, oracle, reserve, custody, redemption and unrelated pause facts with their existing owner even when they share an administrator. A domain move preserves controller identity and adverse evidence; it never grants a favorable score by itself.

## Updating Research

1. Check whether `domains/<domain>/<id>.json` exists.
2. If it exists, edit the sidecar. Do not copy its fields back into `coins/<id>.json`.
3. If it does not exist, create it. Do not author domain-owned fields in the base file; the migration below exists for legacy layouts, not for new research.
4. Preserve existing evidence and values unless the task includes reviewed research. A layout migration must not invent or refresh facts.
5. Run focused schema/loader tests before regenerating artifacts.

Strict schemas reject unknown keys, filename/base ID mismatches, orphans, unsupported domains and base/sidecar domain splits.

## Migration Workflow

The catalog migration is complete; new research goes directly into the owning sidecar. If an old branch or malformed source reintroduces domain-owned fields into a base coin file, use `scripts/maintenance/migrate-stablecoin-sidecar.ts --help` and preview with `--dry-run` before applying. The tool moves only authored fields and refuses the write unless the complete merged projection, including other domain sidecars and cross-domain refinements, remains deeply equal.

## Coordinated Generation

In parallel work, finish all base/sidecar moves before regenerating shared projections. Record hashes or retain an in-memory snapshot of the generated projections before a layout-only batch, then regenerate once:

```bash
npm run bootstrap:generated
```

For a layout-only move, the full, client, compliance, Telegram Mini App, Worker runtime, report-card fingerprint, and legacy-redirect artifacts must remain byte-identical. If they change, stop and inspect the projection before proceeding.

Validation:

```bash
npm run check:stablecoin-data
npm run check:generated-artifacts
npm run typecheck
npm run typecheck:worker
```
