# Stablecoin Issuer API Scan

> Research date: 2026-04-03
> Scope: active tracked stablecoins that do not already have Pharos-managed live reserve API support, with a secondary pass over coins still missing redemption backstop coverage.
> Purpose: find issuer- or protocol-operated machine-readable surfaces that could improve live reserve sync, redemption backstops, or adjacent telemetry.

## Current Coverage Baseline

- Active tracked stablecoins: 176
- Live reserve support already configured: 119
- Missing live reserve support: 57
- Redemption backstops already configured: 144
- Missing redemption backstops: 32

I prioritized the larger uncovered names first, then checked official websites, docs portals, transparency pages, and root-domain `llms.txt` files for the rest of the batch.

## Executive Take

The best immediate opportunities are not evenly distributed:

1. The clearest issuer-operated API surfaces are for mint/redeem and conversions, not reserve composition.
2. The strongest reserve-sync opportunities in the uncovered batch are mostly transparency dashboards or protocol-native/on-chain surfaces rather than clean issuer REST APIs.
3. `llms.txt` was less useful than expected in this cohort. Only Ondo and Moneta had clearly useful root-domain files in the higher-value uncovered set.

## Best Candidates

| Coin | Gap today | Confirmed surface | Best Pharos use | Confidence | Notes |
|---|---|---|---|---|---|
| `mxnb-juno` | live reserves + redemption | Juno docs for conversions between MXNB and USD stablecoins; MXNB transparency page | Redemption backstop first | High | Best clean fiat redemption rail in this scan. Official docs are current and Bitso/Juno-controlled. |
| `idrx-idrx` | live reserves + redemption | IDRX docs `getting-started` page; page source still references mint, redeem, bridge, rates, and additional-fee transaction endpoints | Redemption backstop first | Medium-high | Strong sign of a usable issuer API, but some deep-link docs URLs appear to have moved. Integration should start from the current docs index, not hard-coded old URLs. |
| `usdh-native-markets` | live reserves + redemption | USDH docs `Minting & Redeeming`; USDH transparency page | Redemption backstop first, reserve telemetry second | Medium-high | Official docs clearly support direct mint/redemption for institutions. Public reserve data likely exists, but may require dashboard endpoint discovery. |
| `usdm-moneta` | live reserves + redemption | `moneta.global/llms.txt`; Cardano-oriented developer and proof-of-reserve surfaces | Live reserve sync first | Medium | Promising because Moneta explicitly documents developer integration and daily proof-of-reserves, but I did not confirm a clean Moneta-native REST API in this pass. |
| `usr-resolv` | live reserves + redemption | Reserves dashboard at `info.apostro.xyz/resolv-reserves` | Live reserve sync first | Medium | Good transparency surface, but not yet a documented issuer API. Likely dashboard or on-chain adapter work rather than simple REST ingestion. |
| `usdz-anzen` | live reserves + redemption | Transparency page at `rwa.anzen.finance/transparency`; docs portal | Live reserve sync first | Medium | Feels workable as a validated single-bucket or dashboard-backed reserve source. Public API docs were not obvious. |
| `cusd-cap` | live reserves + redemption | Docs site plus reserve page `cap.app/vault/reserves/cUSD` | Live reserve sync first | Medium | The reserve page exists but returned `403` to basic fetches. Likely better treated as a browser-inspected dashboard or on-chain vault adapter than as a simple HTTP JSON API. |
| `satusd-river` | live reserves + redemption | River docs expose protocol SDK/docs surfaces | Other things | Low-medium | Best fit is quote, routing, or swap-preview telemetry, not reserve sync. I did not confirm a stable public REST endpoint in this pass. |

## Priority Recommendations

### P1: add issuer-backed redemption rails

These are the cleanest additions if the goal is practical user exit capacity rather than reserve composition.

#### `mxnb-juno`

- Official current docs page exists for conversions between MXNB and USD stablecoins.
- This is a strong fit for a redemption backstop adapter because the docs are about the actual conversion rail, not just a marketing page.
- The MXNB transparency page is also live, which makes this a possible two-surface coin:
  - redemption backstop from Juno conversion/mint docs
  - reserve sanity-check from transparency artifacts if the page exposes scrapeable holdings

Sources:

- https://docs.bitso.com/juno/docs/conversions-between-mxnb-and-usd-stablecoins
- https://mxnb.mx/transparency

#### `idrx-idrx`

- The current `getting-started` docs page is live.
- Its page source still references transaction routes for:
  - mint request
  - redeem request
  - bridge request
  - transaction rates
  - additional fees
- That is enough evidence to treat IDRX as a real redemption/backstop candidate.
- The main risk is docs churn: some old deep links now return `404`, so implementation should discover endpoints from the current docs index or API spec instead of relying on stale URLs.

Sources:

- https://docs.idrx.co/api/getting-started

#### `usdh-native-markets`

- The current docs page is titled `Minting & Redeeming` and describes direct minting/redemption for institutions and power users.
- The transparency page is live.
- This looks like the best uncovered candidate for a dual-track follow-up:
  - redemption backstop from the documented issuer rail
  - reserve telemetry from whatever JSON or page data powers the transparency page

Sources:

- https://docs.usdh.com/usdh/minting
- https://www.usdh.com/transparency

### P2: add transparency-backed reserve syncs

These are more likely to require scraping, JS-bundle inspection, or an on-chain adapter than a documented issuer REST API.

#### `usdm-moneta`

- Moneta has a useful root-domain `llms.txt`.
- The file explicitly points developers toward Cardano-native integration patterns for USDM.
- Moneta also advertises daily proof-of-reserves.
- Best interpretation: this is a good live reserve or solvency-verification lead, but probably not a simple issuer JSON feed.

Sources:

- https://moneta.global/llms.txt
- https://moneta.global/usdm

#### `usr-resolv`

- The public reserve dashboard is live.
- This is likely usable for reserve sync if the dashboard exposes a machine-readable JSON payload or a stable internal API.
- If not, it still looks strong enough to justify an on-chain or dashboard-backed adapter.

Sources:

- https://info.apostro.xyz/resolv-reserves
- https://docs.resolv.xyz/

#### `usdz-anzen`

- The transparency page is live.
- This is a plausible reserve-sync candidate for a single-bucket or attestation-style adapter if the page exposes stable data behind the UI.
- I did not find a clean public API spec in this pass.

Sources:

- https://rwa.anzen.finance/transparency
- https://docs.anzen.finance/

#### `cusd-cap`

- The reserve page exists, but direct fetch returned `403`.
- That usually means browser inspection or a first-party API call hidden behind the page is needed.
- If we want to pursue cUSD, the likely implementation path is:
  - inspect the page in a browser for hidden JSON/XHR calls, or
  - skip HTTP entirely and build against Cap's vault/oracle contracts

Sources:

- https://cap.app/vault/reserves/cUSD
- https://docs.cap.app/

### P3: useful for secondary telemetry, not primary reserve sync

#### `satusd-river`

- River documentation clearly exists, but I did not confirm a stable current REST docs path for the protocol SDK/API in this pass.
- satUSD still looks useful for:
  - quote previews
  - swap or redemption route modeling
  - protocol-routing telemetry
- It does not look like a better reserve-sync lead than Moneta, Resolv, USDH, or Anzen.

Sources:

- https://docs.river.inc/

## `llms.txt` Sweep

Useful in this pass:

- https://ondo.finance/llms.txt
- https://moneta.global/llms.txt

Mostly absent or not useful at the root domain for the higher-value uncovered batch:

- `ylds.com`
- `solstice.finance`
- `avalonfinance.xyz`
- `river.inc`
- `asterdex.com`
- `usecash.xyz`
- `cap.app`
- `standx.com`
- `usdh.com`
- `jupusd.money`
- `usdgo.com`
- `resolv.xyz`
- `anzen.finance`
- `mxnb.mx`
- `avenia.io`
- `idrx.co`

Conclusion: for uncovered stablecoins, `llms.txt` is worth checking first, but it is not yet a dependable discovery path.

## Negative Findings / Not Worth Prioritizing Right Now

These coins did not surface a clear public API advantage in this pass:

- `ousg-ondo-finance`
  - useful `llms.txt`, but Pharos already notes public oracle access is still not open enough for the reserve path we want
- `ousd-origin-protocol`
  - prior public collateral API was already deprecated in Pharos provenance notes
- `ylds-figure`
- `usx-solstice`
- `usda-avalon`
- `usdf-astherus`
- `cash-phantom`
- `dusd-standx`
- `usdgo-osl`
- `brla-brla-digital`
- `usdkg-gold-dollar`

That does not mean they are impossible. It means this pass did not uncover a strong issuer-run machine-readable surface that beats other priorities.

## Recommended Next Pass

1. Build `mxnb-juno` redemption backstop support first.
2. Build `idrx-idrx` redemption backstop support next, but resolve docs/index discovery first so the integration does not depend on stale deep links.
3. Inspect `www.usdh.com/transparency` and `rwa.anzen.finance/transparency` with a browser or bundle/network trace to find stable JSON payloads.
4. Inspect `cap.app/vault/reserves/cUSD` with browser automation because the page is fetch-blocked.
5. Evaluate `usdm-moneta` as a Cardano-native reserve/proof adapter rather than as a conventional HTTP API integration.

## Source Notes

- Existing Pharos live reserve adapter registry: `worker/src/cron/reserve-adapters/index.ts`
- Existing Pharos provenance notes include:
  - Origin OUSD public collateral API deprecation
  - Ondo OUSG reserve config held back pending public oracle access
