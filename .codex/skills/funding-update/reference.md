## Funding Update — Extended Reference

Material moved verbatim from `SKILL.md`: API tier details, deprecation history, error-response samples, and rare edge cases.

### CoinGecko key tiers

Works against both hosts — check which tier you have:

  - **Pro key:** `https://pro-api.coingecko.com/api/v3` with header `x-cg-pro-api-key`
  - **Demo/Analyst key:** `https://api.coingecko.com/api/v3` with header `x-cg-demo-api-key`

If a demo-host call returns `error_code:10010` ("please change your root URL"), swap to the Pro host (same key).

### API history and error samples

- Gnosis: The legacy `api.gnosisscan.io` endpoints were deprecated in favor of this single multi-chain API. (The legacy `api.gnosisscan.io` V1 endpoints return `{"status":"0","result":"You are using a deprecated V1 endpoint"}`.)
- Alchemy `"internal"`: **base now supports it** (verified 2026-08-05, returns results). Only optimism and arbitrum still reject it, with `{"code":-32602,"message":"The 'internal' category is not supported for this network."}`. The older error text naming "ETH and MATIC" is stale.
- Etherscan V2 free tier refuses optimism and base entirely: `{"status":"0","message":"NOTOK","result":"Free API access is not supported for this chain. Please upgrade your api plan for full chain coverage."}`. Arbitrum (`chainid=42161`) and Gnosis (`chainid=100`) work on the free tier.
- Blockscout optimism `txlistinternal` returns `{"status":"2","message":"Some internal transactions within this block range have not yet been processed"}` with an empty result — **not** a trustworthy zero.

### Edge cases

- If any chain ever exceeds 1,000 transfers, add `"fromBlock": "0x<recent-block-hex>"` to that call.

### Known non-donation patterns

The skill is memoryless on discarded spam, so recurring non-donations re-surface every run. Recognize and discard these without re-triaging:

- **Safe self-swaps via LI.FI / Jumper** (corrected 2026-08-05): transfers arriving from the LI.FI router `0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae` and similar aggregator contracts are the **Safe swapping its own holdings**, not the founder bridging funds in, and not donations. An earlier version of this note called them "founder bridge-ins"; decoding the calldata disproved that. Discard on every reappearance, and never record them as `founder` rows.

  Two confirmed instances, both caught by Step 3a:

  | Tx | What it actually is | Converts |
  |---|---|---|
  | arbitrum `0x928f0f92…4acf` (2026-05-18) | Safe `execTransaction` approving 10 USDT to LI.FI and taking 0.0047 ETH back | the 10 USDT already logged as `0x44691e9c` |
  | optimism `0x20aa5e39…d99d` (2026-05-18) | Safe `execTransaction`; receipt shows 5.000000 USDT out (`0x94b008aa…8e58`) and 4.996845 USDC in | the sprnodes.eth 5 USDT already logged as `0xdb94a59a` |

  Both would have double-counted donations already in the ledger. Note the near-identical timestamps — the Safe tends to batch this housekeeping, so expect these in clusters rather than singly.

- **Giveth payouts** arrive from the Giveth payout contract and are real donations — `kind: "pool"`, `display: "via Giveth"` (see Step 5).

When a new recurring non-donation pattern is confirmed with the user, add it here instead of relying on session memory.

### Open backfill — Base internal ETH (unresolved)

Five inbound ETH transfers on Base were never logged, because runs before 2026-08-05 dropped Alchemy's `internal` category on that chain. All arrived from `0x7a5d2a00a25b95fd8739bc52cd79f8f971c37ca1` (a bridge/solver contract), so the true donors are upstream and unattributed:

| Date | Amount | USD at receipt |
|---|---|---|
| 2026-04-27 | 0.03 ETH | $71.07 |
| 2026-05-07 | 0.0005 ETH | $1.18 |
| 2026-05-08 | 0.001 ETH | $2.29 |
| 2026-05-11 | 0.01 ETH | $23.70 |
| 2026-05-11 | 0.0005 ETH | $1.18 |

**~$99.42 total.** The user chose on 2026-08-05 to leave these out rather than log them to a bridge address. They sit below the Base cursor, so no future run will surface them on its own — this note is the only record. Revisit only if the user asks, and attribute to origin EOAs rather than the solver if so. Not verified as donations; they could also be Safe bridge activity, which would need the Step 3a decode before any of it is logged.
