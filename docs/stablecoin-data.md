# Stablecoin Data Registry

Stablecoin metadata is the checked-in source of truth for the asset universe. Use this document when adding, removing, or correcting a stablecoin entry.

## Source Files

| Surface | Source |
| --- | --- |
| Editable catalog source of truth | `shared/data/stablecoins/coins/*.json` |
| Generated runtime aggregate | `shared/data/stablecoins/coins.generated.json`, regenerated with `tsx scripts/generate-stablecoin-per-coin-asset.ts` |
| Legacy compatibility shells | `shared/data/stablecoins/usd-major.json`, `shared/data/stablecoins/usd-minor.json`, `shared/data/stablecoins/non-usd.json`, `shared/data/stablecoins/commodity.json`, `shared/data/stablecoins/pre-launch.json` |
| Canonical display/order list | `shared/data/stablecoins/canonical-order.json` |
| Loader and active/pre-launch splits | `shared/lib/stablecoins/index.ts` |
| Defunct/cemetery metadata | `shared/data/dead-stablecoins.json`, loaded separately by `shared/lib/dead-stablecoins.ts` |
| Runtime schema | `shared/lib/stablecoins/schema.ts` |
| Canonical ID resolver | `shared/lib/stablecoin-id-registry.ts` |
| PSI-only shadow assets | `shared/lib/shadow-stablecoins.ts` |
| Local metadata gotchas | `shared/data/stablecoins/AGENTS.md` |

`ACTIVE_STABLECOINS` excludes pre-launch and frozen entries. `READABLE_STABLECOINS` keeps active + frozen assets for archive/readback surfaces. PSI-only shadow assets are intentionally outside the public tracked registry and exist only for historical PSI replay. Canonical ID resolution is split by scope in `shared/lib/stablecoin-id-registry.ts`: tracked helpers include pre-launch and frozen tracked IDs, readable helpers include only active + frozen tracked IDs, and PSI-inclusive helpers include active tracked IDs + shadow IDs.

The editable stablecoin catalog lives in per-coin files under `shared/data/stablecoins/coins/*.json`. `shared/data/stablecoins/coins.generated.json` is the checked-in generated/runtime aggregate; do not edit it by hand. Regenerate it after catalog edits with:

```bash
tsx scripts/generate-stablecoin-per-coin-asset.ts
```

Legacy category shards remain only as read-only compatibility shells. Do not add or move entries into `usd-major.json`, `usd-minor.json`, `non-usd.json`, `commodity.json`, or `pre-launch.json`; they should remain empty, and `npm run check:stablecoin-data` guards that source layout.

## Editing Rules

- Keep IDs canonical and stable: lowercase `ticker-issuer` format, aligned with `shared/lib/stablecoin-id-registry.ts`.
- Add or update exactly one file under `shared/data/stablecoins/coins/*.json`, then update `canonical-order.json`.
- Regenerate `shared/data/stablecoins/coins.generated.json` after per-coin edits.
- Preserve existing supply policy. Primary supply comes from DefiLlama through the existing fallback path; do not add manual, on-chain, CMC, or DEX supply overrides.
- Contract metadata belongs under each coin's `contracts` array. Use verified chain IDs and decimals from source metadata or explorers before adding them.
- Use `liveReservesConfig`, `yieldConfig`, and other feature configs only when the relevant pipeline already supports that source family.
- `variantOf` and `variantKind` are active-only parent-wrapper metadata. Use them only for wrapped/staked, strategy-vault, or bond-leg products whose user expectation is still direct exposure to another tracked stablecoin; they co-require, the parent must be active, non-variant, and non-`navToken`, and the child must keep `pegReferenceId === variantOf` plus `flags.navToken === true`.
- Pre-launch assets are ordinary per-coin catalog files with `status: "pre-launch"` until they have enough live metadata for active public surfaces.
- Shadow assets belong only in `shared/lib/shadow-stablecoins.ts`, not in the editable per-coin catalog.
- Duplicate IDs across per-coin files or legacy compatibility shells are invalid and fail validation.

## Required Checks

Run these after metadata edits:

```bash
tsx scripts/generate-stablecoin-per-coin-asset.ts
npm run check:stablecoin-data
npm run check:doc-counts
npm test -- shared/lib/__tests__/stablecoin-id-registry.test.ts
```

If the change affects page counts, feature coverage, reserve coverage, source families, or public methodology behavior, also update the matching route/feature docs from `docs/README.md`.

## Cache Admission

`scripts/check-stablecoin-data.ts` validates schema shape, canonical-order consistency, duplicate IDs, legacy-shell emptiness, `coins.generated.json` freshness, wrapper-variant invariants, and whether active assets have a static path into `/api/stablecoins` cache admission. If that check fails, fix metadata or pipeline support rather than bypassing the guard.

Common admission fields:

- `llamaId` / DefiLlama-backed assets
- `detailProvider: "coingecko"` plus either `geckoId` or a supported on-chain total-supply contract; commodity assets still require `geckoId`
- verified `contracts` for chain-level coverage and explorer links
- `status: "pre-launch"` for assets that should not enter active public surfaces yet

## Documentation Touchpoints

- Classification or taxonomy changes: `docs/classification.md`
- Public source roster changes: `docs/about-page.md` and `src/app/about/content.ts`
- Reserve config changes: `docs/live-reserves.md`
- Redemption-route changes: `docs/redemption-backstops.md`
- Yield config changes: `docs/yield-intelligence.md`
- API shape changes caused by metadata fields: `docs/api-reference.md`
