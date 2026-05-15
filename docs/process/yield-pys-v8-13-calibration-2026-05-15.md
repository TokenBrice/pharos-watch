# Yield PYS v8.13 Calibration Artifact

Generated: 2026-05-15T18:55:00.000Z

Scope: rollout evidence for methodology v8.13. v8.13 is additive — benchmark registry expansion to GBP/JPY/MXN/BRL/AUD/CAD, `sourceRiskScore` derivation from the resolved penalty, and the first reviewed venue tier batch. This artifact documents the per-currency wiring, the score derivation rule, the venue tier batch, and the coverage delta versus the prior USD-only fallback. Production snapshot null-rate measurements remain in `docs/process/yield-pys-v8-production-sample-calibration-2026-05-13.md`; this artifact does not regenerate that snapshot.

## Methodology Delta

What changed numerically in PYS:

- **PYS formula stages unchanged.** `effectiveYield`, `sourceRiskPenalty`, `riskPenalty^1.75`, `sustainabilityMult`, and `PYS_SCALING_FACTOR = 8` are not touched. The benchmark-aware formula from v6.7 / source-risk penalty path from v8.0 continue to produce the final score.
- **Benchmark spread term now uses native rates for six new currencies.** `effectiveYield = max(0, apy30d + PYS_BENCHMARK_SPREAD_WEIGHT * (apy30d - benchmarkRate))` is unchanged, but `benchmarkRate` now resolves to a native rate (GBP/JPY/MXN/BRL/AUD/CAD) instead of the USD T-Bill for those peg currencies. The numerical effect is per-row: a MXN-pegged row at 14% APY now compares against ~11% CETES (≈+0.75 spread credit) instead of ~4% USD T-Bill (≈+2.5 spread credit), so PYS contracts toward the asset's true local-rate spread.
- **`sourceRiskScore` derivation.** Previously a passthrough that was always null in production. Now defaults to `computeSourceRiskScoreFromPenalty(sourceRiskPenalty)` when no upstream score is provided. PYS is **not** affected — it continues to consume `sourceRiskPenalty` directly. This is a display/observability change only.
- **Venue risk tier resolution.** Four protocols move out of `unknown`. `low` is currently a no-op (no negative bonus exists in the penalty derivation today). `medium` adds `+0.15` to the source-risk penalty on affected rows; `morpho-blue` is the only `medium` entry in this batch.

## Benchmark Registry Expansion

The benchmark registry now supports `USD`, `EUR`, `CHF`, `GBP`, `JPY`, `MXN`, `BRL`, `AUD`, and `CAD`. Sources wired in this batch:

| Currency | Source | Reference rate | Notes / caveats |
| -------- | ------ | -------------- | --------------- |
| GBP | FRED `IUDSOIA` (BoE SONIA mirror) | SONIA overnight | Used as a proxy for "3M compounded SONIA"; full compounding can be wired later |
| JPY | FRED `IRSTCB01JPM156N` | Uncollateralized overnight call rate | Used as a TONA-equivalent proxy; FRED mirrors BoJ |
| MXN | Banxico SIE API series `SF43936` | CETES 28d auction rate | Requires `BANXICO_TOKEN` worker env; falls back to USD when token is absent. **Self-reference caveat — see below.** |
| BRL | BCB SGS API series `11` | SELIC daily | No auth required; daily |
| AUD | FRED `IR3TIB01AUM156N` | 3M interbank | Used as a proxy for the RBA cash rate target |
| CAD | Bank of Canada Valet API series `V122530` | Overnight repo | CORRA-equivalent |

**Retention policy:** fetchers retain the last known value with `benchmarkSelectionMode: "fallback-stale"` on transient feed outages; they only fall back to USD when **no** native rate has ever been observed. This means the universal USD fallback for non-USD pegs has been replaced by a stale-tolerant native path.

**Pulled from:** commit `10e469cf4` — "feat(yield): expand benchmark registry to GBP, JPY, MXN, BRL, AUD, CAD".

## sourceRiskScore Derivation Rule + Venue Tier First Batch

### sourceRiskScore derivation rule (commit `e70720a3c`)

`computeSourceRiskScoreFromPenalty` in `shared/lib/yield-scoring.ts`:

```text
score = clamp(round(((penalty - 1) / (PYS_MAX_SOURCE_RISK_PENALTY - 1)) * 100), 0, 100)
```

- `penalty = 1.0` (neutral) → `score = 0`
- `penalty = 1.75` (mid-range) → `score ≈ 50`
- `penalty = 2.5` (cap) → `score = 100`
- `penalty` is not a finite number → `score = null`

`buildYieldSourceRisk` now defaults to this derivation when no upstream score is provided. Explicit upstream `sourceRiskScore` values still win — the rule fills the gap, not the path.

**Why it matters.** The v8 production-sample calibration recorded `sourceRiskScore` null at 100% (0/131 rows). The penalty was reaching the score path, but the score field itself had no producer. PYS was unaffected (it consumed the penalty directly), but UI tooltips and downstream consumers saw a universally empty field. The derivation rule closes this without changing PYS.

### Venue tier first batch (commit `e70720a3c`)

`YIELD_RISK_CONFIG` in `worker/src/cron/yield-sync/source-risk.ts` now contains four reviewed entries:

| Protocol | Tier | Evidence |
| -------- | ---- | -------- |
| `aave-v3` | `low` | Trail of Bits + OpenZeppelin + Certora audits; live since 2020; multi-billion TVL; safety-module stake |
| `compound-v3` | `low` | OpenZeppelin + ChainSecurity audits; live since 2018; multi-billion TVL; COMP governance |
| `sparklend` | `low` | Inherits Aave V3 audit surface; ChainSecurity audit on Sky customizations; live since 2023 |
| `morpho-blue` | `medium` | Spearbit / Cantina / OpenZeppelin / Runtime Verification audits; live since 2024; immutable design limits remediation; younger TVL cohort |

`low` is currently a no-op on penalty derivation (no negative bonus exists today). `medium` contributes `+0.15` to `sourceRiskPenalty` on affected rows. `morpho-blue` is the only batch entry that moves PYS.

Maple, Yearn, Pendle, and Beefy remain `unknown` with rationale/evidence fields until the next monthly coverage audit assigns a non-unknown tier with reviewed evidence. Per the methodology contract, `unknown` stays neutral.

## Coverage Delta

Non-USD coins that now have a correct native benchmark vs the prior USD fallback:

| Peg | Tracked coins (representative) | Live yield rows today | Prior benchmark | New benchmark |
| --- | ------------------------------ | --------------------- | --------------- | ------------- |
| GBP | gbpsafo-spiko, uktbl-spiko, tgbp-tokenised | 0–1 | USD fallback | `GBP` (FRED `IUDSOIA`) |
| JPY | jpym-mento, jpyc-jpyc, jpyt, jpysc | 0 | USD fallback | `JPY` (FRED `IRSTCB01JPM156N`) |
| MXN | cetes-etherfuse | 1 | USD fallback | `MXN` (Banxico `SF43936`) |
| BRL | brla, brd, brz, brlm, brl-b3 | 0–1 | USD fallback | `BRL` (BCB SGS `11`) |
| AUD | audf, audx, audm, audd | 0 | USD fallback | `AUD` (FRED `IR3TIB01AUM156N`) |
| CAD | cadd, cadm | 0 | USD fallback | `CAD` (BoC Valet `V122530`) |

EUR and CHF coverage is unchanged from v6.1 (ECB Data API + SIX delayed SAR3MC). The most visible coverage improvement is **MXN CETES**: rank-1 visibility on the leaderboard with 155.67% APY scored against the USD T-Bill drops to a near-zero local-rate spread, eliminating the over-reward without hiding the asset.

## Known Limitations

- **CETES self-reference.** The Etherfuse CETES asset is itself a tokenized 28-day CETES bond. Benchmarking it against the same CETES rate produces ≈0% spread, which now under-rewards rather than over-rewards it. The MXN benchmark is wired; a future tokenized-treasury rule can override per-source to select the next-tier-up safe rate in the same currency (e.g., overnight rate when the asset is 28d). The same pattern applies to EUTBL vs €STR and to any future UKTBL vs SONIA.
- **SGD/AED/IDR/TRY/ZAR remain on USD fallback.** SGD is registered as a `YieldBenchmarkKey` in `shared/types/yield.ts` but no fetcher landed in the v8.13 timebox — no stable public feed was identified. AED, IDR, TRY, and ZAR are explicitly out of scope; these peg currencies will continue to render `benchmarkSelectionMode: "fallback-usd"` until each has a stable public source wired. The leaderboard surfaces this via the existing amber dot caveat on the PYS cell for non-USD pegs on USD fallback (introduced in the v8.13 sprint, presentation-only).
- **GBP proxy precision.** GBP uses overnight SONIA via the FRED mirror as a proxy for "3M compounded SONIA". The compounding step is not implemented; the proxy is sufficient for relative spread comparisons but underestimates the true 3M cash hurdle by a small term-structure premium. Same applies to JPY (overnight call rate as TONA proxy) and CAD (overnight repo as CORRA proxy).
- **MXN auth dependency.** Banxico SIE requires `BANXICO_TOKEN`. When the env is absent or revoked, MXN-pegged rows fall back to USD with `benchmarkSelectionMode: "fallback-usd"`. The operator should monitor this and ensure the token is provisioned on the worker before treating MXN coverage as fully active.
- **Venue tier coverage is narrow.** Four protocols moved out of `unknown`. Most tracked venues remain `unknown` and are neutral. Source-risk score derivation alone will not significantly shift the v8 production-sample distribution; meaningful score signal requires more reviewed venue tiers landing in subsequent batches.

## Follow-Up Audit Candidates

Next reviewed venue tier batches (in rough priority order for the next monthly yield coverage audit):

1. **Maple** — institutional credit; high reward share volatility; audit history is reasonably documented. Candidate for `medium` if cohort behavior holds.
2. **Yearn V3** — long-lived strategy-vault platform; multi-strategy abstraction is older than morpho-blue's immutable design. Candidate for `low` pending evidence review.
3. **Pendle** — interest-rate AMM with explicit time-decay risk; PT/YT splits change the deposit semantic relative to a vanilla lending market. Likely candidate for `medium`; needs reviewed evidence on the PT side.
4. **Beefy** — strategy aggregator; risk inherits the underlying strategy. Likely `medium` or `unknown` until the underlying-strategy population is itself reviewed.
5. **Liquity Stability Pool** — distinct risk profile from lending markets (liquidation-driven yield). Worth a dedicated review independent of the lending batch.
6. **Spiko / Etherfuse / Hashnote / Ondo** — tokenized-treasury and NAV venues. The tokenized-treasury self-reference rule (CETES) should be designed alongside the next-tier-up rate override before tier assignment.

When the next batch lands, generate a fresh production-sample calibration to measure the actual PYS distribution shift attributable to non-unknown tiers.

## Implementation Notes

- Commits in scope: `10e469cf4` (benchmark registry expansion) and `e70720a3c` (sourceRiskScore derivation + venue tier batch).
- The leaderboard caveat dot for currency-mismatched benchmarks (`isCurrencyMismatchedBenchmark`) is presentation-only and was part of the v8.13 sprint but does not require a methodology version. It surfaces when `benchmarkSelectionMode === "fallback-usd"` on a non-USD peg — useful while AED/IDR/TRY/ZAR/SGD remain unwired.
- Pair this artifact with `docs/process/yield-pys-v8-calibration-2026-05-13.md` for source-risk golden fixtures and `docs/process/yield-pys-v8-production-sample-calibration-2026-05-13.md` for the prior production snapshot. Both retain v8 production reference value because the v8.13 changes are additive.
- Scratch calibration inputs stay under `/agents/`; committed rollout evidence belongs under `docs/process/`.
