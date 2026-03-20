# Pricing Breaker Investigation - 2026-03-20

## Scope

Investigated the three open pricing fallback circuit breakers shown on the ops status surface:

- `coinmarketcap-prices`
- `jupiter-prices`
- `dexscreener-prices`

Goal: determine whether they represent a transient upstream flap already contained by the current flow, or whether they indicate a fix is needed.

## Live Findings

Production `GET /api/health` at `2026-03-20T13:17:43Z` showed:

- `coinmarketcap-prices`: `open`, `consecutiveFailures = 6`, `lastSuccessAt = 1774000854` (`2026-03-20T10:00:54Z`), `openedAt = 1774012604` (`2026-03-20T13:16:44Z`)
- `jupiter-prices`: `open`, `consecutiveFailures = 14`, `lastSuccessAt = null`, `openedAt = 1774012605` (`2026-03-20T13:16:45Z`)
- `dexscreener-prices`: `open`, `consecutiveFailures = 7`, `lastSuccessAt = 1774000856` (`2026-03-20T10:00:56Z`), `openedAt = 1774012607` (`2026-03-20T13:16:47Z`)

These timestamps matter because the breaker only allows a half-open probe every 30 minutes. The sources were still open after the next eligible probe window, so this is not "already recovered".

## User-Facing Impact

Current impact is contained:

- `/api/stablecoins` remains fresh
- only `5 / 376` assets are currently missing a price (`~1.3%`)
- `0` assets currently have `priceSource` of `coinmarketcap`, `jupiter`, or `dexscreener`
- the only live `fallback` prices right now are `cached`, not these three sources

Conclusion: this is not currently breaking the public stablecoin payload, but it is not a harmless one-off either.

## Source-by-Source Assessment

### CoinMarketCap

- Fallback-only source, not part of primary consensus
- Had a same-day success at `2026-03-20T10:00:54Z`
- Began failing afterward and failed again on the most recent half-open probe

Assessment:

- persistent as of the investigation window
- likely upstream/runtime/auth/quota related rather than a clear code-regression signal from this repo alone
- operator follow-up should inspect production worker logs for exact response status/body around the failed probes

### DexScreener

- Fallback-only source, not part of primary consensus
- Had a same-day success at `2026-03-20T10:00:56Z`
- Reopened again on the latest half-open probe
- Direct live request from this environment to `https://api.dexscreener.com/latest/dex/search?q=USDT` returned `200`

Assessment:

- persistent in production during this window
- not obviously a repo-level request-shape bug
- more likely a worker-runtime-specific upstream failure, intermittent blocking, or transient transport issue that has not yet cleared

### Jupiter

- Fallback-only source, not part of primary consensus
- Has never recorded a success in production (`lastSuccessAt = null`)
- Direct live requests from this environment to Jupiter V3 returned `200`, including a 35-mint batch compatible with the repo's current `ids=` request shape
- Official Jupiter V3 docs (`https://dev.jup.ag/docs/price/v3`) describe `blockId` as the recency field and do not document `createdAt` as the freshness signal
- Current code in `worker/src/cron/enrich-prices-passes.ts` rejects entries when `createdAt` is older than 1 hour
- Sample live Jupiter responses observed during investigation included valid `usdPrice` + liquidity values but `createdAt` timestamps months old; with the current gate, all sampled entries would be rejected

Assessment:

- this path does command a code fix
- even when transport succeeds, the current freshness gate is likely invalid for Price API V3 and can suppress otherwise usable Jupiter fallbacks

## Workspace Follow-Up Applied

Local workspace fix applied after the investigation:

- removed the Jupiter fallback's `createdAt` age rejection in `worker/src/cron/enrich-prices-passes.ts`
- upgraded DexScreener fallback to prefer exact chain+address token-pool lookups before symbol search
- added a regression test covering old `createdAt` metadata in `worker/src/cron/__tests__/enrich-prices.test.ts`
- added DexScreener exact-lookup coverage in `worker/src/cron/__tests__/enrich-prices.test.ts`
- documented the V3 recency semantics and DexScreener fallback ordering across pricing-pipeline docs and methodology version metadata

## Recommended Follow-Up

1. Deploy the Jupiter fallback fix and watch the next production probe window to see whether `jupiter-prices` starts closing normally.
2. Keep CMC and DexScreener as operational investigations first unless logs reveal a request-shape bug.
