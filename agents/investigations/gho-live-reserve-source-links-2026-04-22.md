# GHO live reserve source-link audit — 2026-04-22

## Scope

- Investigate the `Source` link shown in the stablecoin-detail reserve card for `gho-aave`.
- Check whether the issue is isolated or part of a broader live-reserve source-link pattern.

## What the UI actually uses

- The reserve card footnote renders `reserves.displayUrl` as the clickable `Source` link in `src/components/stablecoin-detail/overview-section.tsx`.
- `displayUrl` comes from `GET /api/stablecoin-reserves/:id`.
- The worker resolves that field from `meta.liveReservesConfig.display.url` in `worker/src/lib/live-reserves-store-response.ts`.
- The reserve-card source link is therefore static metadata, not a runtime-derived pointer to the latest adapter evidence.

## GHO-specific finding

- `gho-aave` was configured with `liveReservesConfig.display.url = "https://aave.com/gho"` in `shared/data/stablecoins/usd-major.json`.
- The GHO adapter itself is on-chain. It reads total supply, facilitator state, and tracked GSM module state in `worker/src/cron/reserve-adapters/gho.ts`.
- `https://aave.com/gho` is a high-level GHO product page. It describes GHO conceptually, but it does not expose the reserve/facilitator composition that the Pharos reserve card displays.
- Aave's TokenLogic analytics surface at `https://aave.tokenlogic.xyz/gho` is materially closer to the displayed reserve view: the page advertises GHO metrics including collateral, and its UI includes sections for collateral composition and GHO facilitators.

## Broader pattern

- The issue is broader than Aave, but it is not uniform across the live-reserve system.
- Many dashboard/attestation adapters already point to good transparency pages:
  - `circle-transparency` -> `https://www.circle.com/transparency`
  - `mento` -> `https://reserve.mento.org/`
  - `accountable` -> issuer-specific Accountable proof-of-solvency pages
  - `m0` -> `https://dashboard.m0.org/`
  - `openeden-usdo` -> `https://openeden.com/usdo/transparency`
- The weaker class is mostly protocol-native / on-chain adapters where `display.url` often points to a docs page, app homepage, or product landing page rather than the closest evidence surface.

## Representative examples of the broader gap

- `gho-aave` (`gho` adapter): was using `https://aave.com/gho` even though the adapter is built from on-chain facilitator and GSM reads.
- `lusd-liquity` (`liquity-v1` adapter): currently points to `https://www.liquity.org/`, while the adapter metadata already records more specific redemption docs URLs.
- Several `liquity-v2-branches` coins point to protocol sites or generic docs, while the adapter itself is on-chain.
- Some wrappers and vault-style feeds use product/docs pages because there is no dedicated public reserve dashboard.

## Systemic limitation

- Some adapters already attach more specific URLs under `metadata.redemption.sourceUrls`, but the reserve API does not expose those URLs as the reserve-card `Source` link.
- This means the frontend cannot currently distinguish:
  - a manually curated display page
  - a runtime evidence URL emitted by the adapter
  - a redemption-route source URL that is useful context but not the full reserve source

## Change made

- Updated `gho-aave` `liveReservesConfig.display.url` from `https://aave.com/gho` to `https://aave.tokenlogic.xyz/gho`.

## Why I stopped there

- The GHO metadata fix is low-risk and directly addresses the user-visible defect.
- A full solution for the broader issue would require deciding whether the reserve card should keep using a manually curated display URL, prefer adapter-emitted evidence URLs when available, or support multiple source links. That is a broader product/API contract change, not a surgical metadata correction.
