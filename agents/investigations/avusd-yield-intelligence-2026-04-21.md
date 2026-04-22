# AVUSD Yield Intelligence Investigation - 2026-04-21

## Question

Production screenshot showed the `Yield Intelligence` section on `/stablecoin/avusd-avant/` rendering only the section shell/loading skeleton.

## Checks

- Public same-origin rankings endpoint:
  - `https://pharos.watch/_site-data/yield-rankings`
  - AVUSD is present.
  - Latest uncached response checked during investigation:
    - `updatedAt`: `1776774048`
    - `_meta.updatedAt`: `1776774074`
    - `_meta.ageSeconds`: `665`
    - `currentApy`: `13.488272702027837`
    - `apy30d`: `8.798738276829056`
    - `yieldSource`: `Pendle: Avant Protocol avUSD`
    - `sourceKey`: `protocol-api:pendle:ethereum:0xf968b785b4bfd5a6c0fc197b42264beeecf58d85`
    - `altSources.length`: `1`
- Public same-origin history endpoint:
  - `https://pharos.watch/_site-data/yield-history?stablecoin=avusd-avant&days=90&mode=best`
  - Uncached response contained `1675` rows and current row at `1776774048`.
  - Cached response can lag the newest row by the one-hour slow cache profile, but still contains non-empty AVUSD history.
- Remote D1 read:
  - `yield_data` contains two AVUSD rows:
    - best `protocol-api` Pendle source at `13.488272702027837` current APY.
    - alternative DeFiLlama savUSD source at `0` current APY.
  - `yield_history` contains AVUSD rows for multiple source keys, including the current Pendle source and the savUSD alternative.
  - latest `sync-yield-data` cron rows are `ok`.
- Browser reproduction:
  - Playwright on `https://pharos.watch/stablecoin/avusd-avant/` fetched:
    - `/_site-data/yield-rankings` -> `200`
    - `/_site-data/yield-history?stablecoin=avusd-avant&days=90&mode=best` -> `200`
  - Rendered section text included:
    - `Current APY 13.49%`
    - `30D APY 8.79%`
    - `Yield Source Pendle: Avant Protocol avUSD`
    - `Alternative Sources Avant savings (savUSD) 0.00%`
  - Console errors observed were unrelated Google Tag Manager image CSP blocks.
- Runtime schema validation:
  - Production rankings JSON validates against `YieldRankingsResponseSchema`.
  - Production AVUSD history JSON validates against `YieldHistoryResponseSchema`.
- Targeted tests:
  - `src/components/__tests__/yield-detail-section.test.tsx` passed.
  - `worker/src/api/__tests__/yield-history.test.ts` and `worker/src/api/__tests__/yield-rankings.test.ts` passed.

## Conclusion

The production data path is healthy now. AVUSD yield data exists in D1, is present in `/api/yield-rankings`, is present in `/api/yield-history`, validates against the client schemas, and renders in a live browser.

The screenshot matches the `YieldDetailSection` loading branch, not the empty-history branch:

- `src/components/yield-detail-section.tsx` renders that skeleton when `useYieldDetailSectionModel()` returns `status: "loading"`.
- `src/components/yield-detail-section-model.ts` returns `loading` when the coin is statically yield-bearing and `useYieldRankings()` has not produced data yet.
- Therefore the pictured state means the client had not completed `/_site-data/yield-rankings` at screenshot time, or the browser/runtime was prevented from completing that request or hydrating the component.

This was not reproduced from the current production host. If the issue recurs, capture browser network and console output around `/_site-data/yield-rankings`; that is the gating request for leaving the skeleton state.

## Scope

Current rankings include AVUSD and 83 total rows. Among active `flags.yieldBearing` coins, only `ftusd-flying-tulip` and `usbd-bima` are missing current ranking rows. Those would render the explicit "Yield tracking is expected..." unavailable message after rankings load; they should not render the blank skeleton state unless `yield-rankings` is still loading.
