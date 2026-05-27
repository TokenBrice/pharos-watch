# Depeg Duration Resolver (DDR)

When Pharos confirms an active depeg, the Depeg Duration Resolver answers the two questions an analyst actually asks, in order, but it now does so as a public forecast contract instead of a live-moving widget:

1. **Will it come back?** — a *Resolution Outlook*: an ordinal verdict (Recovery Likely / At Risk / Recovery Unlikely / Insufficient Signal) driven by transparent mechanistic rules over the coin's structure and the depeg's fingerprint. **No fitted ML, no false-precision probability** — the death-label corpus is too thin to fit a supervised terminal classifier. Each verdict shows the contributing factors.
2. **If it comes back, when?** — an *Expected Duration*: an empirical landmark-survival estimate over Pharos's clean corpus of *recovered* depeg incidents, conditioned on the depeg's structural stratum (depth, direction, structural class, peg currency), with explicit data-sufficiency gates and per-horizon (6h / 24h / 7d / 30d) resolution probabilities.

Stage 2 only renders when Stage 1 is not terminal-leaning. The result is a two-readout module: a verdict with reasons, and — when recovery is plausible — a "typically resolves within X–Y" band. Under DDRv2, that headline readout is frozen once per canonical incident at the public lock point and later live facts are shown separately.

DDR is **not investment advice and not a credit rating.** A "Recovery Unlikely" verdict is a structural read, not a guarantee, and the inverse is equally true.

## Methodology Versioning

- **Current methodology version:** `v2.0`
- **Public changelog page:** `/methodology/depeg-resolver-changelog/`
- **Canonical source:** `shared/lib/depeg-resolver-version.ts` (re-exported from `shared/lib/methodology-versions/depeg-resolver.ts`)
- **Version timeline:** [depeg-resolver-timeline.md](./depeg-resolver-timeline.md)

DDR versions increase numerically, not semver-style: the next minor release after `v1.9` is `v1.91`, not `v1.10`. A bump is warranted when the resolution rubric, duration stratification, incident grouping, support-gate rules, or reviewer scoring/public audit contract changes.

Sub-component versions are surfaced in the API `_meta` for reproducibility: `resolutionRubricVersion`, `durationModelVersion`, `incidentGroupingVersion`, `supportRulesVersion`, snapshot generation fields, public prediction IDs, and first-publication hashes.

## Trigger & Scope

DDRv2 maintains one official public lock outcome per **canonical confirmed depeg incident**. The live `/api/depeg-resolver` board is active/current only, but each row is a stateful projection of the durable incident:

- `depeg_events.ended_at IS NULL` (the event is still open), and
- the tracked stablecoin has not already entered a terminal lifecycle state (`frozen`, `dead`, `defunct`, `failed`, or `cemetery`), and
- the event passes confirmation (provenance `auditVerdict` is not `false_positive`, `disputed`, or `no_data` where provenance exists).

Closed and terminal events feed DDRR coverage and review, not new live DDR predictions. Terminal lifecycle events also leave the live DDR board even when the raw depeg row remains open: once registry status proves the asset is frozen/dead, the "time to repeg" question has no finite observable answer, so DDRR owns the audit result instead of DDR publishing an infinite-duration live incident. DDR inherits the clean confirmed-event stream from the [depeg detection pipeline](./depeg-detection.md) (100 bps USD / 150 bps non-USD thresholds plus multi-source confirmation), so it does not re-run depeg detection.

## DDRv2 Public Forecast Contract

DDRv2 freezes exactly one official lock outcome per canonical incident key. The public identity is `incidentKey`, not the mutable `depeg_events.id`, so delete/reinsert repair, merge, split, or start-time repair cannot silently create a second public prediction. The lock policy is methodology-owned:

- `DDR_PREDICTION_POLICY_VERSION = "sticky-24h-v1"`
- `DDR_PUBLIC_PREDICTION_DELAY_SEC = 24 * 3600`
- `DDR_LOCK_ON_TIME_GRACE_SEC = 20 * 60`
- `DDR_V2_EFFECTIVE_AT = 1779897600` (May 27, 2026 00:00:00 UTC)

The first healthy run at or after `started_at + 24h` seals either:

- a frozen prediction (`prediction.state = "frozen"`) with the Stage 1 verdict, anchored duration, lock timestamp, lock timing, and first-publication metadata, or
- a no-call (`prediction.state = "no_call"`) when the run is healthy but row-level inputs are insufficient.

Before the lock point, rows use `pending_lock` and show live facts plus the lock countdown without a verdict or duration. If the lock point arrives while global/system health predicates fail, rows use `lock_deferred`; system-health deferrals do not create no-calls. If sealing succeeds but the first-publication manifest has not finalized, rows use `publication_retry_pending`; the sealed verdict, duration, and no-call details remain hidden until first publication succeeds.

Frozen means frozen. Later prices, supply changes, methodology versions, better input coverage, or a worse peak do not mutate the official public prediction. Live incident status, current deviation, age, staleness, and degraded overlay details are shown as live facts beside the frozen lock outcome.

Errata are append-only. If a source event or input is later proven wrong, DDR keeps the original first-publication exposure visible as `invalidated`, shows the original frozen prediction or no-call outcome, and attaches the latest erratum/history. Repairs require explicit lineage/authorization rather than automatic nearby-event linking.

Short depegs are not predicted after the fact. If a confirmed incident recovers before the 24h lock point, DDRR classifies it as `resolved_before_prediction`; reliable terminal evidence before the lock point becomes `terminal_before_prediction`. Incidents that crossed eligibility but never received a public prediction become explicit coverage debt such as `missed_lock_recovered`, `missed_lock_terminal`, `publication_failed`, `orphan_closed`, or `data_quality_gap`.

**Both directions are in scope.** For a below-peg break (underpeg) the kill signals do real work — this is where the terminal-vs-recoverable call matters. For an above-peg break (overpeg) recovery is quasi-certain (a premium mean-reverts as soon as minting/arbitrage works), so Stage 1 is almost always `recovery_likely` and the headline shifts to Stage 2 duration: how long the premium persists. The exception is a structurally sticky premium (minting paused or capped, or a NAV/yield token), which Stage 1 surfaces as `at_risk` rather than terminal.

## Stage 1 — Resolution Outlook (terminal vs recoverable)

Stage 1 combines **what the coin *is*** (structural fragility — can supply be weaponized, can backing fail, can it be frozen) with **what the depeg *looks like*** (event fingerprint — depth, speed, supply behavior, live stress signals). The output is an ordinal verdict plus the dominant reasons. It is transparent and inspectable, never a black box.

### Inputs

**Structural fragility** (static registry plus slow scores): `mintAuthority` posture / path / confidence, `mechanismArchetype`, governance flag, collateral quality, custody model, deployment model, reserve risk, blacklistability, dependencies, redemption capacity and route family, and the Report Card overall score as a coarse prior.

**Event fingerprint** (event row plus live and reconstructed signals): depth bucket from `peak_deviation_bps`; direction; speed from start-to-peak timing; supply behavior (Δ7d / Δ30d from daily supply history plus mint/burn net flow into the break — the supply-weaponization tell); live DEWS band and which sub-signals fire; liquidity and exit signals; concurrent blacklist surge; and the orphan-close flag from related closed events.

### Kill signals (terminal pressure)

Each kill signal is rated `none`, `elevated`, or `severe`.

| # | Kill signal | Fires when |
|---|---|---|
| **K1** | Supply weaponization | Mint authority concentrated or unbounded/compromised **and** abnormal supply or mint expansion into the depeg (the USR archetype) |
| **K2** | Backing impairment | Reserves skew high / very-high and falling, or a dependency is frozen or dead above the weight threshold — collateral no longer covers liabilities |
| **K3** | Freeze / seizure | Concurrent blacklist surge with a freezable token, sanctioned or frozen custody, or a regulatory shutdown — recovery administratively blocked |
| **K4** | Reflexive death-spiral | Algorithmic (or synthetic with a broken hedge) **and** a price-down-while-supply-chases signature (the UST / IRON archetype) |
| **K5** | Exit collapse | Liquidity erosion plus an unavailable redemption route plus sustained one-sided outflow — no path for arbitrage to restore the peg |

### Recovery anchors

Each anchor is rated `weak` or `strong`.

| # | Recovery anchor | Strong when |
|---|---|---|
| **R1** | Non-inflatable supply | `none-resolved` authority / immutable user-collateralized mint path — supply cannot be printed (LUSD / BOLD) |
| **R2** | Hard collateral + live redemption | Native or very-low-risk collateral, redemption capacity above threshold, functioning route — arbitrage redemption works |
| **R3** | No supply / flow anomaly | Flat supply, no mint surge, calm supply and flow sub-signals — a pure market dislocation |
| **R4** | No single freeze point | Decentralized governance, on-chain custody, not blacklistable — nobody can block recovery |
| **R5** | Proven mean-reversion | Strong historical peg quality, prior depegs all recovered — demonstrated resilience |

### Verdict mapping

The ordinal tiers are `recovery_likely` › `at_risk` › `recovery_unlikely`, plus the `insufficient_signal` escape hatch.

```
if key inputs missing (no MA review, no usable supply history, or no live price)  → insufficient_signal
else if any K severe, OR (>= 2 K elevated AND no strong R among R1, R2)           → recovery_unlikely
else if no K elevated AND >= 2 strong R, including >= 1 of {R1, R2}                → recovery_likely
else                                                                              → at_risk
```

Reasons surface the top fired kill signals (with severity) and the strongest anchors, for example: *"Recovery Unlikely — concentrated minter expanded supply into the break (K1 severe); thin exit liquidity (K5 elevated)."*

### Why Stage 1 is calibrated, not fitted

Stage 1 is a **mechanistic rubric whose thresholds are calibrated by backtest, not learned weights.** This is a deliberate response to the data we actually have.

Terminal-outcome labels are small, editorial, and not event-linked: roughly 88 curated dead stablecoins (month-level `deathDate`, editorial narrative only), a handful of frozen tracked coins (day-level freeze dates), and two shadow assets (UST and IRON) with backfilled events. Against that sit hundreds of cleanly-timed recovered events. You **cannot** fit a supervised terminal classifier on ~90 mostly month-precision labels that do not join to a clean feature vector at the depeg moment. You **can** encode the domain priors as a transparent rubric and calibrate/backtest it against those deaths plus the recovery corpus.

The rubric thresholds (what counts as an "abnormal" supply expansion, the liquidity-collapse cutoffs, the score boundaries) are tuned against the label corpus, then validated. We publish a backtest summary as a methodology fact, not a per-event probability, and we state the small sample size plainly.

## Stage 2 — Expected Duration (conditional on recoverable)

Stage 2 is computed only when Stage 1 is `recovery_likely` or `at_risk`. For `recovery_unlikely` it is suppressed and the UI shows "comparable events did not recover" with a link to the cemetery. For `insufficient_signal` it is suppressed with the missing-inputs reason.

### Method

Stage 2 is an empirical **landmark survival** estimate over the clean corpus of *recovered* incidents.

1. **Incident grouping + quarantine.** Event fragments for the same coin and direction are collapsed into incidents (reopens within 6h merged; 6–24h reopens flagged). Training inclusion is **not** verdict-gated — the depeg provenance side-table is unpopulated in production, so audit-verdict filtering would drop 100% of the corpus. Quality instead comes from incident grouping, a minimum-severity/duration floor that drops microstructure noise, and quarantine of flappy high-frequency coins (the rule that catches susd-synthetix, gusd-gemini, dola, and similar high-count flappers).

2. **Stratification, most-dependable-first.** A dependable wide band beats a precise band built on three incidents. The MVP strata, in order of how readily they are dropped:
   - **direction** (`above` vs `below`) — overpeg and underpeg resolve on different clocks and are never pooled.
   - **depth** — `minor` (≤250 bps) / `moderate` (250–1000) / `severe` (1000–2500) / `catastrophic` (>2500), validated by the monotonic depth→duration relationship in the corpus. Support-gated collapse can pool catastrophic with severe, then with the non-minor severe/moderate bucket when a bucket is thin; severe/catastrophic live events do not borrow the minor-flap clock.
   - **structural class** — a coarse two-way split (`robust`: immutable CDP or fully-reserved fiat; `fragile`: algorithmic, synthetic, or impaired-collateral) from the same Stage-1 structural inputs.
   - **peg currency** (USD vs non-USD) — applied only as a refinement and dropped first when thin.

   The fallback order is: exact full stratum → drop currency → drop or pool the non-minor depth split while preserving structural class → drop the structural split, reporting the actual stratum used. Finer splits (full 4-bucket depth at all times, 3-way structural class) are deferred until real-data counts justify the support.

3. **Landmark estimate at age `t`.** Among historical incidents in the stratum still open at age `t` and label-observable for a given horizon, compute the empirical resolution likelihood and the conditional remaining-time distribution. Historical depth is evaluated as observed by landmark age `t`, not from a closed incident's final peak. The headline is the **median remaining time-to-repeg plus an interquartile remaining-time band**; the secondary readout is per-horizon (6h / 24h / 7d / 30d) resolution probability.

4. **Support gates + intervals.** Cells carry one of the support states (`benchmarked`, `thin_support`, `no_comparable_closures`, `chronic_tail`, `unsupported`, `data_issue`). Effective-N (Kish), leave-one-coin sensitivity, and Wilson display intervals rounded to 5pp guard the published numbers. When a gate fails, the cell shows its support state — never a fabricated 0% / 100%. A `chronic_tail` flag appears when the active event already exceeds the stratum's P99, surfaced as "unusually prolonged."

No leakage: a closed event's final peak severity is never used to estimate a live event's duration.

### Output

- `Expected to resolve within ~6–24h` (median plus IQR band), labeled with the stratum and its support state.
- Horizon cells with a resolution probability where gates pass, otherwise the support state.
- A `chronic_tail` indicator when the open event is already past the stratum's P99.

## DDRR — Depeg Duration Resolver Reviewer

The Depeg Duration Resolver Reviewer (DDRR) is the audit companion to DDR. DDR answers an open-event question; DDRR asks whether a stored DDR answer later matched canonical Pharos event data.

DDRR does **not** replay today's resolver over old events. DDRv2 scores only frozen outcomes that entered the first-publication manifest through `checkpoint = 'public_prediction'`. Diagnostic checkpoints (`first`, `age_1h`, `age_6h`, `age_24h`, `age_7d`, and `latest`) remain useful for audit, but they are not headline public predictions. The review layer compares the frozen first-published outcome with the later canonical incident state and tracked-coin lifecycle status.

The public module on `/depeg/` sits directly below DDR and separates coverage/accountability from accuracy. It surfaces prediction coverage, scoreable coverage, publication success, no-call share, invalidation rate, and missed-lock/deferred states before treating any row as an accuracy sample.

- **Recovery likelihood** — strict accuracy for scored DDR recovery verdicts. Correct recoverable and correct terminal calls count in the numerator; false terminal, false recoverable, and `at_risk` terminal outcomes are scored in the denominator. Pending, insufficient-signal, and data-issue rows are excluded.
- **Recovery duration** — average signed observed-minus-DDR duration error for recovered rows with a duration estimate. Positive means the observed recovery took longer than DDR's median remaining-time estimate; negative means it recovered faster. The module also shows the average absolute error as context.

Review outcomes are deliberately conservative:

- A still-open event remains `pending` unless tracked lifecycle status supplies terminal evidence; open status alone is never counted as proof that a terminal call was right.
- A closed event with a recovery price is `recovered`.
- A terminal/frozen tracked asset without a recovery price is `terminal_observed`, even if the underlying depeg row remains open; that lifecycle evidence matures the review as a terminal outcome rather than a pending duration case.
- Missing source rows or closed rows without recovery/terminal evidence are data issues, not wins or losses.

The cache-backed `GET /api/depeg-resolver-review` endpoint exposes the same review snapshot used by the UI. Headline stats are computed across the v2 policy universe, while public review rows are capped to keep the D1 cache row bounded; `_meta.publicRowsTruncated` and `_meta.assessmentRowsTruncated` disclose truncation. Missing or invalid snapshots return a degraded `200` with empty rows, matching DDR's public failure mode. Stale review snapshots keep their rows and mark `_meta.degraded=true` / `degradedReason="stale-cache"`.

## Honest Limitations & Failure Modes

- **Stage 1 is calibrated, not learned.** There are roughly 90 terminal labels, mostly month-precision and not event-linked. Verdicts are domain-prior judgments validated on a small set. We state this plainly and never dress a verdict up as a probability.
- **Supply resolution is coarse.** Supply history is daily, so it can miss intra-day spikes; mint/burn coverage exists for only about 141 of 399 tracked coins (the configured issuance chains). A coin with neither usable source degrades to `insufficient_signal` on the supply-dependent kill signals rather than guessing.
- **Empty provenance, so no verdict gating.** The depeg-event provenance side-table is unpopulated in production (0 rows). Audit-verdict filtering would discard the entire corpus, so DDR treats a null verdict as included and relies on incident grouping, quarantine, and the severity floor for quality. Provenance is a future enrichment, not a v1 dependency.
- **Terminal ≠ event-recovery.** A backfilled dead coin (for example IRON) shows "recovered" events because replay closed them on a transient in-band print. Stage 1 terminal truth derives from cemetery / frozen `status` and the live deep-and-sustained-open or orphan pattern (the USR signature), never from the presence of a `recovery_price` on a historical row.
- **Survivorship / selection.** The event corpus spans only the tracking window plus backfill (roughly 2026 onward plus replays). Pre-tracking deaths are not event-linked, so the recovery corpus skews toward the modern, surviving set. Stage 2 bands describe *recovered* incidents — a coin that ultimately dies will look "overdue" before it is reclassified.
- **Abandoned slow-deaths are out of scope.** A coin that fades without a sharp depeg never triggers DDR. This is documented, not hidden.
- **Backfill granularity.** About 95% of corpus rows are replayed at daily/hourly granularity, so very-short backfilled durations can be sampling artifacts. This is acceptable for distributions and is flagged here.
- **Mechanism blind spots.** A novel mechanism with no archetype or mint-authority review degrades to `insufficient_signal` rather than guessing.
- **Reflexivity at the edges.** A confident "Recovery Likely" could itself be read as a signal; the copy stays descriptive, never directive.

## Validation / Backtest Plan (acceptance gates)

DDR is validated by a replay harness over historical events plus the label corpus. The backtest numbers are recorded here and re-run whenever the rubric or grouping version changes.

1. **Stage 1 recall on clear deaths.** For each clearly-attributable death (UST, IRON, USR, plus algorithmic / counterparty cases in the cemetery that map to a datable depeg), the rubric must score `recovery_unlikely` at the death-precursor depeg. The recall target is stated as a number at build, with the `abandoned` set explicitly excluded. The live `usr-resolv` open event (deep below-peg, open 60+ days) is the built-in live acceptance case and must read `recovery_unlikely`.
2. **Stage 1 specificity on recoveries.** For major recoveries (USDC during SVB, DAI on Black Thursday, LUSD / BOLD / crvUSD wobbles) the rubric must **not** say `recovery_unlikely`. The gate is zero false-terminal on the curated recovery set. Robust CDP and fiat coins have no deep below-peg events in the corpus; USDC-SVB-class severe recoveries must not be misread as terminal.
3. **Stage 2 accuracy.** For recovered incidents, the predicted median / IQR at age `t` must contain the realized resolution time at the documented coverage rate; per-horizon calibration (Brier / ECE) is reported on held-out incidents.
4. **Leakage & stability.** Leave-one-coin sensitivity on Stage 2; the canonical lineage hash stays stable under row-order changes.
5. **Degradation.** A missing or stale cache returns a degraded `200`; suppressed cells always state a reason.

## Data Plumbing

Both stages are precomputed by a cron writer hooked into the existing `sync-stablecoins` flow after depeg-event updates (no new cron trigger), cached in D1, and served by cache-backed endpoints. The writer resolves canonical incidents, records lock deferrals, seals immutable predictions/no-calls, finalizes first-publication manifests, and then projects the public DDR cache from sealed outcomes plus live overlays. The same job rebuilds the DDRR review snapshot from first-publication exposure, errata, and policy-universe coverage rows. DDRR persistence or snapshot failures are recorded in cron metadata without failing an already-written DDR run unless the cron abort signal has fired. The frontend reads the caches only; there is no model math at request time. The compute layer honors the per-trigger Cloudflare connection pool and writes degraded lock-deferral overlays rather than inventing verdicts during unhealthy runs.

The runtime-neutral engine lives in `shared/lib/depeg-resolver/` (`inputs.ts`, `strata.ts`, `incident-groups.ts`, `resolution.ts`, `duration.ts`, and `index.ts` exposing `resolveDepeg`). Shared types and Zod schemas live in `shared/types/depeg-resolver.ts`. The worker precompute writer and the cache-backed `GET /api/depeg-resolver` handler degrade to a `200` with empty rows when the cache is missing, and serve stale rows with warnings. Pre-publication rows never expose verdicts or duration bands; frozen rows expose anchored predictions plus live overlay facts.

The runtime-neutral reviewer lives in `shared/lib/depeg-resolver-review/`, with shared schemas in `shared/types/depeg-resolver-review.ts`. The worker snapshot builder lives in `worker/src/cron/compute-depeg-resolver-review.ts`; its public cache helper and endpoint are `worker/src/lib/depeg-resolver-review-snapshot-cache.ts` and `worker/src/api/depeg-resolver-review.ts`.

## Key Files

| File | Purpose |
|------|---------|
| `shared/lib/depeg-resolver/index.ts` | Engine entrypoint (`resolveDepeg`): Stage 1 verdict + Stage 2 duration per active event |
| `shared/lib/depeg-resolver/resolution.ts` | Stage 1 kill-signal / recovery-anchor rubric and verdict mapping |
| `shared/lib/depeg-resolver/duration.ts` | Stage 2 stratified landmark estimate + support gates |
| `shared/lib/depeg-resolver/strata.ts` | Depth / direction / structural / currency stratification keys |
| `shared/lib/depeg-resolver/incident-groups.ts` | Incident grouping + quarantine of flappy coins |
| `shared/lib/depeg-resolver/inputs.ts` | Engine input shapes (active event, structural, supply, live context) |
| `shared/types/depeg-resolver.ts` | Shared DDR types + Zod schemas |
| `shared/lib/depeg-resolver-review/` | Runtime-neutral DDRR outcome, duration-error, horizon-review, and summary logic |
| `shared/types/depeg-resolver-review.ts` | Shared DDRR assessment, review row, summary, meta, and response schemas |
| `worker/src/lib/depeg-resolver-assessment-store.ts` | DDR assessment checkpoint persistence for later review |
| `worker/src/cron/compute-depeg-resolver-review.ts` | DDRR snapshot builder from stored assessments and actual event outcomes |
| `worker/src/api/depeg-resolver-review.ts` | Cache-backed public DDRR endpoint |
| `shared/lib/methodology-versions/depeg-resolver.ts` | Methodology version constants + changelog |
| `shared/lib/depeg-resolver-version.ts` | Re-export of the version constants |
