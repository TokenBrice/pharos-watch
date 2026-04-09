# Curated Reserve Drift Review

Reviewed the four admin-reported reserve-score drifts on 2026-04-09 and compared current curated slices against the latest issuer-backed live disclosures.

## Decisions

- `aznd-mu-digital`: update curated reserves to `Short Term Cash 80.9% / Liquid Bonds 19.1%`
  - Source: `https://mu.accountable.capital:10443/dashboard`
  - Rationale: current Accountable `type` bucket is almost entirely short-term cash, so the previous all-high-risk bond/private-credit split was no longer a defensible fallback.
- `usn-noon`: update curated reserves to current deployment mix
  - Source: `https://cache.accountable.capital/dashboard/noon`
  - Breakdown used: `Private Credit 68.4% / CLOs 13.0% / DeFi Lending 8.0% / PTs 6.9% / US Treasury Bills 3.7%`
  - Rationale: the previous `40/30/20/10` reserve template materially overstated the low-risk sleeve versus the live deployment shown by Noon.
- `nusd-neutrl`: update curated reserves to `Stablecoin reserves 93.5% / OTC aggregate 3.4% / Other reserve assets 3.1%`
  - Sources: `https://cache.accountable.capital/dashboard/neutrl`, `https://app.neutrl.finance/portfolio`
  - Rationale: current Accountable `type_split` shows the reserve dominated by stablecoins, not the previous 60% high-risk delta-neutral / 20% stablecoin / 20% OTC template.
- `usdd-tron-dao-reserve`: update curated reserves to `TRX 62.5% / Smart Allocator 31.5% / PSM USDT 4.9% / sTRX 1.1%`
  - Sources: `https://app-api.usdd.io/data-platform/latest-collateral?chain=tron`, `https://docs.usdd.io/system-architecture/system-architecture`
  - Rationale: the old mix was stale versus the current live vault balances and still overweighted the Smart Allocator sleeve.

## Scope

Only curated reserve fallback metadata and the most obviously stale collateral descriptions were updated. No live-reserve adapter logic changed.
