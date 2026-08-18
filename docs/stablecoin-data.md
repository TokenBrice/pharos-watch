# Stablecoin Data Registry

Stablecoin metadata is the checked-in source of truth for the asset universe. Use this document when adding, removing, or correcting a stablecoin entry.

## Source Files

| Surface                                           | Source                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Editable catalog source of truth                  | `shared/data/stablecoins/coins/*.json`                                                                                                                                                                                                                                                       |
| Domain research sidecars                          | `shared/data/stablecoins/domains/<domain>/<id>.json`; a file is optional per coin, but sidecar ownership is mandatory whenever that domain's fields exist                                                                                                                                    |
| Generated runtime aggregates                      | `shared/data/stablecoins/coins.generated.json`, `shared/data/stablecoins/coins.client.generated.json`, `shared/data/stablecoins/coins.compliance.generated.json`, `shared/data/stablecoins/coins.telegram-mini-app.generated.json`, `shared/data/stablecoins/legacy-llama-redirects.generated.json` |
| Canonical display/order list                      | `shared/data/stablecoins/canonical-order.json`                                                                                                                                                                                                                                               |
| Full registry and lifecycle splits                | `shared/lib/stablecoins/registry.ts`                                                                                                                                                                                                                                                         |
| Listing-class decision ledger                     | `shared/data/stablecoins/listing-decisions.json`                                                                                                                                                                                                                                             |
| Client registry projection                        | `shared/lib/stablecoins/client-registry.ts`                                                                                                                                                                                                                                                  |
| Defunct/cemetery metadata                         | `shared/data/dead-stablecoins.json`, loaded separately by `shared/lib/dead-stablecoins.ts`                                                                                                                                                                                                   |
| Runtime schema                                    | `shared/lib/stablecoins/schema.ts`                                                                                                                                                                                                                                                           |
| Canonical ID resolver                             | `shared/lib/stablecoin-id-registry.ts`                                                                                                                                                                                                                                                       |
| PSI-only shadow assets                            | `shared/lib/shadow-stablecoins.ts`                                                                                                                                                                                                                                                           |
| Local metadata gotchas                            | `shared/data/stablecoins/AGENTS.md`                                                                                                                                                                                                                                                          |

`ACTIVE_STABLECOINS` contains only active or omitted-status entries. Pre-launch, quarantined, delisted, and frozen records are excluded from live producers and aggregates. `READABLE_STABLECOINS` keeps the post-launch catalog (active + quarantined + delisted + frozen) for historical/read-only identity surfaces; it is not a live cache universe. PSI-only shadow assets are outside the public tracked registry and exist only for historical PSI replay. Canonical ID resolution is split by scope in `shared/lib/stablecoin-id-registry.ts`: tracked helpers cover the complete catalog, readable helpers cover post-launch records, and PSI-inclusive helpers cover active tracked IDs plus shadow IDs.

The editable stablecoin catalog uses base identity/routing files under `shared/data/stablecoins/coins/*.json` plus research sidecars under `shared/data/stablecoins/domains/<domain>/<id>.json`. The sidecar migration is complete: the catalog loader validates each sidecar, merges it into the base coin, and then validates the merged record with the normal `StablecoinMeta` schema. [Stablecoin Research Sidecars](./process/stablecoin-research-sidecars.md) owns the supported domains, migration rules, and generator contract. `shared/data/stablecoins/coins.generated.json` is a gitignored runtime aggregate produced from that merged catalog; do not edit it by hand. Regenerate the aggregate and its dependent projections after catalog edits with:

```bash
npm run bootstrap:generated
```

The legacy category shards (`usd-major.json`, `usd-minor.json`, `non-usd.json`, `commodity.json`, `pre-launch.json`) were emptied and then deleted. `npm run check:stablecoin-data` fails if any of those filenames reappears under `shared/data/stablecoins/`.

The client, compliance, Telegram Mini App, legacy redirect, and report-card registry fingerprint projections are gitignored local/build artifacts generated from the merged catalog. `coins.client.generated.json` powers lightweight browser-facing metadata; `coins.compliance.generated.json` keeps GENIUS long-form evidence scoped to `/compliance/`; `coins.telegram-mini-app.generated.json` powers the Mini App registry; `legacy-llama-redirects.generated.json` maps old numeric DefiLlama stablecoin URLs. `report-card-registry-fingerprint.generated.ts` pins the canonical registry identity hash so Worker report-card requests never serialize and hash the full catalog at runtime.

## Editing Rules

- Keep IDs canonical and stable: lowercase hyphenated IDs, conventionally a ticker plus issuer slug, aligned with `shared/lib/stablecoin-id-registry.ts`.
- Add or update exactly one base file under `shared/data/stablecoins/coins/*.json`, then update `canonical-order.json`.
- The base file name and the JSON `id` must match exactly; `foo-issuer.json` must contain `"id": "foo-issuer"`.
- Domain-owned research fields always live in a sidecar, never in the base coin. Follow [Stablecoin Research Sidecars](./process/stablecoin-research-sidecars.md); the domain directories are the current ownership inventory.
- Sidecars are strict and must use the same `id` as the base coin. A field may exist in the base coin or in a sidecar, not both; duplicate fields fail catalog loading.
- Run `npm run bootstrap:generated` after per-coin or sidecar edits to refresh the full, client, compliance, Telegram Mini App, and legacy redirect projections.
- Preserve existing supply policy. Never replace DefiLlama list-endpoint supply with manual, on-chain, CMC, or DEX values. Assets without a usable DefiLlama path may use only an existing explicit, documented supplemental admission path that fails closed and cannot double-count supply.
- Contract metadata belongs under each coin's `contracts` array. Use verified chain IDs and decimals from source metadata or explorers before adding them.
- `marketAvailability` is descriptive editorial metadata, not a runtime price/supply source. It can record whether a stablecoin is market-traded, limited-trading, non-traded-utility, or legacy-or-wind-down when a coverage source exposes that distinction.
- `pegScoreCoverage` is curated detector-history provenance, not a launch-date substitute. Use it only when replay and the handoff to live monitoring have been reviewed as continuous; include the replay run ID when available. PegScore and its recent-window companion start at this boundary so unobserved earlier days are not counted as stable.
- Keep `mechanismArchetypeReview` and `implementationLaunchDate` in the base coin file. Resolved reviews co-require `mechanismArchetype`; unresolved reviews intentionally omit it. Variants inherit the parent archetype unless a sourced `archetypeOverride` documents a real departure.
- Use `liveReservesConfig`, `yieldConfig`, and other feature configs only when the relevant pipeline already supports that source family.
- Use `oracleRisk` only for reviewed price authority or collateral price-feed setup. Safety Score V9 separates genuinely `oracleless` mechanisms from `privileged-internal-pricing`; `not-applicable` is neutral and emits no oracle component. Tracked variants can carry research metadata for coverage, while resolvable wrappers inherit parent exposure instead of duplicating it. Source reviewed profiles with protocol docs, audits, verified contract references, and observed blocks/dates. Every review must record a `role`: `collateral-pricing` when the feed values borrower collateral inside a liquidation engine, `coin-price-feed` otherwise. In practice `branches-required` and unresolved crypto-backed CDPs are `collateral-pricing`; everything else, including `top-level-only` mint/redemption quote authority, is `coin-price-feed`. Every review must also record a source-backed `branchApplicability` disposition: `branches-required` declares `branchModel: "multi-branch"` and requires feed, fallback, liquidation, backstop, and shutdown/bad-debt evidence on every branch; `top-level-only` declares `branchModel: "single-path"` and scores an applicable mint, redemption, NAV, or exchange-rate authority without liquidation rows; `not-applicable` records why no price-sensitive control exists; `unresolved` records the sourced gap and blocks evaluation.
- Use `bridgeRouteRisk` only for reviewed cross-chain route setup. Safety Score V9 combines curated route identities and control evidence with bounded runtime materiality. Missing required route evidence becomes an explicit gap or cap. L2BEAT Interop candidate output can point reviewers at protocols and likely tiers, but do not paste it into metadata without checking issuer docs, bridge docs, contracts, or L2BEAT protocol pages and adding `reviewedAt`, `reviewer`, `confidence`, summary, protocol evidence, and sources. See [Mint Authority and Bridge Risk ownership](#mint-authority-and-bridge-risk-ownership) for the deployment-scoped control contract.
- Active coins with multiple authored deployments require `bridgeRouteRisk.routes` rows that exactly match each catalog chain/contract pair. Route IDs use the normalized `chain:contractAddress` identity. Route rows carry protocol, issuance model, native/canonical/third-party class, semantics, reviewed tier, scope, observation/controller evidence, and optional failure-domain keys. Runtime supply is joined by exact chain/contract; same-chain multi-contract supply stays unknown because DefiLlama does not disaggregate it. `npm run audit:bridge-route-coverage` reports static completeness and known ambiguity.
- `flags` carries schema defaults for its four modal members: `pegCurrency` (`"USD"`), `yieldBearing`, `rwa`, and `navToken` (all `false`). Source coin files omit those keys when they hold the default value; `backing` and `governance` are always authored. Parsed output and every generated aggregate still contain the full flag set, so runtime consumers are unaffected.
- `variantOf` and `variantKind` describe direct exposure to another tracked stablecoin. An active child requires an active, non-variant, non-`navToken` parent; historical quarantined, delisted, or frozen children may retain the relationship for accurate readback. The child keeps `pegReferenceId === variantOf` plus `flags.navToken === true`. `VARIANT_KIND_VALUES` in `shared/types/core.ts` owns the exact kinds, including `pure-wrapper`.
- Pre-launch assets are ordinary per-coin catalog files with `status: "pre-launch"` until they have enough live metadata for active public surfaces.
- Quarantined and delisted rows retain their canonical per-coin file and a sourced `listingStatusReview`; see [Stablecoin Listing Policy](./listing-policy.md). Delisted rows also have an `excluded` class.
- Shadow assets belong only in `shared/lib/shadow-stablecoins.ts`, not in the editable per-coin catalog.
- Duplicate IDs across per-coin files or legacy compatibility shells are invalid and fail validation.

## Mint Authority and Bridge Risk ownership

Mint Authority assesses native issuance on canonical deployment(s) plus controls that can expand or replace that issuance. Bridge Risk assesses representations and cross-chain machinery: bridge mint/burn, adapters, lockboxes or escrow, messaging, peer configuration, limits, upgrades, validators, and administrators. A controller may be authored in both domains only for distinct capabilities; the same bridge capability must not appear in both.

The shared deployment identity is the exact `BridgeRouteDeployment.id` in normalized `chain:contractAddress` form. Use the canonical lowercase chain ID; lowercase EVM addresses, while preserving the authored casing of case-sensitive non-EVM identifiers. Every reference must name an existing `bridgeRouteRisk.routes[].id`.

For an active multi-deployment asset:

- every `mintAuthority.controls[]` entry needs one or more `deploymentRefs`, and each reference must resolve to a reviewed route with `issuanceModel: "native-issuance"`;
- `mintAuthority.upgradeability.deploymentRefs` is required when `canChangeMintLogic: true` and names only the native deployments whose mint-critical logic the path can replace;
- bridge machinery belongs in `bridgeRouteRisk.controls[]`. Each `BridgeRouteControl` has a stable kebab-case `id`, one or more `routeRefs`, and unique capabilities drawn from `bridge-mint`, `bridge-burn`, `upgrade`, `admin`, `pause`, `rate-limit`, `validator`, `escrow`, and `peer-config`;
- a bridge control may reference a reviewed native route when the capability governs a transfer pool, adapter, peer, or message path rather than ordinary native issuance; and
- a reviewed `bridge-representation` or `wrapped-representation` route referenced by any structured bridge control must have at least one covering control with `bridge-mint`; if the minter cannot be identified, leave the route out of every control's `routeRefs` so the conservative route-derived fallback remains scoreable; and
- active Mint Authority data cannot use `role: "bridge-admin"`, `authorityType: "bridge"`, `routeChecks`, or `mintPath: "bridge-or-oft-synthetic"`. The three bridge-specific enum values remain only for historical readback; `routeChecks` belongs on structured bridge controls.

A single-deployment asset may omit `deploymentRefs` only while its sole authored deployment is unambiguously reviewed native issuance. Add explicit references when another deployment is authored or canonicality becomes ambiguous.

Do not invent a native route for a product with no local issuance. Author `mintAuthority.review.noLocalIssuance` with `reviewedAt`, `reviewer`, and `rationale`; either exception kind is invalid when a reviewed native-issuance route exists. `kind: "inherited-parent-issuance"` additionally requires `mintPath: "wrapped-or-variant-inherited"` and `inheritedFrom`. `kind: "external-only-representation"` is valid only when every authored route is reviewed and every authored contract is covered by one of those routes.

`npm run check:stablecoin-data` runs the ownership audit as a blocking catalog gate. It rejects malformed, duplicate, unknown, or non-native references; invalid no-local-issuance exceptions; `representation-route-without-bridge-mint`; duplicate cross-domain bridge capabilities; missing active multi-deployment refs; and bridge vocabulary in active Mint Authority data. The V9 compiler rechecks ownership and fails closed rather than silently dropping an invalid control.

## Mint Authority Review

Mint Authority review is a curated metadata track for answering whether durable native stablecoin supply can be created by privileged parties, governance modules, proxy/cap admins, backend signers, or only by user/protocol mechanics. Cross-chain representations and transfer-rail controls stay in Bridge Risk under the ownership contract above. Safety Score V9 compiles the reviewed native control evidence directly into the Economic Control pillar's mint component; there is no second engine over this block. Missing or unresolved review data returns `NR` for the display score and produces explicit V9 evidence gaps; it does not mean safe.

The detail page consumes a compact presentation summary when available: mint path, authority posture, confidence, summary, primary controls, incident metadata, reviewed date, and source links. Homepage, screener, and coverage projections consume the lighter `mintAuthoritySummary` fields needed for the review-route buckets. Since safety `9.1` there is no second mint score: the published Safety Score V9 mint component is the only mint score any surface renders, and `authorityPosture` is a validated annotation that never affects the Safety Score (`npm run safety-score-v9:mint-posture-queue` reports curated-versus-derived disagreements). `authorityPosture` is not unused, though: the depeg resolver consumes the curated value as a structural input (`shared/lib/depeg-resolver/resolution.ts`, `shared/lib/depeg-resolver/strata.ts`), so re-curating a posture can move a published depeg verdict.

Scanner output is not curated metadata. The local scanner POC writes candidate artifacts under `agents/mint-authority-candidates/` and never updates sidecars, generated registries, or client projections. A reviewer must verify source links, current native controls, Safe/multisig threshold and modules/guards when relevant, key-custody attestation, proxy/cap authority, whether caps can be raised, historical `mintIncidents` evidence, and unresolved issuance paths before authoring or amending `shared/data/stablecoins/domains/mint-authority/<id>.json` (defined in `shared/lib/stablecoins/schema.ts` and consumed by the V9 compiler, detail page, screener filters, coverage, and DDR resolver). Upgradeable profiles can record proxy/implementation/admin addresses, deployment references, delay, observation point, sources, and an exact `controlRef`; immutable claims require sourced evidence. Incidents require `active` or `resolved` status so current compromise is not presented as remediated history. Addressed controls can add `observedAt`/`observedBlock`; a reused controller can add `controllerAssetId` only when review proves which tracked native issuance system owns it, while reviewed off-chain common modes use `failureDomainKeys`. Historical Mint Authority v1.2 required explicit `canRaiseCap: false` for its immutable-cap bonus; current authoring still records cap mutability as V9 control evidence rather than maintaining that retired score.

## Required Checks

Run ordinary catalog generation and focused validation while editing:

```bash
npm run bootstrap:generated
npm run check:stablecoin-data
npm run audit:coverage -- --domain=mechanism-archetype
npm test -- shared/lib/__tests__/stablecoin-id-registry.test.ts
```

Then validate the complete artifact graph:

```bash
npm run check:generated-artifacts
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
