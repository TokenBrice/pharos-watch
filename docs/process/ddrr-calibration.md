# DDRR Calibration Report Process

Use `npm run calibrate:ddrr` when enough Depeg Duration Resolver Reviewer (DDRR) rows exist to inspect DDR calibration pressure without changing live resolver logic.

## Commands

```bash
npm run calibrate:ddrr -- --prod --report agents/ddrr-calibration-report.md
npm run calibrate:ddrr -- --input agents/depeg-resolver-review.json --report agents/ddrr-calibration-report.md
npm run calibrate:ddrr -- --api-base http://localhost:8787 --json --stdout
```

The script reads the public DDRR response contract, validates it with `DdrrResponseSchema`, and writes Markdown by default. JSON mode is for downstream analysis. The default output path is `agents/ddrr-calibration-report.md`; keep scratch reports under `agents/`.

## What The Report Covers

- Factor attribution by fired DDR factor code, severity, label class, verdict review, and actual outcome.
- No-call and insufficient-signal maturation by missing reason.
- Coverage debt by prediction state, coverage cause, and operational coverage cause.
- Stage 2 duration signed/absolute error by overall sample, direction, and stratum, including repeated-coin-adjusted bias.
- Horizon expected-vs-observed calibration (`horizonCalibration`): mean predicted probability, realized closure share, bias (pp), and Poisson-binomial z-score per horizon (6h / 24h / 7d / 30d).
- Focused sections for K5 exit collapse, K2 reserve/dependency nuance, and K1 recent mint-incident timing.

## Guardrails

- The report is advisory. It does not replay today's DDR engine over historical rows.
- **Two kinds of methodology change — do not mix their gates:**
  - **Definitional corrections** validated by full-corpus replay (for example training-label stickiness, typical-range quantiles, coin-dedup median/band, quarantine boundary semantics, currency-guard ordering) are **not** DDRR-sample-fitted retunes. They may land when a corpus-level replay proves the bias/coverage improvement and support-state flips are enumerated; the 50-row / 20-coin sample gate does **not** block them.
  - **DDRR-outcome-fitted retunes** (threshold sweeps, weight tweaks, or any change whose justification is "it improves accuracy on the current scored DDRR sample") remain gated: do not retune Stage 2 (or Stage 1 thresholds) from sample fit until the report passes at least **50 scored duration rows and 20 unique coins**.
- Treat no-calls, missed locks, publication failures, and data-quality gaps as coverage or input debt before changing terminality thresholds.
- Before treating `missed_lock_terminal` rows as live lock debt, verify whether the incident was rollout-active and whether reliable terminal evidence predates the DDRv2 public prediction contract. Those rows should classify as `terminal_before_prediction` under reviewer v3+.
- Treat factor labels as explanatory text. Raw K5, reserve, mint-authority, wind-down, and V9 exit inputs require a D1/sealed-payload/registry join before making a methodology change.
- Keep point-in-time reports in `agents/`. When a report supports a reviewed methodology decision, record the durable rule in `docs/depeg-resolver.md` and the versioned change in its timeline instead of committing the report itself.
