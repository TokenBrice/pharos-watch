# GeckoTerminal Follow-Up Investigation

Date: 2026-03-22

## Scope

Investigate the remaining `geckoterminal-probe` breaker after the breaker-accounting fix was deployed, and determine what a sensible follow-up pass should target.

## Production Observations

- Patched worker deployment went live at `2026-03-22 11:28:06 UTC`.
- During the next eligible quarter-hourly run (`2026-03-22 11:30 UTC` slot), the GT probe half-opened and reopened:
  - `geckoterminal-probe: open -> half-open (probe allowed)`
  - `geckoterminal-probe: half-open -> open (probe failed, 6 consecutive failures)`
- Tail logs showed both probe requests returned `429` from GeckoTerminal:
  - `https://api.geckoterminal.com/api/v2/networks/eth/tokens/0x4274cd7277c7bb0806bd5fe84b9adae466a8da0a/pools?page=1`
  - `https://api.geckoterminal.com/api/v2/networks/eth/tokens/0xe07f9d810a48ab5c3c914ba3ca53af14e4491e8a/pools?page=1`
- Probe summary from the same run:
  - `Probed 2 assets`
  - `0 prices obtained`
  - `0 lookup misses`
  - `2 upstream errors`

This confirms the accounting fix worked as intended: the breaker is now reopening on real upstream throttling, not on token-level `404` / `422` misses.

## Candidate Set Size

The live system currently has many `single-source + coingecko` assets, but only **2** of them are actually GT-probe-eligible under current code:

- `yusd-aegis`
- `gyd-gyroscope`

This matters because the remaining issue is not self-inflicted by a large probe set. The entire GT probe currently emits only two live requests.

## Probe Value

The probe is still useful for the two eligible assets.

### `yusd-aegis`

Direct GT public response currently returns a usable pool-level price around `0.9981` from a high-TVL Ethereum pool (`~$828K` TVL).

### `gyd-gyroscope`

Direct GT public response currently returns a usable pool-level price around `1.0027` from a high-TVL Ethereum pool (`~$19.5M` TVL).

This is especially relevant because the fresh `dex_prices` row for `gyd-gyroscope` currently comes from Balancer direct API at roughly `0.8480` with `~$18.3M` TVL and is being suppressed in primary pricing as an uncorroborated promoted DEX source. The GT probe is the only current live path that can plausibly corroborate or challenge the CoinGecko price near parity.

## Existing Data Reuse Check

I checked whether the GT probe could simply stop doing live fetches and reuse existing D1-backed DEX data.

### `yusd-aegis`

- `dex_pool_staging` contains `cg_onchain` pools with good prices near parity.
- But the staged rows are stale: latest `refreshed_at = 1774044465` (`2026-03-20 22:07:45 UTC`).
- No fresh `dex_prices` row exists for `yusd-aegis`.
- No fresh published challenger row exists for `yusd-aegis`.

Conclusion: stored data is not fresh enough to cleanly replace the live GT probe.

### `gyd-gyroscope`

- Fresh `dex_prices` and challenger data exists, but it is the same Balancer-based `~0.848` signal already being suppressed.
- No `dex_pool_staging` rows currently exist for `gyd-gyroscope`.

Conclusion: existing stored DEX data does not replace the GT probe for `gyd-gyroscope`; it is exactly the conflicting source the probe is meant to arbitrate against.

## Local Reproduction Checks

From this machine, the same GT pool URLs returned `200`, not `429`, using the worker-style headers:

- `User-Agent: Pharos/1.0 (stablecoin analytics)`
- `Accept: application/json`

The public GT multi-token endpoint also returned `200` for both addresses, but it is not a full substitute:

- `YUSD` returned a usable token price near parity.
- `GYD` returned `price_usd = null` even though `total_reserve_in_usd` was large.

Conclusion: the mismatch appears to be Worker-edge/provider-path specific rather than a universally broken endpoint.

## Cron / Contention Check

The GT probe is not contending with other GeckoTerminal-heavy jobs inside the same trigger slot.

- Quarter-hourly slot runs sequentially: `sync-stablecoins -> snapshot-supply -> snapshot-chain-supply -> sync-fx-rates -> status-self-check`
- DEX discovery GT traffic runs on `6,36 * * * *`
- DEX-liquidity GT traffic runs on `10,40 * * * *`

So the `11:30` GT probe failure was not caused by another in-slot GT fetch burst from this worker.

## Current Probe Fragility

The GT probe is currently brittle relative to how little it does:

- `2s` spacing between requests
- `5s` timeout per request
- `0` retries (`fetchWithRetry(..., 0)`)

That means a transient Worker-edge `429` on both assets immediately reopens the breaker for another 30 minutes.

## Official Provider Guidance

Official GeckoTerminal docs currently say:

- Public API rate limit is `30 calls/minute`
- Public API is beta
- the same on-chain DEX data is available via CoinGecko paid `/onchain` endpoints
- paid CoinGecko plans are the recommended way to get higher rate limits for GeckoTerminal-backed data

Sources:

- https://apiguide.geckoterminal.com/faq
- https://apiguide.geckoterminal.com/
- https://apiguide.geckoterminal.com/authentication

## Recommended Follow-Up Options

### Option A: Minimal hardening, best first pass

Keep the existing GT public pool probe, but make it resilient enough for transient Worker-edge throttling.

Suggested changes:

- increase GT probe fetch retries from `0` to `1` (or `2`)
- keep `429` handling inside `fetchWithRetry`
- consider slightly relaxing the per-request timeout if needed
- persist GT probe stats into `sync-stablecoins` cron metadata

Why this is the best first pass:

- smallest change set
- preserves current methodology and source semantics
- directly addresses the observed failure mode
- cheap enough because the live probe only targets 2 assets

### Option B: Prefer authenticated CoinGecko `/onchain` pools when available

When `COINGECKO_API_KEY` is configured and the chain has a CoinGecko on-chain mapping, prefer `fetchCgTokenPools(...)` for the probe and fall back to public GT only when needed.

Why this is attractive:

- follows official provider guidance
- likely improves rate-limit headroom
- production already has a working CoinGecko on-chain path elsewhere

Tradeoffs:

- broader code change because the GT probe must accept `coingeckoApiKey`
- methodology/source wording should be updated because the transport surface changes
- may still not help assets like `gyd-gyroscope` if CoinGecko on-chain coverage is empty for that token

### Option C: Hybrid fallback on alternative success signals

Examples:

- use GT multi-token response for assets where it returns a usable price
- use fresh published challenger data when it exists and is suitable

This is possible but weaker as a first pass:

- `GYD` multi-token price is currently `null`
- current challenger data does not replace the live GT signal
- adds complexity without directly fixing the observed public GT `429`

## Recommendation

If doing one follow-up pass now, implement **Option A** first:

1. add `1` retry for the GT probe fetches
2. persist GT probe stats into `sync-stablecoins` metadata for post-run diagnosis

If GT still reopens after that, the next escalation should be **Option B**:

- prefer authenticated CoinGecko `/onchain` pool fetches where available
- fall back to public GT only for uncovered paths
