# Stablecoin Data Registry

Stablecoin metadata is the checked-in source of truth for the asset universe. Use this document when adding, removing, or correcting a stablecoin entry.

## Source Files

| Surface                                           | Source                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Editable catalog source of truth                  | `shared/data/stablecoins/coins/*.json`                                                                                                                                                                                                                                                       |
| Optional domain sidecars                          | `shared/data/stablecoins/domains/<domain>/<id>.json` for migrated fields such as `domains/reserves/<id>.json`                                                                                                                                                                                |
| Generated runtime aggregates                      | `shared/data/stablecoins/coins.generated.json`, `shared/data/stablecoins/coins.client.generated.json`, `shared/data/stablecoins/coins.compliance.generated.json`, `shared/data/stablecoins/coins.prevalidated.generated.ts`, `shared/data/stablecoins/legacy-llama-redirects.generated.json` |
| Legacy compatibility shells                       | `shared/data/stablecoins/usd-major.json`, `shared/data/stablecoins/usd-minor.json`, `shared/data/stablecoins/non-usd.json`, `shared/data/stablecoins/commodity.json`, `shared/data/stablecoins/pre-launch.json`                                                                              |
| Canonical display/order list                      | `shared/data/stablecoins/canonical-order.json`                                                                                                                                                                                                                                               |
| Full registry and lifecycle splits                | `shared/lib/stablecoins/registry.ts`                                                                                                                                                                                                                                                         |
| Listing-class decision ledger                     | `shared/data/stablecoins/listing-decisions.json`                                                                                                                                                                                                                                             |
| Delisted discovery fingerprints                   | `shared/data/stablecoins/listing-exclusions.json`                                                                                                                                                                                                                                            |
| Client registry projection                        | `shared/lib/stablecoins/client-registry.ts`                                                                                                                                                                                                                                                  |
| Defunct/cemetery metadata                         | `shared/data/dead-stablecoins.json`, loaded separately by `shared/lib/dead-stablecoins.ts`                                                                                                                                                                                                   |
| Runtime schema                                    | `shared/lib/stablecoins/schema.ts`                                                                                                                                                                                                                                                           |
| Canonical ID resolver                             | `shared/lib/stablecoin-id-registry.ts`                                                                                                                                                                                                                                                       |
| PSI-only shadow assets                            | `shared/lib/shadow-stablecoins.ts`                                                                                                                                                                                                                                                           |
| Local metadata gotchas                            | `shared/data/stablecoins/AGENTS.md`                                                                                                                                                                                                                                                          |

`ACTIVE_STABLECOINS` contains only active or omitted-status entries. Pre-launch, quarantined, delisted, and frozen records are excluded from live producers and aggregates. `READABLE_STABLECOINS` keeps the post-launch catalog (active + quarantined + delisted + frozen) for historical/read-only identity surfaces; it is not a live cache universe. PSI-only shadow assets are outside the public tracked registry and exist only for historical PSI replay. Canonical ID resolution is split by scope in `shared/lib/stablecoin-id-registry.ts`: tracked helpers cover the complete catalog, readable helpers cover post-launch records, and PSI-inclusive helpers cover active tracked IDs plus shadow IDs.

The editable stablecoin catalog primarily lives in per-coin files under `shared/data/stablecoins/coins/*.json`. Research-heavy fields can be migrated into sidecars under `shared/data/stablecoins/domains/<domain>/<id>.json`; the catalog loader validates each sidecar, merges it into the base coin, and then validates the merged record with the normal `StablecoinMeta` schema. [Stablecoin Research Sidecars](./process/stablecoin-research-sidecars.md) owns the supported domains, migration rules, and generator contract. `shared/data/stablecoins/coins.generated.json` is a gitignored runtime aggregate produced from that merged catalog; do not edit it by hand. Regenerate the aggregate and its dependent projections after catalog edits with:

```bash
npm run bootstrap:generated
```

Legacy category shards remain only as read-only compatibility shells. Do not add or move entries into `usd-major.json`, `usd-minor.json`, `non-usd.json`, `commodity.json`, or `pre-launch.json`; they should remain empty, and `npm run check:stablecoin-data` guards that source layout.

The client, compliance, prevalidated runtime, and legacy redirect projections are also generated from the per-coin catalog. `coins.client.generated.json` powers lightweight browser-facing metadata through `shared/lib/stablecoins/client-registry.ts`; `coins.compliance.generated.json` keeps GENIUS long-form evidence scoped to `/compliance/`; `coins.prevalidated.generated.ts` lets the full registry load checked metadata without validating the entire aggregate on the hot path or bundling the full Zod registry validator into browser-facing chunks; `legacy-llama-redirects.generated.json` is the minimal Pages Functions map for old numeric DefiLlama stablecoin URLs. Run `npm run check:generated-artifacts` after metadata edits, and regenerate those projections with the scripts named by that check if they drift.

## Editing Rules

- Keep IDs canonical and stable: lowercase `ticker-issuer` format, aligned with `shared/lib/stablecoin-id-registry.ts`.
- Add or update exactly one base file under `shared/data/stablecoins/coins/*.json`, then update `canonical-order.json`.
- The base file name and the JSON `id` must match exactly; `foo-issuer.json` must contain `"id": "foo-issuer"`.
- For fields already migrated to a sidecar, edit the sidecar instead of duplicating the field in the base coin. Follow [Stablecoin Research Sidecars](./process/stablecoin-research-sidecars.md); the domain directories are the current ownership inventory.
- Sidecars are strict and must use the same `id` as the base coin. A field may exist in the base coin or in a sidecar, not both; duplicate fields fail catalog loading.
- Run `npm run bootstrap:generated` after per-coin or sidecar edits to refresh the full, client, compliance, prevalidated runtime, and legacy redirect projections.
- Preserve existing supply policy. Primary supply comes from DefiLlama through the existing fallback path; do not add manual, on-chain, CMC, or DEX supply overrides.
- Contract metadata belongs under each coin's `contracts` array. Use verified chain IDs and decimals from source metadata or explorers before adding them.
- `marketAvailability` is descriptive editorial metadata, not a runtime price/supply source. It can record whether a stablecoin is market-traded, limited-trading, non-traded-utility, or legacy-or-wind-down when a coverage source exposes that distinction.
- `pegScoreCoverage` is curated detector-history provenance, not a launch-date substitute. Use it only when replay and the handoff to live monitoring have been reviewed as continuous; include the replay run ID when available. PegScore and its recent-window companion start at this boundary so unobserved earlier days are not counted as stable.
- Keep `mechanismArchetypeReview` and `implementationLaunchDate` in the base coin file. Resolved reviews co-require `mechanismArchetype`; unresolved reviews intentionally omit it. Variants inherit the parent archetype unless a sourced `archetypeOverride` documents a real departure.
- Use `liveReservesConfig`, `yieldConfig`, and other feature configs only when the relevant pipeline already supports that source family.
- Use `oracleRisk` only for reviewed oracle / collateral price-feed setup. Safety Score v8.11 consumes it only for crypto-backed CDP assets (`mechanismArchetype: "cdp"` plus `flags.backing: "crypto-backed"`), and missing reviews are neutral. Direct non-variant CDPs can receive the oracle blend; tracked variants can carry research metadata for coverage but resolvable wrappers display inherited parent exposure instead of taking a duplicate direct blend. Source reviewed profiles with protocol docs, audits, verified contract references, and observed blocks/dates. Every branch review must record a source-backed `branchApplicability` disposition: `branches-required` declares `branchModel: "multi-branch"` and requires feed, fallback, liquidation, backstop, and shutdown/bad-debt evidence on every branch; `not-applicable` records why market-specific paths do not exist; `unresolved` records the sourced gap and blocks branch-complete v9 evaluation without changing v8 scoring.
- Use `bridgeRouteRisk` only for reviewed cross-chain route setup. Safety Score v8.12 consumes curated profiles through a penalty-only Decentralization blend, and missing reviews are neutral. L2BEAT Interop candidate output can point reviewers at protocols and likely tiers, but do not paste it into metadata without checking issuer docs, bridge docs, contracts, or L2BEAT protocol pages and adding `reviewedAt`, `reviewer`, `confidence`, summary, protocol evidence, and sources.
- Active coins with multiple authored deployments require `bridgeRouteRisk.routes` rows that exactly match each catalog chain/contract pair. Route rows carry protocol, issuance model, native/canonical/third-party class, semantics, reviewed tier, scope, observation/controller evidence, and optional failure-domain keys. Runtime supply is joined by exact chain/contract; same-chain multi-contract supply stays unknown because DefiLlama does not disaggregate it. `npm run audit:bridge-route-coverage` reports static completeness and known ambiguity.
- `variantOf` and `variantKind` describe direct exposure to another tracked stablecoin. An active child requires an active, non-variant, non-`navToken` parent; historical quarantined, delisted, or frozen children may retain the relationship for accurate readback. The child keeps `pegReferenceId === variantOf` plus `flags.navToken === true`. Variant kinds are `savings-passthrough`, `strategy-vault`, `risk-absorption`, and `bond-maturity`.
- Pre-launch assets are ordinary per-coin catalog files with `status: "pre-launch"` until they have enough live metadata for active public surfaces.
- Quarantined and delisted rows retain their canonical per-coin file and a sourced `listingStatusReview`; see [Stablecoin Listing Policy](./listing-policy.md). Delisted rows also have an `excluded` class and durable discovery fingerprints.
- Shadow assets belong only in `shared/lib/shadow-stablecoins.ts`, not in the editable per-coin catalog.
- Duplicate IDs across per-coin files or legacy compatibility shells are invalid and fail validation.

## Mint Authority Review

Mint Authority review is a curated metadata track for answering whether durable stablecoin supply can be created by privileged parties, governance modules, bridge routes, proxy/cap admins, backend signers, or only by user/protocol mechanics. The metadata feeds the Mint Authority Score in `shared/lib/mint-authority-scoring.ts`, which since Safety Score v8.0 also drags the Decentralization report-card dimension through a penalty-only blend. Missing or unresolved review data returns `NR`; it does not mean safe and never penalizes any score.

The detail page consumes a compact presentation summary when available: mint path, authority posture, confidence, summary, primary controls, incident metadata, reviewed date, source links, and score components. Homepage, screener, and coverage projections consume the lighter `mintAuthoritySummary` fields needed for score and bucket display. Since Safety Score v8.0, the Mint Authority Score is also exposed as `rawInputs.mintAuthorityScore` and can drag the Decentralization dimension through a penalty-only blend. It still must not create selector exclusions, feed other report-card dimensions, or change report-card ranking semantics outside the Decentralization score that already propagates through Safety Score.

Scanner output is not curated metadata. The local scanner POC writes candidate artifacts under `agents/mint-authority-candidates/` and never updates `shared/data/stablecoins/coins/*.json`, generated registries, or client projections. A reviewer must verify source links, current controls, Safe/multisig threshold and modules/guards when relevant, key-custody attestation, proxy/cap authority, whether caps can be raised, historical `mintIncidents` evidence, and unresolved bridge/off-chain route checks before authoring or amending a coin's `mintAuthority` metadata field (defined in `shared/lib/stablecoins/schema.ts` and consumed by the detail page, screener filters, coverage, and DDR resolver). Upgradeable profiles can record proxy/implementation/admin addresses, delay, observation point, sources, and an exact `controlRef`; immutable claims require sourced evidence. Incidents require `active` or `resolved` status so current compromise is not presented as remediated history. Addressed controls can add `observedAt`/`observedBlock`, while reviewed off-chain common modes use `failureDomainKeys`. Since Mint Authority Score `v1.2`, `canRaiseCap` must be explicitly `false` for every cap-limited mint-capable control to receive the immutable-cap bonus; unknown or omitted cap mutability remains bounded but no longer scores as immutable.

## Required Checks

Run these after metadata edits:

```bash
npm run bootstrap:generated
npm run check:stablecoin-data
npm run check:mechanism-archetype-coverage
npm run check:generated-artifacts
npm test -- shared/lib/__tests__/stablecoin-id-registry.test.ts
```

If the change affects page counts, feature coverage, reserve coverage, source families, or public methodology behavior, also update the matching route/feature docs from `docs/README.md`.

## Cache Admission

`scripts/ci/check-stablecoin-data.ts` validates schema shape, canonical-order consistency, duplicate IDs, legacy-shell emptiness, `coins.generated.json` freshness, wrapper-variant invariants, and whether active assets have a static path into `/api/stablecoins` cache admission. If that check fails, fix metadata or pipeline support rather than bypassing the guard.

Common admission fields:

- `llamaId` / DefiLlama-backed assets
- `detailProvider: "coingecko"` plus either `geckoId`, Zephyr Scanner support, a curated aggregate supply path, or exactly one runtime-supported on-chain total-supply contract; commodity assets still require `geckoId`
- verified `contracts` for chain-level coverage and explorer links
- `status: "pre-launch"` for assets that should not enter active public surfaces yet

The active runtime gate and research-packet format are documented in [Adding a Stablecoin](./process/adding-a-stablecoin.md#1a-hard-runtime-data-gate-for-active-assets). Listing class, quarantine, and delisting decisions follow [Stablecoin Listing Policy](./listing-policy.md).

## Documentation Touchpoints

- Classification or taxonomy changes: `docs/classification.md`
- Listing scope or lifecycle policy changes: `docs/listing-policy.md`
- Compliance metadata changes: `docs/compliance-page.md` plus `docs/mica-tracker.md` when MiCA semantics change
- Public source roster changes: `docs/about-page.md` and `src/app/about/content.ts`
- Reserve config changes: `docs/live-reserves.md`
- Redemption-route changes: `docs/redemption-backstops.md`
- Yield config changes: `docs/yield-intelligence.md`
- API shape changes caused by metadata fields: `docs/api-reference.md`
