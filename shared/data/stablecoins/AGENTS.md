# Stablecoin Data Agent Notes

Applies to `shared/data/stablecoins/**`.

## Read First

- `docs/classification.md`
- `docs/shadow-stablecoins.md` for PSI-only exclusions
- `docs/process/adding-a-stablecoin.md` when adding a new asset

## Rules

- Author stablecoin metadata in `shared/data/stablecoins/coins/*.json`; this directory is the editable source of truth.
- Regenerate `shared/data/stablecoins/coins.generated.json` with `tsx scripts/generate-stablecoin-per-coin-asset.ts` after per-coin edits. Do not edit the generated aggregate by hand.
- Treat `usd-major.json`, `usd-minor.json`, `non-usd.json`, `commodity.json`, and `pre-launch.json` as read-only compatibility shells. They should remain empty, and `npm run check:stablecoin-data` guards that layout.
- Keep `canonical-order.json` aligned with the per-coin catalog.
- Do not add manual, on-chain, CMC, or DEX supply overrides. Primary supply is DefiLlama with the existing fallback path only.
- DefiLlama list endpoint `circulating` values are already USD-denominated; do not multiply them by price.
- Add or update contracts only when the address is verified against the relevant source.
- If adding a data source, update the about page and source docs.
- If classification or methodology semantics change, update the relevant methodology doc and timeline.

## Common Checks

- `npm run check:stablecoin-data`
- `npm run check:doc-counts`
- Focused stablecoin registry tests under `shared/lib/__tests__`
