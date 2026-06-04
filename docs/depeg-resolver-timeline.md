# Depeg Duration Resolver Methodology — Version Timeline

Version timeline for the Depeg Duration Resolver (DDR) methodology. Covers DDR `v1.0` through `v3.0`.

Versions increase numerically, not semver-style: the next minor release after `v1.9` is `v1.91`, not `v1.10`. The canonical version source is `shared/lib/depeg-resolver-version.ts` (re-exported from `shared/lib/methodology-versions/depeg-resolver.ts`); the public changelog route is `/methodology/depeg-resolver-changelog/`.

---

## v3.0 — Forecast Readiness Contract (June 4, 2026)

Added the shared DDR forecast-readiness contract for readiness-gated locks with immutable public metadata.

- **Forecast readiness trigger.** Active confirmed incidents can seal as soon as the first healthy run observes forecast readiness with a strict score `>0.75`. A score equal to `0.75` is not ready, and the score is readiness metadata, not a probability or confidence label.
- **72h backstop.** Incidents that stay active without crossing readiness seal on the first healthy run at or after `started_at + 72h`. The backstop is a public accountability deadline, not a relaxed readiness score.
- **Health deferrals.** If the readiness trigger or 72h backstop arrives while global/system health predicates fail, DDR records `lock_deferred` and waits for the next healthy run. Deferrals do not create no-calls, predictions, or accuracy samples.
- **Pre-lock recovery/terminal outcomes.** Incidents that recover before a healthy lock become `resolved_before_prediction`; reliable terminal evidence before a healthy lock becomes `terminal_before_prediction`, including health-deferred incidents that resolve before the next healthy sealing run.
- **Immutable trigger/readiness metadata.** First-published rows preserve public `lockTrigger`, `readiness` (`version`, score, threshold, reasons, components), `backstop` (`delaySec`, `backstopAt`, `reached`), deferral reason/count metadata, and policy version as part of the public exposure.
- **Sticky-policy compatibility.** Existing `sticky-24h-v1` DDRv2 predictions/no-calls keep their original 24h lock metadata, hashes, and DDRR review status. Legacy public rows default to `lockTrigger = "scheduled_24h"`, while v3 readiness rows use `forecast_readiness` or `readiness_backstop`.

## v2.0 — Sticky Public Prediction Contract (May 27, 2026)

Promoted DDR from a live reassessment widget to a one-shot public forecast contract.

- **Sticky 24h lock policy.** Active confirmed incidents receive no headline verdict before the 24h lock point. The first healthy eligible run seals exactly one frozen prediction or one no-call for the canonical `incidentKey` under `sticky-24h-v1`.
- **First-publication scoring.** DDRR headline review now scores only frozen `public_prediction` outcomes that entered the append-only first-publication manifest. Sealed-but-unpublished rows surface as `publication_retry_pending` and are not counted as public predictions.
- **No-call semantics.** Healthy lock runs with insufficient row-level inputs freeze a `no_call` outcome. No-calls are visible accountability rows, excluded from recovery/duration accuracy, and cannot later drift into predictions.
- **Coverage universe.** DDRR reports prediction coverage, scoreable coverage, publication success, no-call share, invalidation rate, missed locks, pre-lock recoveries/terminal outcomes, data-quality gaps, and retry/failed publication states over canonical incidents.
- **Errata and invalidation.** Append-only errata keep original first-publication exposure visible while marking predictions invalidated and linking the latest correction/history.
- **Live overlay split.** Frozen predictions keep lock-time verdict/duration anchored while the public DDR UI shows current deviation, incident age, stale/degraded status, and closure state separately.
- **Pre-lock source-row adoption.** Nearby same-coin/same-direction source rows can be adopted into an unsealed canonical incident through append-only links/revisions, while sealed incidents still require explicit repair authorization.

## v1.1 — Depeg Duration Resolver Reviewer (May 25, 2026)

Added the Depeg Duration Resolver Reviewer (DDRR), the audit layer that scores stored DDR assessments against later canonical depeg-event outcomes.

- **Assessment checkpoints.** The DDR writer now stores quarter-hourly checkpoints in `depeg_resolver_assessments` (`first`, `age_1h`, `age_6h`, `age_24h`, `age_7d`, and `latest`) with the original verdict tier, duration median/IQR, horizon cells, factors, methodology version, and source row JSON.
- **Public review stats.** The `/depeg/` module and `GET /api/depeg-resolver-review` endpoint expose strict recovery-likelihood accuracy plus average observed-minus-DDR recovery-duration error. Public reviewer v1 scoring uses the `first` checkpoint for each event under the current methodology so headline stats stay event-level.
- **Conservative outcome handling.** Pending, insufficient-signal, and data-issue rows are visible but excluded from scored headline accuracy; still-open events remain pending unless tracked lifecycle status supplies terminal evidence, and open status alone is never counted as proof that a terminal call was right.
- **Terminal lifecycle cutoff.** Open rows for tracked assets already marked `frozen`, `dead`, `defunct`, `failed`, or `cemetery` leave the live DDR board and are owned by DDRR instead. A dead stablecoin cannot produce an observable time-to-repeg, so duration review remains unscored for terminal outcomes.
- **No historical replay.** DDRR compares stored DDR readouts with later `depeg_events` outcomes and tracked-coin lifecycle state; it does not replay today's resolver over old events.

## v1.0 — Initial Depeg Duration Resolver (May 25, 2026)

Launched the two-stage Depeg Duration Resolver: a mechanistic Resolution Outlook (terminal vs recoverable) followed by a stratified empirical duration estimate over recovered historical incidents.

- **Stage 1 — Resolution Outlook.** Emits an ordinal verdict (`recovery_likely` / `at_risk` / `recovery_unlikely` / `insufficient_signal`) from five kill signals (K1–K5) and five recovery anchors (R1–R5) over structural metadata and the live depeg fingerprint. Verdicts are calibrated domain reads, not fitted probabilities, because the terminal-label corpus is too thin to fit a supervised classifier.
- **Stage 2 — Expected Duration.** Emits a depth / direction / structural-class stratified landmark estimate with a median plus interquartile band and per-horizon (6h / 24h / 7d / 30d) resolution likelihood, support-gated and Wilson-bounded, computed only when Stage 1 is non-terminal.
- **Provenance handling.** Audit-verdict gating is not used because the depeg-event provenance side-table is unpopulated in production. Corpus quality comes from incident grouping, quarantine of flappy coins, and a minimum-severity/duration floor instead.
- **Sub-component versions seeded:** `resolution-rubric-v1`, `duration-landmark-v1`, `incident-group-v1`, `support-rules-v1`.

---

## Notes

- The full methodology, limitations, and backtest/acceptance plan live in [depeg-resolver.md](./depeg-resolver.md).
- Effective boundaries and the machine-readable changelog are encoded in `shared/lib/methodology-versions/depeg-resolver.ts`.
- DDR consumes confirmed `depeg_events` from the [depeg detection pipeline](./depeg-detection.md); it does not run its own detection.
