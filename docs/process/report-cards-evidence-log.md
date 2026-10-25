# Safety Score Review Evidence Log

> **Agent navigation** — Historical review context only, not scoring input or a second methodology authority. [Dependency rulings](#dependency-rulings) · [Exit rulings](#exit-rulings) · [Supply identity review](#supply-identity-review) · [Publication calibration and cleanup](#publication-calibration-and-cleanup). Current contracts remain in the [implementation appendix](report-cards-appendix.md).

These records preserve review dates, scope limits and operator observations formerly embedded in the appendix. An undated record below means the source paragraph did not record a date; relocation does not establish one. Nothing here renews a review, proves current closure or authorizes a score, supply override or destructive cleanup. Consult current admitted evidence before applying a historical disposition.

The existing wrapper allocation/local-review schemas carry scoped rationale and observations, not a free-standing historical-ruling field. Per-asset measurement summaries are capture manifests, not review-note sidecars. These records therefore stay here rather than adding fields or unrelated history to score-bearing JSON.

## NAV Pricing Review — 2026-10-25

USYC's [reported fund share price](https://usyc.docs.hashnote.com/overview/token-price) and USDY's [issuer-administered primary conversion](https://docs.ondo.finance/developer-guides/usdy-instant-manager-integration) support privileged internal pricing with top-level applicability. Oracle publication does not establish independent valuation authority. These documentary reviews do not renew deployment controls, supply attribution, reserves or executable redemption evidence; same-notional capacity remains open.

YLDS remains unresolved. The [FCC prospectus](https://cdn.figure.com/docs/markets/fcc-prospectus.pdf), pages 11–14, defines fixed-face certificates, formula-based interest and reinvestment into additional certificates, expressly distinguishing them from fund shares redeemed at NAV. This does not establish discretionary share pricing or an implementation-specific SOFR feed. Reconcile its current NAV/fund classification with the fixed-face claim before authoring an oracle profile; issuer accrual accounting alone proves neither internal-pricing nor oracleless applicability.

## NAV Fund Pricing Reviews — 2026-10-25

JAAA and JTRSY now carry probable, source-backed `privileged-internal-pricing` reviews. Anemoy identifies the fund shares and redemption rails; Centrifuge documents [issuer-set primary NAV and separate batch execution pricing](https://docs.centrifuge.io/developer/protocol/guides/publish-nav-and-oracles/). Chronicle verification does not establish independent control over the fund valuation. The reviews classify fund-level pricing, without claiming current updater keys, relay wiring or signer independence.

ONyc carries the same tier at probable confidence: [issuer documentation](https://docs.onre.finance/technical-resources/token-configuration-and-reference.md) identifies contract-parameter NAV rather than external-feed authority. The issuer-linked [source at `c0490831`](https://github.com/onre-finance/onre-sol/blob/c0490831f438074562ebf51e437ca5f8e027596b/programs/onreapp/src/instructions/offer/add_offer_vector.rs) requires the State boss signer to change base-price/APR vectors. This source review does not establish deployed-binary correspondence, current boss membership or parameter values.

All three retain their same-notional Exit gaps: daily fund liquidity, a legal redemption entitlement, and ONyc's management liquidity target are not executable capacity. Existing bridge-materiality, custody, incident and reserve gaps are not closed or renewed. This is evidence curation under the existing methodology; local replay projections do not establish production acceptance.

## Vault Oracle And Backing Reviews — 2026-10-22

The primary-source vault review records privileged internal share-pricing paths for spUSDT, syrupUSDT, apyUSD, DUSD and hbUSDT, replacing local oracle U60 with measured45 when admitted. sUSDai, autoUSD, USD3 and USDN retain researched unresolved oracle profiles. New whole-direct-reserve reviews cover sUSDat, sYUSD, Umbrella stkGHO, Yearn v3 USDC and USDN; only Yearn's accounted idle USDC slice receives immediate native-asset liquidity. Independently dated sYUSD/stkGHO maturity facts describe open-ended staking claims, not cooldown length or immediate liquidity.

Equivalent existing EUTBL claim/NAV component reviews remain unchanged rather than duplicated. Custody, bridge, parent, incident, legal recovery and existing C/adverse constraints are not renewed or cleared. Date-only evidence keeps its admission clock; generated local inputs and schema/test checks are not captured-clock replay or production acceptance.

## Dependency Rulings

Current owner: [Dependency Coverage](report-cards-appendix.md#dependency-coverage).

### ctUSD

The retained implementation review identifies ctUSD as a pure fixed-unit M wrapper from independently verified deployed implementation. Parent, bridge, permissioned swap-out, intervention and upgrade risks remain. The source paragraph did not record the implementation review date; this is not a new review or a renewal of any separate legal/reserve evidence.

### USDK and XO — 2026-10-02

The October 2 review retained defaults: funded indexed M vaults and NoYield state did not establish exact deployed-source equivalence or pure-wrapper credit.

### sdUSD and legacy USDv — owner ruling 12

Owner ruling 12 preserved aggregate sdUSD parent treatment and legacy USDv's August scope rather than inferring current closure. The source paragraph did not give the ruling date or an August day/year; no fuller chronology is inferred here.

### sUSD1+

The retained `susd1plus-lorenzo` review uses dated primary-source-backed withholding because its mixed RWA/CeFi/DeFi book does not establish a measured whole-portfolio USD1 claim. Parent cap, price, supply, peg and lifecycle relationships remain. The source paragraph did not give the underlying review date.

## Exit Rulings

Current owner: [Exit Route Evidence](report-cards-appendix.md#exit-route-evidence).

### NUSD

The retained programme record pays 0.51 USDC per token (4,900 bps), with wallet acknowledgement, issuer-discretionary eligibility and a raw-capacity bounded-terms gap; its holder-exit incident remains. The source paragraph did not record a programme review date. This is the NUSD programme record formerly adjacent to the yUSD observation, not a new route or a refresh of its terms.

### yUSD and vyUSD — October 2 observation

The retained record treats yUSD's issuer route as unknown from the October 2 frontend pause observation, without an inferred onset, loss or suspension record; vyUSD is untracked. The source paragraph did not include a year or a stable asset ID, so this log does not infer either or join this observation to a similarly named asset's review.

### BRLV — owner ruling 12

Owner ruling 12 retained BRLV's reviewed 14-day modelled horizon despite disclosed T+3-business-day terms. The source paragraph did not record the ruling date. The modelled horizon is not a newly evidenced completed-settlement maximum.

### CGO and unavailable recovery

The retained record names CGO's physical-exit reader boundary and unavailable recovery as cases needing scoped cause proof. A/B is excluded, C/U remains bounded where applicable; neither establishes measured holder loss. The source paragraph did not record a review date.

## Supply Identity Review

Current owner: [Supply Attribution And In-Flight Accounting](report-cards-appendix.md#supply-attribution-and-in-flight-accounting).

### HyperEVM provider-origin identity pin

The provider-origin identity repair maps only source-pinned DefiLlama Hyperliquid rows for USDT, USDe, M0, frxUSD, rUSD, BOLD, FEUSD, USDXL and Monetrix USDM to their exact catalog HyperEVM ERC-20 deployments. The [global configuration at commit `43ea0e28655f7391e57ac687f84377c0bcf8a39a`](https://raw.githubusercontent.com/DefiLlama/peggedassets-server/43ea0e28655f7391e57ac687f84377c0bcf8a39a/src/peggedData/peggedData.ts) binds:

| Asset | Provider ID | Provider configuration | Contract |
| --- | --- | --- | --- |
| BOLD | 269 | `hyperliquid.bridgedFromETH` | `0x84533b1512a3a23f0c9668d88fdf86feffdbb11a` |
| FEUSD | 251 | `hyperliquid.issued` | `0x02c6a2fa58cc01a18b8d9e00ea48d65e4df26c70` |
| USDXL | 322 | `hyperliquid.issued` | `0xca79db4b49f608ef54a5cb813fbed3a6387bc645` |
| Monetrix USDM | 404 | `hyperliquid.issued` | `0xe2d2959f89b6389deb624bf076fe7d9e5401f377` |

The pinned [adapter resolver](https://raw.githubusercontent.com/DefiLlama/peggedassets-server/43ea0e28655f7391e57ac687f84377c0bcf8a39a/src/peggedAssets/utils/importAdapter.ts) uses inline `chainConfig` before module import, including Monetrix's generic issued read. [SDK 5.0.236 provider identity](https://unpkg.com/@defillama/sdk@5.0.236/build/providers.json) resolves that adapter chain to EVM chain 999.

The repair requires matching provider asset ID and contract identity, preserves captured raw rows, quantities and denominator, and does not rename genuine HyperCore USDC or infer HyperCore balances for FEUSD/USDXL. Competing HyperEVM routes remain ambiguous; other unproved chain labels keep their gaps. This is attribution identity correction, not a materiality threshold, exhaustive liability census or supply override. The source paragraph recorded these immutable pins, not a dated calibration capture.

## Publication Calibration And Cleanup

Current owner: [Canonical Publication](report-cards-appendix.md#canonical-publication).

### Live-reserve coverage floor — 2026-09-17

The 60% independent-live-reserve floor was calibrated against the production admission map on September 17: 173/212 admitted. The recorded structural rejections were monthly-attestation issuers older than the two-day freshness window, NAV-composition-unverified funds and undeterminable-freshness vaults. That capture explained the broad-feed-failure guard; it is not today's coverage census or a source-freshness policy override.

### Rateability floor — 2026-09-21

The September 21 decision retained an absolute `V9_MINIMUM_RATEABLE_ASSETS = 271` rateable-asset bootstrap floor rather than a fraction of the active registry. A ratio would move with unrelated catalog changes. The decision also required reviewing the constant on the catalog cadence and showing observed and required counts; those durable obligations remain in the current publication contract.

### Workflow experiment — terminal no-go 2026-10-08

The Workflow execution experiment received a terminal no-go decision on October 8. It was never a third authoritative stage. The paired cutover removed the drained heavy class/binding/implementation and observer-only suites; cron no longer triggered instances or neutral observer rows, and mode/status obligations were removed. Canonical publication and accepted replay were unchanged; the shadow-only replay-retention override was removed. Status and resource-deletion receipts remain in the [ordered operator sunset record](worker-infrastructure-appendix.md#safety-score-v9-workflow-shadow-pilot).

### Old publication keys and tables — October 7 inspection

The October 7 inspected production target already lacked both old `report-cards:v9-shadow` rollback keys and the four retired pre-activation tables. No pending old-key cleanup was observed there, and migration 0226 did not itself delete those keys. The source paragraph did not include a year. This observation proves nothing about restored or preview databases. Migration lineage and any newly discovered rows still require the current coordinated destructive-cleanup process; the Workflow's private `safety-score-v9:shadow:` prefix is a separate cleanup surface.
