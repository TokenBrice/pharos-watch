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
- Focused sections for K5 exit collapse, K2 reserve/dependency nuance, and K1 recent mint-incident timing.

## Guardrails

- The report is advisory. It does not replay today's DDR engine over historical rows.
- Do not retune Stage 2 until the report passes its sample gate: at least 50 scored duration rows and 20 unique coins.
- Treat no-calls, missed locks, publication failures, and data-quality gaps as coverage or input debt before changing terminality thresholds.
- Before treating `missed_lock_terminal` rows as live lock debt, verify whether the incident was rollout-active and whether reliable terminal evidence predates the DDRv2 public prediction contract. Those rows should classify as `terminal_before_prediction` under reviewer v3.
- Treat factor labels as explanatory text. Raw K5, reserve, and mint-authority inputs require a D1/sealed-payload/registry join before making a methodology change.
- Keep point-in-time reports in `agents/`. When a report supports a reviewed methodology decision, record the durable rule in `docs/depeg-resolver.md` and the versioned change in its timeline instead of committing the report itself.
