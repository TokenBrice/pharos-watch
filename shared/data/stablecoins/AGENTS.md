# Stablecoin Data Agent Notes

Applies to `shared/data/stablecoins/**`.

## Read First

- `docs/classification.md`
- `docs/shadow-stablecoins.md` for PSI-only exclusions
- `docs/process/adding-a-stablecoin.md` when adding a new asset

## Rules

See root AGENTS.md / CLAUDE.md Hard Rules for cross-cutting rules. This file only documents stablecoin-data-specific items.

- Author base stablecoin metadata in `shared/data/stablecoins/coins/*.json`; migrated research-domain fields live in sidecars under `shared/data/stablecoins/domains/<domain>/<id>.json`.
- Supported sidecar domains are `reserves` (`reserves`, `reserveReview`, `custodyProfile`), `mint-authority` (`mintAuthority`), `compliance` (`mica`, `genius`), and `risk-review` (`canBeBlacklisted`, `blacklistabilityReview`, `oracleRisk`, `bridgeRouteRisk`). See `docs/process/stablecoin-research-sidecars.md`.
- Once a sidecar exists for a coin/domain, keep every field owned by that domain out of the matching base file. Edit future research in the sidecar; do not split coupled fields across both sources.
- Sidecar files must not live under `shared/data/stablecoins/coins/`. Sidecar `id` values must match the base coin ID, and duplicate fields across a base coin and sidecar are invalid.
- Use `npx tsx scripts/maintenance/migrate-stablecoin-sidecar.ts --domain <domain> --id <id> --dry-run` before layout migrations. The tool moves existing values only and proves the merged projection is unchanged.
- Regenerate `shared/data/stablecoins/coins.generated.json` with `tsx scripts/maintenance/generate-stablecoin-per-coin-asset.ts` after per-coin or sidecar edits. Do not edit generated registry artifacts by hand.
- Keep the client, prevalidated, and legacy redirect projections fresh too: `shared/data/stablecoins/coins.client.generated.json`, `shared/data/stablecoins/coins.prevalidated.generated.ts`, and `shared/data/stablecoins/legacy-llama-redirects.generated.json` are generated from the same per-coin catalog and guarded by `npm run check:generated-artifacts`.
- In coordinated multi-agent batches, regenerate the full/client/compliance/prevalidated/redirect artifacts only after all source moves are complete; layout-only migrations must leave those projections byte-identical.
- Treat `usd-major.json`, `usd-minor.json`, `non-usd.json`, `commodity.json`, and `pre-launch.json` as read-only compatibility shells. They should remain empty, and `npm run check:stablecoin-data` guards that layout.
- Keep `canonical-order.json` aligned with the per-coin catalog.
- Add or update contracts only when the address is verified against the relevant source.
- Keep manual `dependencies` only for relationships that reserve composition cannot express. Manual-only relationships require an exact sourced `dependencyReview`; reserve-linked relationships must not be duplicated manually.
- Use `reserveReview.nonLinkDispositions` to disposition reviewed unlinked reserve slices. The stored index and name must match the current slice, and candidate IDs do not create graph edges.
- Keep `proofOfReserves.latestReport` in the base coin file. Put custody evidence in the reserves sidecar, omit undisclosed provider shares, and use explicit `unknown` safeguards instead of inference.
- Structured reserve facts must be source-supported. Do not convert weighted-average maturity into `maturityDaysMax`, preserve unsupported category percentages, or force a mixed basket into a single asset class.
- If adding a data source, update the about page and source docs.
- If classification or methodology semantics change, update the relevant methodology doc and structured changelog.

## Common Checks

- `npm run check:stablecoin-data`
- `npm run check:generated-artifacts`
- Focused stablecoin registry tests under `shared/lib/__tests__`
