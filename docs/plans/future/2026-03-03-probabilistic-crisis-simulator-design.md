# Probabilistic Crisis Simulator (PCS) - Future Concept Design

**Date:** 2026-03-03  
**Status:** Proposed (future concept)  
**Owner:** Engineering + Product  
**Scope:** New risk engine, first surfaced as an upgrade to the existing Contagion Map in Risk Lab.

---

## 1. Objective

Build a probabilistic crisis engine that estimates:

1. The probability each stablecoin enters `WARNING` or `DANGER` over `24h` and `7d`.
2. Distribution of ecosystem and portfolio "supply at risk" (not a single deterministic value).
3. The dominant causal paths of stress propagation.

The engine should make Pharos decision-grade for forward risk, not only descriptive for current risk.

---

## 2. Product Positioning

PCS is best treated as a **separate backend risk engine** with the current Contagion Map as its first UI consumer.

Why:

1. Existing stress test is deterministic and dependency-channel only.
2. PCS requires multi-channel state transitions and stochastic simulation.
3. Outputs are new data products (probabilities, quantiles, path attribution), not just a richer chart.

Practical rollout:

1. Integrate first inside `/safety-scores` as "Contagion Map v2".
2. Reuse the same engine later for portfolio risk and alerting thresholds.

---

## 3. Current Baseline and Gap

Current system already has strong primitives:

1. Dependency graph and `computeStressedGrades` in `src/lib/report-cards.ts`.
2. DEWS per-coin stress (`/api/stress-signals`), updated every 15 minutes.
3. PSI systemic backdrop (`/api/stability-index`).
4. Liquidity, depeg, mint/burn, blacklist, and yield warning pipelines.

Main gap:

1. Stress simulation today recomputes only the Dependency Risk dimension.
2. No probability distribution, confidence interval, or path-level likelihood.
3. No time horizon forecast (`24h`, `7d`) beyond point-in-time DEWS.

---

## 4. Non-Goals (Initial Version)

1. No account system or personalized server-side state.
2. No autonomous trading actions.
3. No chain-level microstructure simulation (block-by-block order flow).
4. No opaque black-box model with no attribution.
5. No guarantee of exact depeg timing; target is calibrated probability bands.

---

## 5. User Outcomes

PCS should answer:

1. "Which coins are most likely to hit danger soon?"
2. "If coin X gets shocked, what is the distribution of downstream damage?"
3. "Which paths create most systemic risk today?"
4. "How concentrated is my portfolio tail risk under realistic stress propagation?"

---

## 6. High-Level Architecture

## 6.1 Simulation Flow

1. **Feature Assembly:** Pull latest validated inputs (DEWS, PSI, liquidity, depeg, flows, blacklist, yield warnings, dependency graph).
2. **Scenario Build:** Define baseline or shock scenario (example: hard failure of USDC).
3. **Monte Carlo Runner:** Simulate multi-step market states for all coins over horizon.
4. **Aggregation:** Convert runs into per-coin probabilities and ecosystem quantiles.
5. **Attribution:** Compute dominant stress paths and channel contribution shares.
6. **Persistence + API:** Save scenario outputs to D1 and serve via read APIs.

## 6.2 Execution Modes

1. **Precomputed mode (MVP):** Baseline + top systemic scenarios on cron.
2. **On-demand mode (Phase 2):** Query-driven scenario runs with caching and strict limits.

---

## 7. Model Design

## 7.1 State per Coin per Step

For each coin `i` at step `t`, maintain:

1. `stressScore_i,t` (0..100)
2. `band_i,t` (`CALM/WATCH/ALERT/WARNING/DANGER`)
3. `activeDepeg_i,t` (bool)
4. `liquidityState_i,t` (normalized stress component)
5. `flowState_i,t` (redemption pressure component)

## 7.2 Channels

Each step blends six channels:

1. **Dependency channel** from upstream exposures (existing reserve graph).
2. **Peg channel** from current deviation and trend momentum.
3. **Liquidity channel** from pool imbalance and TVL erosion.
4. **Flow channel** from mint/burn pressure.
5. **Policy channel** from blacklist/freeze shocks when relevant.
6. **Systemic channel** from PSI backdrop and market-wide turbulence.

## 7.3 Transition Function

For each coin and step:

```text
shock_i,t =
  w_dep * depShock_i,t +
  w_peg * pegShock_i,t +
  w_liq * liqShock_i,t +
  w_flow * flowShock_i,t +
  w_pol * policyShock_i,t +
  w_sys * systemicShock_t

stressScore_i,t+1 =
  clamp(0, 100, alpha * stressScore_i,t + (1 - alpha) * shock_i,t + noise_i,t)

pDanger_i,t+1 = sigmoid(beta0 + beta1 * stressScore_i,t+1 + beta2 * activeDepeg_i,t + beta3 * trend_i,t)
```

Then sample state transition using deterministic seed + pseudo-random stream for reproducibility.

## 7.4 Scenario Types

1. `baseline_nowcast`: no forced shock.
2. `single_coin_hard_fail`: set target coin stress to 100 at `t0`.
3. `single_coin_soft_shock`: set target coin to severe but recoverable state.
4. `systemic_liquidity_drain`: apply global liquidity shock multiplier.
5. `issuer_policy_shock`: apply freeze/blacklist surge on affected assets.

## 7.5 Horizons and Resolution

MVP defaults:

1. `24h` horizon with `1h` steps.
2. `7d` horizon with `6h` steps.

This keeps runtime bounded while retaining directional signal.

---

## 8. Calibration and Validation

## 8.1 Data for Calibration

1. Historical depeg events (`depeg_events`).
2. Stress signals history (`stress_signals`, `stress_signal_history`).
3. Liquidity history (`dex_liquidity_history`).
4. PSI history (`stability_index`, `stability_index_samples`).
5. Mint/burn historical aggregates.

## 8.2 Target Labels

For each coin and timestamp, labels for:

1. Entered `WARNING` within 24h.
2. Entered `DANGER` within 24h.
3. Active depeg threshold breach within 24h.

## 8.3 Quality Metrics

1. Brier score for probability calibration.
2. ROC-AUC / PR-AUC for ranking quality.
3. Lead time to realized stress transitions.
4. False positive burden at operational alert thresholds.

## 8.4 Backtest Gate

Model version is publishable only if:

1. Brier score improves against DEWS-threshold baseline.
2. Probabilities are monotonic by risk decile.
3. No NaN/Infinity or out-of-range state values.

---

## 9. Data Model (D1)

Current highest migration in repo: `0034`. Proposed new migrations:

1. `0035_crisis_sim_runs.sql`
2. `0036_crisis_sim_outputs.sql`

## 9.1 `crisis_sim_runs`

Tracks each scenario run:

1. `run_id TEXT PRIMARY KEY`
2. `model_version TEXT NOT NULL`
3. `scenario_key TEXT NOT NULL`
4. `horizon_hours INTEGER NOT NULL`
5. `step_minutes INTEGER NOT NULL`
6. `run_count INTEGER NOT NULL`
7. `seed INTEGER NOT NULL`
8. `status TEXT NOT NULL` (`ok|error|stale`)
9. `created_at INTEGER NOT NULL`
10. `completed_at INTEGER`
11. `diagnostics_json TEXT`

## 9.2 `crisis_sim_coin_risk`

Per-coin aggregated outputs:

1. `run_id TEXT NOT NULL`
2. `stablecoin_id TEXT NOT NULL`
3. `p_warning REAL NOT NULL`
4. `p_danger REAL NOT NULL`
5. `p_active_depeg REAL NOT NULL`
6. `expected_stress REAL NOT NULL`
7. `q05_stress REAL NOT NULL`
8. `q50_stress REAL NOT NULL`
9. `q95_stress REAL NOT NULL`
10. `primary_driver TEXT`
11. `PRIMARY KEY (run_id, stablecoin_id)`

## 9.3 `crisis_sim_paths`

Dominant propagation edges:

1. `run_id TEXT NOT NULL`
2. `from_coin_id TEXT NOT NULL`
3. `to_coin_id TEXT NOT NULL`
4. `contribution REAL NOT NULL`
5. `reach_probability REAL NOT NULL`
6. `PRIMARY KEY (run_id, from_coin_id, to_coin_id)`

Retention:

1. Keep hourly baseline snapshots for 30 days.
2. Keep daily snapshots for 365 days.
3. Keep scenario outputs for top systemic shocks for 90 days.

---

## 10. API Surface (Proposed)

## 10.1 `GET /api/crisis-risk-snapshot`

Params:

1. `scenario` (`baseline_nowcast` default)
2. `horizon` (`24h|7d`)

Response:

1. Run metadata (`runId`, `modelVersion`, `computedAt`).
2. Ecosystem quantiles (`supplyAtRisk` P05/P50/P95).
3. Coin risk map (`pWarning`, `pDanger`, expected stress).
4. Top causal paths (edge list).

## 10.2 `GET /api/crisis-risk-scenario`

Params:

1. `target` (coin id)
2. `shock` (`hard|soft`)
3. `horizon` (`24h|7d`)

Behavior:

1. Return cached scenario if fresh.
2. If absent, run bounded simulation, persist, then return.
3. Enforce hard limits to prevent expensive fan-out.

## 10.3 `GET /api/crisis-model-status`

Returns:

1. Active model version.
2. Last calibration date.
3. Backtest quality metrics summary.

---

## 11. Worker Integration

New modules:

1. `worker/src/lib/crisis-model.ts` (core transition and simulation code)
2. `worker/src/lib/crisis-features.ts` (feature assembly from existing tables/cache)
3. `worker/src/cron/simulate-crisis-risk.ts` (precompute baseline + top shocks)
4. `worker/src/api/crisis-risk-snapshot.ts`
5. `worker/src/api/crisis-risk-scenario.ts`
6. `worker/src/api/crisis-model-status.ts`

Operational constraints:

1. Use cron lease locking for simulator job.
2. Fail closed on schema mismatch for persisted outputs.
3. Preserve last-known-good run when computation fails.

---

## 12. Frontend Integration

First integration point: `src/components/stress-test-panel.tsx` in `/safety-scores`.

UX changes:

1. Add mode toggle: `Deterministic` (current) vs `Probabilistic`.
2. In probabilistic mode show:
   - `pWarning` and `pDanger` per affected coin.
   - Ecosystem risk distribution (`P05/P50/P95 supply at risk`).
   - Top propagation paths and driver channels.
3. Keep existing deterministic stress test as fallback and for explainability parity.

Follow-on surfaces:

1. `/portfolio`: probability-weighted portfolio tail risk.
2. `/depeg`: scenario-conditioned watchlist.
3. Telegram/Webhook alerts: threshold on probability deltas, not only band entry.

---

## 13. Testing Strategy

## 13.1 Unit Tests

1. Channel computation bounds and monotonicity.
2. Deterministic seed reproducibility.
3. Transition function invariants (no NaN, bounded scores, valid bands).

## 13.2 Integration Tests

1. End-to-end scenario run writes all expected rows.
2. API contract and schema validation.
3. Cache hit/miss behavior and stale fallback.

## 13.3 Regression and Backtest Tests

1. Golden scenario snapshots for known crisis periods (UST, SVB weekend).
2. Calibration drift guardrails per model version.
3. Runtime performance budget checks.

---

## 14. Rollout Plan

## Phase 0: Research and Shadow Backtest

1. Implement engine with no UI/API exposure.
2. Run shadow forecasts and compare with realized events.

## Phase 1: Read-Only Baseline Snapshot

1. Enable `/api/crisis-risk-snapshot`.
2. Add probabilistic panel to Risk Lab (baseline only).

## Phase 2: Scenario Engine in Risk Lab

1. Enable bounded query-driven scenarios (`target + shock`).
2. Add path attribution and channel contribution view.

## Phase 3: Portfolio and Alerting Expansion

1. Portfolio tail-risk distributions.
2. Probability-threshold alert policies.

---

## 15. Success Metrics

1. Forecast quality improves against current heuristic baseline.
2. Median lead time for severe events improves.
3. Risk Lab engagement increases for simulation workflows.
4. Alerts produce better precision at similar recall.

---

## 16. Risks and Mitigations

1. **Model overfitting risk**
   - Use rolling backtests and frozen validation windows.
2. **Runtime/cost risk**
   - Cap runs, coarse step sizes, precompute hot scenarios.
3. **Trust/interpretability risk**
   - Always provide channel and path attribution.
4. **Data quality risk**
   - Fail closed for critical inputs and retain last-known-good outputs.

---

## 17. Open Questions

1. Should scenario endpoints remain public GETs, or require an admin gate for expensive runs?
2. What is the correct default stress threshold for user-facing "critical probability" alerts?
3. Should model coefficients be fully static (versioned constants) or periodically re-fit automatically?
4. How many top systemic scenarios should be precomputed each hour to balance coverage and runtime?

---

## 18. Decision

Treat PCS as a **new core risk engine** and ship it first as a major Contagion Map upgrade. This keeps product surface area focused while creating reusable infrastructure for portfolio risk and alerting.
