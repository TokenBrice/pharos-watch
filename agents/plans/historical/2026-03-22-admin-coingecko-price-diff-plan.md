# Admin CoinGecko Price Diff Plan

## Goal

Add an `/admin/` pipeline section that flags tracked assets with a CoinGecko listing where the live CoinGecko spot price differs from the current Pharos reported price by more than 5%.

## Implementation outline

1. Extend the shared `/api/status` contract with a best-effort `coingeckoPriceDiff` subsection and matching `sectionErrors` key.
2. Load the subsection in the worker status supplements by reading the cached tracked asset list, batching CoinGecko `simple/price` lookups, and sorting flagged assets by percentage difference.
3. Render the new data in the admin pipeline lane with an operator-readable card and update the status-surface docs.
