# Stablecoin Data Agent Notes

Applies to `shared/data/stablecoins/**`.

## Read First

- `docs/classification.md`
- `docs/shadow-stablecoins.md` for PSI-only exclusions
- `docs/process/adding-a-stablecoin.md` when adding a new asset

## Rules

See root AGENTS.md / CLAUDE.md Hard Rules for cross-cutting rules. This file only documents stablecoin-data-specific items.

- Author base stablecoin metadata in `shared/data/stablecoins/coins/*.json`; migrated domain fields live in sidecars under `shared/data/stablecoins/domains/<domain>/<id>.json`.
- The first sidecar domain is `reserves`; for migrated coins, edit reserve composition in `shared/data/stablecoins/domains/reserves/<id>.json` and keep `reserves` out of the matching base coin file.
- Sidecar files must not live under `shared/data/stablecoins/coins/`. Sidecar `id` values must match the base coin ID, and duplicate fields across a base coin and sidecar are invalid.
- Regenerate `shared/data/stablecoins/coins.generated.json` with `tsx scripts/maintenance/generate-stablecoin-per-coin-asset.ts` after per-coin or sidecar edits. Do not edit generated registry artifacts by hand.
- Keep the client, prevalidated, and legacy redirect projections fresh too: `shared/data/stablecoins/coins.client.generated.json`, `shared/data/stablecoins/coins.prevalidated.generated.ts`, and `shared/data/stablecoins/legacy-llama-redirects.generated.json` are generated from the same per-coin catalog and guarded by `npm run check:generated-artifacts`.
- Treat `usd-major.json`, `usd-minor.json`, `non-usd.json`, `commodity.json`, and `pre-launch.json` as read-only compatibility shells. They should remain empty, and `npm run check:stablecoin-data` guards that layout.
- Keep `canonical-order.json` aligned with the per-coin catalog.
- Add or update contracts only when the address is verified against the relevant source.
- If adding a data source, update the about page and source docs.
- If classification or methodology semantics change, update the relevant methodology doc and timeline.

## Common Checks

- `npm run check:stablecoin-data`
- `npm run check:generated-artifacts`
- `npm run check:doc-counts`
- Focused stablecoin registry tests under `shared/lib/__tests__`
