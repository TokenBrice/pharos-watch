## Yield Risk-Free Benchmark Alignment Plan

Date: 2026-03-26

### Goal

Align Yield Intelligence benchmarks to currency-specific risk-free cash rates:

- USD: keep `USD 3M T-Bill`
- EUR: replace overnight `€STR` with `EUR 3M compounded €STR`
- CHF: replace `CHF SNB policy rate (proxy)` with `CHF 3M compounded SARON`

### Verified Source Strategy

- USD remains unchanged:
  - Primary: FRED `DGS3MO`
  - Fallback: Treasury XML
- EUR will use the official ECB 3-month compounded €STR CSV:
  - `https://data-api.ecb.europa.eu/service/data/EST/B.EU000A2QQF32.CR?lastNObservations=5&format=csvdata`
  - Verified live row shape includes `TIME_PERIOD` and `OBS_VALUE`
- CHF will use public delayed SIX `SAR3MC`:
  - Metadata page: `https://indexdata.six-group.com/pro/swiss_reference_rates/compound_rates.html?_format=json`
  - Download path discovered from metadata: `/saron/h_sar3mc_delayed.csv`
  - Fetch workflow verified:
    1. `POST https://indexdata.six-group.com/pro/oauth/token`
    2. form body `grant_type=client_credentials&client_id=default_consumer&scope=api_authentication`
    3. browser-style `Origin`, `Referer`, and `User-Agent` headers required
    4. use bearer token with `POST https://indexdata.six-group.com/pro/api/report-download`
    5. JSON body `{"furl":"https://indexdata.six-group.com/download/saron/h_sar3mc_delayed.csv"}`
  - Verified latest delayed CSV row on 2026-03-26: `25.03.2026;...;SAR3MC;-0.0539`

### Implementation Scope

1. Worker benchmark fetcher
- Update benchmark constants for the EUR series and SIX endpoints
- Replace the SNB policy-rate parser with:
  - SIX guest-token fetch
  - report-download CSV fetch
  - SAR3MC CSV parser
- Keep existing retained-last-market fallback semantics for EUR and CHF
- Remove the obsolete FRED overnight `€STR` fallback path

2. Benchmark metadata and labels
- Update benchmark registry labels to:
  - `EUR 3M compounded €STR`
  - `CHF 3M compounded SARON`
- Mark CHF as non-proxy
- Preserve existing row-level benchmark selection logic by peg currency

3. Tests
- Update `worker/src/cron/__tests__/fetch-tbill-rate.test.ts` fixtures and assertions
- Add coverage for:
  - ECB compounded €STR parsing
  - SIX guest-token plus CSV flow
  - CHF retained fallback mode when SIX fetch fails
- Adjust degraded metadata expectations for the new EUR/CHF failure modes

4. Docs and methodology surfaces
- Update:
  - `docs/yield-intelligence.md`
  - `docs/yield-intelligence-timeline.md`
  - `docs/api-reference.md`
  - `src/app/methodology/sections/monitoring-sections.tsx`
  - `src/app/about/page.tsx`
  - `src/app/yield/client.tsx`
  - `shared/lib/yield-methodology-version.ts`
- Add a new methodology version entry describing the benchmark move

### Planned Validation

- `npm run lint`
- `npm test`
- `npm run build`
- `cd worker && npx tsc --noEmit`
- `npm run test:merge-gate`

### Commit / Push

After validation passes:

- create a normal commit with a focused message
- push the current branch
