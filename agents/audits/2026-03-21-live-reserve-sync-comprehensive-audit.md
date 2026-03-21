# Live-Reserve-Sync Comprehensive Audit (2026-03-21)

Third-pass audit covering data accuracy AND code quality/maintainability across the entire live-reserve-sync system (114 coins, 27 adapters, ~3,500 LOC).

---

## Part 1: Data Accuracy

### 1A. Structural Gaps

#### Missing display blocks (2 pre-existing coins)
- **usds-sky** and **dai-makerdao** have `display: null` — these use `sky-makercore` adapter and predate today's expansion. Users cannot see any source link.

#### Missing curated reserves (12 coins — "flying blind")
These coins have `liveReservesConfig` but NO `reserves` array. The single-asset adapter returns a label + risk, but there's no curated breakdown to verify against:

| Coin | Group | Label |
|------|-------|-------|
| aid-gaib | usd-minor | GPU compute-backed USD reserves |
| audd-novatti | non-usd | AUD bank deposits |
| brz-transfero | non-usd | BRL fiat reserves |
| cadc-cad-coin | non-usd | CAD bank deposits |
| eurs-stasis | non-usd | Euro fiat reserves |
| gyen-gyen | non-usd | JPY fiat reserves |
| jpyc-jpyc | non-usd | JPY reserves |
| tgbp-tokenised | non-usd | GBP bank deposits |
| vchf-vnx | non-usd | CHF cash & equivalents |
| vgbp-vnx | non-usd | GBP cash & equivalents |
| xsgd-straitsx | non-usd | SGD deposits & MAS-eligible securities |
| zarp-zarp | non-usd | ZAR fiat reserves |

Impact: No collateral drift detection possible; label accuracy unverifiable.

#### Display URL pointing to dev docs instead of transparency (1 coin)
- **feusd-felix**: URL is `https://usefelix.gitbook.io/docs/developers/market-1-feusd-cdp` with label "Developer docs". Should point to a transparency/reserve page if one exists, or at minimum the main website.

### 1B. Data Quality

All 24 curated-validated coins have reserves summing to exactly 100%. All 18 cross-coin coinId references resolve to existing coins. Semantic assignments are consistent (no single-asset coins with collateral-mix semantics or vice versa).

#### Vague reserve names (3 coins)
- avusd-avant: "Reserve fund (loss absorption buffer)" — what assets?
- gusd-gate: "Yield instruments (unspecified)" — what instruments?
- rwausdi-multipli: "Treasury-backed stablecoins (100+ aggregated)" — which stablecoins?

#### Generic display labels (14 coins)
Labels like "A7A5", "DGLD", "VNX", "ZARP", "Gate", "Zoth", "APYX" are too short to be informative. These should include context like "A7A5 Transparency" or "Gate USD Reserves".

---

## Part 2: Code Quality & Mutualization

### 2A. Code Duplication — HIGH PRIORITY

#### On-chain probe duplication (single-asset.ts + curated-validated.ts)
Both adapters contain identical 15-line blocks for:
1. Contract address lookup: `coin.contracts?.find(c => c.chain === onchain.chain)?.address`
2. totalSupply fetch: `fetchErc20TotalSupply(onchain, probeContract, signal, ctx, rpcUrl, fallbackRpcUrl)`
3. Zero-supply validation: `if (totalSupply == null || totalSupply <= 0n) throw ...`

**Fix:** Extract `probeErc20TotalSupply(coin, input, signal, ctx, rpcUrl?, fallbackRpcUrl?)` into `helpers.ts`. Both adapters call this one function. Saves ~15 LOC and ensures consistent error messages.

#### Repeated `readParams()` pattern (6 adapters)
`single-asset.ts`, `chainlink-nav.ts`, `chainlink-por.ts`, `btcfi.ts`, `collateral-positions-api.ts`, `evm-branch-balances.ts` each implement their own `readParams()` with unsafe `as Partial<T>` → `as T` casts.

**Fix:** Extract generic `readAdapterParams<T>(config, requiredKeys[], adapterName)` into `helpers.ts`. Validates required keys exist, returns properly typed params. Eliminates unsafe double-casts and ~50 LOC.

### 2B. Type Safety — HIGH PRIORITY

#### Unsafe param casting (6 adapters)
The pattern `(config.params ?? {}) as Partial<SomeType>` followed by `return params as SomeType` bypasses TypeScript's type narrowing. The second cast is unsafe — it asserts all required fields exist after checking only some.

**Fix:** Replace with type guards or the generic `readAdapterParams` validator from 2A.

#### Loose metadata type
`AdapterResult.metadata` is typed as `Record<string, unknown>`. Each adapter returns different metadata shapes but they're all erased to `unknown`.

**Fix (low priority):** Not blocking, but could use generic `AdapterResult<M>` for compile-time metadata safety.

### 2C. Missing Tests — MEDIUM PRIORITY

#### Adapters without dedicated tests
- **dola-inverse.ts** — complex symbol resolution + bucketing logic, no test for `adaptFirmMarkets()` or `resolveBaseSymbol()`
- **frax.ts** — has tests for `adaptFraxCombinedData` in frax.test.ts (added today), but no test in the integration test file for the curated reserves fallback path with a full coin object
- **m0.ts, fx.ts, openeden.ts, reservoir.ts** — no dedicated test files

The pure `adapt*()` functions in dola-inverse and reservoir are the highest priority since they contain bucketing/parsing logic.

#### Missing integration test
No test for `sync-live-reserves.ts` end-to-end orchestration (circuit breaker interaction, shared source caching, sequential execution).

### 2D. Documentation — MEDIUM PRIORITY

#### No adapter authoring guide
New adapter authors learn from existing code. A template doc would accelerate onboarding and prevent common mistakes (unsafe casts, missing null checks, hardcoded labels).

#### Missing JSDoc on helpers
`slicesFromValues()`, `normalizeSlices()`, `getJsonPath()` in `helpers.ts` are complex functions without JSDoc explaining their rounding philosophy, edge cases, or examples.

---

## Part 3: Architecture & Resilience

### 3A. Orchestration — STRONG

- Sequential adapter execution prevents connection pool exhaustion
- Shared source deduplication (one HTTP fetch per unique API, not per coin)
- Error isolation: one adapter failure doesn't block others
- Per-adapter timeouts (10-12s) with AbortSignal composition

### 3B. Resilience Concerns

#### D1 write timeout (MEDIUM)
No timeout on D1 operations. If D1 hangs, the cron hangs indefinitely. With 114 coins × 2 DB operations per coin, a slow D1 could exhaust the worker timeout.

**Fix:** Wrap D1 batch operations in `Promise.race([batch, AbortSignal.timeout(30_000)])`.

#### Staleness alerting gap (MEDIUM)
The 2-day freshness threshold means data could be 24h stale before any user-visible indicator appears. Circuit breaker alerts fire on adapter failure, but if the cron itself stops running (scheduler issue), there's no alert until the 2-day stale mark.

**Fix:** Add a "missed cron" alert if no successful sync recorded in 6 hours.

#### Frontend refetch interval (LOW)
`refetchInterval: 2 * 60 * 60 * 1000` (2 hours) means browser data could be up to 3 hours old (1h stale + 2h before refetch). Should match stale time at 1 hour.

### 3C. Monitoring Gaps (LOW)

- No per-adapter latency tracking (can't identify slow adapters)
- No RPC success rate metrics (can't spot flaky chains)
- Collateral drift threshold (15 points) is hardcoded, not configurable per coin

---

## Remediation Priority

### P0 — Data accuracy (fix now)
1. Add `display` blocks for usds-sky and dai-makerdao
2. Populate `reserves` arrays for 12 coins missing curated data
3. Fix feusd-felix display URL (gitbook docs → main website)

### P1 — Code quality (fix soon)
4. Extract `probeErc20TotalSupply()` helper (eliminates single-asset/curated-validated duplication)
5. Extract generic `readAdapterParams<T>()` (eliminates unsafe casts in 6 adapters)
6. Add tests for dola-inverse `adaptFirmMarkets()` and `resolveBaseSymbol()`

### P2 — Resilience (fix when capacity allows)
7. Add D1 operation timeout in sync-live-reserves
8. Add missed-cron alert (no sync in 6 hours)
9. Change frontend refetchInterval from 2h to 1h
10. Refine 3 vague reserve names (avusd, gusd, rwausdi)

### P3 — Polish (nice-to-have)
11. Expand 14 generic display labels to be more descriptive
12. Add JSDoc to helpers.ts complex functions
13. Create adapter authoring guide in /docs/
14. Add per-adapter latency tracking to cron metadata

---

## Statistics

| Metric | Value |
|--------|-------|
| Total coins with live-reserve-sync | 114 |
| Adapters (registered) | 27 |
| Total adapter LOC | ~3,500 |
| Test files for adapters | 17 (of 27 adapters) |
| Coins with no curated reserves | 12 (11%) |
| Data accuracy issues | 16 (structural) |
| Code quality findings | 8 |
| Resilience concerns | 3 |
