# Stablecoin Data Registry

Stablecoin metadata is the checked-in source of truth for the asset universe. Use this document when adding, removing, or correcting a stablecoin entry.

## Source Files

| Surface                                           | Source                                                                                                                                                                                                                            |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Editable catalog source of truth                  | `shared/data/stablecoins/coins/*.json`                                                                                                                                                                                            |
| Optional domain sidecars                          | `shared/data/stablecoins/domains/<domain>/<id>.json` for migrated fields such as `domains/reserves/<id>.json`                                                                                                                     |
| Generated runtime aggregates                      | `shared/data/stablecoins/coins.generated.json`, `shared/data/stablecoins/coins.client.generated.json`, `shared/data/stablecoins/coins.compliance.generated.json`, `shared/data/stablecoins/coins.prevalidated.generated.ts`, `shared/data/stablecoins/legacy-llama-redirects.generated.json` |
| Legacy compatibility shells                       | `shared/data/stablecoins/usd-major.json`, `shared/data/stablecoins/usd-minor.json`, `shared/data/stablecoins/non-usd.json`, `shared/data/stablecoins/commodity.json`, `shared/data/stablecoins/pre-launch.json`                   |
| Canonical display/order list                      | `shared/data/stablecoins/canonical-order.json`                                                                                                                                                                                    |
| Full registry and active/pre-launch/frozen splits | `shared/lib/stablecoins/registry.ts`                                                                                                                                                                                              |
| Client registry projection                        | `shared/lib/stablecoins/client-registry.ts`                                                                                                                                                                                       |
| Defunct/cemetery metadata                         | `shared/data/dead-stablecoins.json`, loaded separately by `shared/lib/dead-stablecoins.ts`                                                                                                                                        |
| Runtime schema                                    | `shared/lib/stablecoins/schema.ts`                                                                                                                                                                                                |
| Canonical ID resolver                             | `shared/lib/stablecoin-id-registry.ts`                                                                                                                                                                                            |
| PSI-only shadow assets                            | `shared/lib/shadow-stablecoins.ts`                                                                                                                                                                                                |
| Local metadata gotchas                            | `shared/data/stablecoins/AGENTS.md`                                                                                                                                                                                               |

`ACTIVE_STABLECOINS` excludes pre-launch and frozen entries. `READABLE_STABLECOINS` keeps active + frozen assets for archive/readback surfaces. PSI-only shadow assets are intentionally outside the public tracked registry and exist only for historical PSI replay. Canonical ID resolution is split by scope in `shared/lib/stablecoin-id-registry.ts`: tracked helpers include pre-launch and frozen tracked IDs, readable helpers include only active + frozen tracked IDs, and PSI-inclusive helpers include active tracked IDs + shadow IDs.

The editable stablecoin catalog primarily lives in per-coin files under `shared/data/stablecoins/coins/*.json`. Some large domain-specific fields can be migrated into sidecars under `shared/data/stablecoins/domains/<domain>/<id>.json`; the catalog loader validates each sidecar, merges it into the base coin, and then validates the merged record with the normal `StablecoinMeta` schema. `shared/data/stablecoins/coins.generated.json` is the checked-in full runtime aggregate produced from that merged catalog; do not edit it by hand. Regenerate it after catalog edits with:

```bash
npx tsx scripts/maintenance/generate-stablecoin-per-coin-asset.ts
```

Legacy category shards remain only as read-only compatibility shells. Do not add or move entries into `usd-major.json`, `usd-minor.json`, `non-usd.json`, `commodity.json`, or `pre-launch.json`; they should remain empty, and `npm run check:stablecoin-data` guards that source layout.

The client, compliance, prevalidated runtime, and legacy redirect projections are also generated from the per-coin catalog. `coins.client.generated.json` powers lightweight browser-facing metadata through `shared/lib/stablecoins/client-registry.ts`; `coins.compliance.generated.json` keeps GENIUS long-form evidence scoped to `/compliance/`; `coins.prevalidated.generated.ts` lets the full registry load checked metadata without validating the entire aggregate on the hot path or bundling the full Zod registry validator into browser-facing chunks; `legacy-llama-redirects.generated.json` is the minimal Pages Functions map for old numeric DefiLlama stablecoin URLs. Run `npm run check:generated-artifacts` after metadata edits, and regenerate those projections with the scripts named by that check if they drift.

## Editing Rules

- Keep IDs canonical and stable: lowercase `ticker-issuer` format, aligned with `shared/lib/stablecoin-id-registry.ts`.
- Add or update exactly one base file under `shared/data/stablecoins/coins/*.json`, then update `canonical-order.json`.
- For fields already migrated to a sidecar, edit the sidecar instead of duplicating the field in the base coin. The first migrated domain is reserve composition: edit `shared/data/stablecoins/domains/reserves/<id>.json` for the selected migrated coins (`usdc-circle`, `usdt-tether`, `pyusd-paypal`, `usde-ethena`, and `usds-sky`).
- Sidecars are strict and must use the same `id` as the base coin. A field may exist in the base coin or in a sidecar, not both; duplicate fields fail catalog loading.
- Regenerate `shared/data/stablecoins/coins.generated.json` after per-coin or sidecar edits, and keep the client, prevalidated runtime, and legacy redirect projections fresh.
- Preserve existing supply policy. Primary supply comes from DefiLlama through the existing fallback path; do not add manual, on-chain, CMC, or DEX supply overrides.
- Contract metadata belongs under each coin's `contracts` array. Use verified chain IDs and decimals from source metadata or explorers before adding them.
- `marketAvailability` is descriptive editorial metadata, not a runtime price/supply source. It can record whether a stablecoin is market-traded, limited-trading, non-traded-utility, or legacy-or-wind-down when a coverage source exposes that distinction.
- Use `liveReservesConfig`, `yieldConfig`, and other feature configs only when the relevant pipeline already supports that source family.
- Use `oracleRisk` only for reviewed oracle / collateral price-feed setup. Safety Score v8.11 consumes it only for crypto-backed CDP assets (`mechanismArchetype: "cdp"` plus `flags.backing: "crypto-backed"`), and missing reviews are neutral. Direct non-variant CDPs can receive the oracle blend; tracked variants can carry research metadata for coverage but resolvable wrappers display inherited parent exposure instead of taking a duplicate direct blend. Source reviewed profiles with protocol docs, audits, or verified contract references; include `reviewedAt`, `reviewer`, `confidence`, and branch rows when collateral markets or chains use materially different oracle paths.
- Use `bridgeRouteRisk` only for reviewed cross-chain route setup. Safety Score v8.12 consumes curated profiles through a penalty-only Decentralization blend, and missing reviews are neutral. L2BEAT Interop candidate output can point reviewers at protocols and likely tiers, but do not paste it into metadata without checking issuer docs, bridge docs, contracts, or L2BEAT protocol pages and adding `reviewedAt`, `reviewer`, `confidence`, summary, protocol evidence, and sources.
- `variantOf` and `variantKind` are active-only parent-wrapper metadata. Use them only when the child is direct exposure to another active tracked stablecoin and the variant kind is one of the explicit enum values: `savings-passthrough`, `strategy-vault`, `risk-absorption`, or `bond-maturity`. `risk-absorption` covers tranche or buffer products whose holders absorb extra protocol risk for the parent exposure. Variant rows co-require an active, non-variant, non-`navToken` parent, and the child must keep `pegReferenceId === variantOf` plus `flags.navToken === true`. Report-card wrapper haircuts are keyed by `variantKind`.
- Pre-launch assets are ordinary per-coin catalog files with `status: "pre-launch"` until they have enough live metadata for active public surfaces.
- Shadow assets belong only in `shared/lib/shadow-stablecoins.ts`, not in the editable per-coin catalog.
- Duplicate IDs across per-coin files or legacy compatibility shells are invalid and fail validation.

## Mint Authority Review

Mint Authority review is a curated metadata track for answering whether durable stablecoin supply can be created by privileged parties, governance modules, bridge routes, proxy/cap admins, backend signers, or only by user/protocol mechanics. The metadata feeds the Mint Authority Score in `shared/lib/mint-authority-scoring.ts`, which since Safety Score v8.0 also drags the Decentralization report-card dimension through a penalty-only blend. Missing or unresolved review data returns `NR`; it does not mean safe and never penalizes any score.

The detail page consumes a compact presentation summary when available: mint path, authority posture, confidence, summary, primary controls, incident metadata, reviewed date, source links, and score components. Homepage, screener, and coverage projections consume the lighter `mintAuthoritySummary` fields needed for score and bucket display. Since Safety Score v8.0, the Mint Authority Score is also exposed as `rawInputs.mintAuthorityScore` and can drag the Decentralization dimension through a penalty-only blend. It still must not create selector exclusions, feed other report-card dimensions, or change report-card ranking semantics outside the Decentralization score that already propagates through Safety Score.

Scanner output is not curated metadata. The local scanner POC writes candidate artifacts under `agents/mint-authority-candidates/` and never updates `shared/data/stablecoins/coins/*.json`, generated registries, or client projections. A reviewer must verify source links, current controls, Safe/multisig threshold and modules/guards when relevant, key-custody attestation, proxy/cap authority, whether caps can be raised, historical `mintIncidents` evidence, and unresolved bridge/off-chain route checks before authoring or amending a coin's `mintAuthority` metadata field (defined in `shared/lib/stablecoins/schema.ts` and consumed by the detail page, screener filters, coverage, and DDR resolver). Since Mint Authority Score `v1.2`, `canRaiseCap` must be explicitly `false` for every cap-limited mint-capable control to receive the immutable-cap bonus; unknown or omitted cap mutability remains bounded but no longer scores as immutable.

## Required Checks

Run these after metadata edits:

```bash
npx tsx scripts/maintenance/generate-stablecoin-per-coin-asset.ts
npm run check:stablecoin-data
npm run check:generated-artifacts
npm run check:doc-counts
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

## Documentation Touchpoints

- Classification or taxonomy changes: `docs/classification.md`
- Compliance metadata changes: `docs/compliance-page.md` plus `docs/mica-tracker.md` when MiCA semantics change
- Public source roster changes: `docs/about-page.md` and `src/app/about/content.ts`
- Reserve config changes: `docs/live-reserves.md`
- Redemption-route changes: `docs/redemption-backstops.md`
- Yield config changes: `docs/yield-intelligence.md`
- API shape changes caused by metadata fields: `docs/api-reference.md`
