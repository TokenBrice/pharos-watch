# Stablecoin Data Agent Notes

Applies to `shared/data/stablecoins/**`.

## Read First

- `docs/classification.md`
- `docs/shadow-stablecoins.md` for PSI-only exclusions
- `docs/process/adding-a-stablecoin.md` when adding a new asset

## Rules

See root AGENTS.md / CLAUDE.md Hard Rules for cross-cutting rules. This file only documents stablecoin-data-specific items.

- Author base stablecoin metadata in `shared/data/stablecoins/coins/*.json`; research-domain fields live in sidecars under `shared/data/stablecoins/domains/<domain>/<id>.json`. The layout migration is finished — no base file carries a domain-owned field, so author domain research in the sidecar from the start (create it if absent).
- Supported sidecar domains are `reserves` (`reserves`, `reserveReview`, `custodyProfile`), `mint-authority` (`mintAuthority`), `compliance` (`mica`, `genius`), and `risk-review` (`blacklistabilityReview`, `oracleRisk`, `bridgeRouteRisk`). See `docs/process/stablecoin-research-sidecars.md`.
- In `bridgeRouteRisk`, a reviewed `bridge-representation` or `wrapped-representation` route referenced by structured controls must have a covering `bridge-mint` capability; if the minter cannot be identified, omit the route from every structured control's `routeRefs` so the conservative route-derived fallback remains scoreable. Otherwise the ownership gate reports `representation-route-without-bridge-mint`.
- Once a sidecar exists for a coin/domain, keep every field owned by that domain out of the matching base file. Edit future research in the sidecar; do not split coupled fields across both sources.
- Sidecar files must not live under `shared/data/stablecoins/coins/`. Sidecar `id` values must match the base coin ID, and duplicate fields across a base coin and sidecar are invalid.
- Use `npx tsx scripts/maintenance/migrate-stablecoin-sidecar.ts --domain <domain> --id <id> --dry-run` before layout migrations. The tool moves existing values only and proves the merged projection is unchanged.
- Run `npm run bootstrap:generated` after per-coin or sidecar edits. It refreshes the gitignored full, client, compliance, Telegram Mini App, and legacy redirect projections plus tracked dependent artifacts; do not edit generator outputs by hand.
- Keep `shared/data/stablecoins/report-card-registry-fingerprint.generated.ts` fresh too; it is a gitignored bootstrap projection refreshed by `npm run bootstrap:generated` and guarded with the rest of the graph by `npm run check:generated-artifacts`.
- In coordinated multi-agent batches, regenerate shared projections only after all source moves are complete; layout-only migrations must leave those projections byte-identical.
- The retired legacy category shards (`usd-major.json`, `usd-minor.json`, `non-usd.json`, `commodity.json`, `pre-launch.json`) are deleted. `npm run check:stablecoin-data` fails if any of those filenames reappears here.
- Author only non-default `flags`. The schema supplies `pegCurrency: "USD"`, `yieldBearing: false`, `rwa: false`, and `navToken: false` when absent; `backing` and `governance` are always required. Do not re-add a default value to a base coin file.
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
