## Funding Update — Extended Reference

Material moved verbatim from `SKILL.md`: API tier details, deprecation history, error-response samples, and rare edge cases.

### CoinGecko key tiers

Works against both hosts — check which tier you have:

  - **Pro key:** `https://pro-api.coingecko.com/api/v3` with header `x-cg-pro-api-key`
  - **Demo/Analyst key:** `https://api.coingecko.com/api/v3` with header `x-cg-demo-api-key`

If a demo-host call returns `error_code:10010` ("please change your root URL"), swap to the Pro host (same key).

### API history and error samples

- Gnosis: The legacy `api.gnosisscan.io` endpoints were deprecated in favor of this single multi-chain API. (The legacy `api.gnosisscan.io` V1 endpoints return `{"status":"0","result":"You are using a deprecated V1 endpoint"}`.)
- Alchemy, on base/optimism/arbitrum: adding `"internal"` returns `{"code":-32602,"message":"The 'internal' category is only supported for ETH and MATIC."}`.

### Edge cases

- If any chain ever exceeds 1,000 transfers, add `"fromBlock": "0x<recent-block-hex>"` to that call.
