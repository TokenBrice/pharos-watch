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

### Known non-donation patterns

The skill is memoryless on discarded spam, so recurring non-donations re-surface every run. Recognize and discard these without re-triaging:

- **Founder bridge-ins via LI.FI**: clusters of USDC transfers arriving from the LI.FI router / relayer contracts (first seen 2026-05-18, ~$2,101 total) are the founder bridging funds to the wallet, not donations. Discard on every reappearance; do not record them as `founder` rows.
- **Giveth payouts** arrive from the Giveth payout contract and are real donations — `kind: "pool"`, `display: "via Giveth"` (see Step 5).

When a new recurring non-donation pattern is confirmed with the user, add it here instead of relying on session memory.
