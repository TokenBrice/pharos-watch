# Pre-Cliff MiCA / GENIUS Baseline & Rolling Validation Archive

Pre-registered quasi-experimental design and immutable archival procedure for the January 2027 EU MiCA CASP remediation deadline (`2027-01-08`, GitHub `#2215`) and the U.S. GENIUS Act statutory effective date (`2027-01-18`, GitHub `#2238`).

The SHA-256 digest of this document (`designSha256`) is sealed into the immutable December 2026 baseline manifest by `scripts/maintenance/freeze-validation-archive.ts` before either regulatory cliff arrives. Operational run logs and post-seal manifest digests live separately in the unhashed [Sealed Baseline Run Log](./pre-cliff-baseline-log.md) so recording sealed run receipts never alters `designSha256`.

Verify a sealed manifest's `designSha256` independently against the committed design document at `gitSha`:

```bash
git show <gitSha>:docs/process/pre-cliff-baseline.md | sha256sum
```

## 1. Events & Identification Strategy

Two regulatory cliffs fall ten calendar days apart, with distinct legal scopes:

1. **MiCA CASP remediation cliff (`2027-01-08`):** ESMA Opinion `ESMA75-113276571-1742` (8 Oct 2026) instructs NCAs to have EU crypto-asset service providers remediate legacy exposure to non-MiCA-compliant EMTs/ARTs by 8 January 2027. National CASP transitional grandfathering windows already ended on 1 July 2026 (MiCA Art. 143(3)).
2. **GENIUS Act statutory effective dates (Public Law 119-27, enacted 18 July 2025):**
   - **Issuer & regulatory framework effective date (`2027-01-18`, §20):** Public Law 119-27 §20 sets general effectiveness at the earlier of 18 months after enactment (`2027-01-18`) or 120 days after qualifying final implementing regulations. OCC final rules were published `2026-10-23` (91 FR 67000; `GENIUS_REGIME_STATE.rulemakingPhase = "final-rules-issued"` in `shared/lib/compliance-regime-state.ts`), whose +120-day mark (`2027-02-20`) falls later, leaving `2027-01-18` as the operative statutory effective date for issuer licensing, supervision, and the §3(a) unpermitted-issuer issuance restriction unless amended.
   - **DASP offer/sale prohibition (`2028-07-18`, §3(b)):** The statutory prohibition on digital asset service providers (U.S. exchanges and intermediaries) offering or selling non-permitted payment stablecoins takes effect **three years after enactment (`2028-07-18`)**, not on `2027-01-18`. Consequently, the `2027-01-18` window measures issuer-side compliance transitions, market anticipation, and voluntary venue adjustments, whereas the binding U.S. exchange offer/sale cliff arrives on `2028-07-18`.

### Treatment Overlap & Identification

As shown in the MiCA × GENIUS cross-tab in §2, **32 of 34** active MiCA `non-compliant` coins are also GENIUS-treated (`22` `no-public-authorization-found` and `10` `issuer-announced-intent`; only `2` are GENIUS `not-applicable`). Consequently, `[0, +30]` and `[0, +90]` coin-level difference-in-differences (DiD) windows overlap both `2027-01-08` and `2027-01-18`. Identification therefore combines:

- **Clean MiCA-only post-cliff window `[0, +9]` (`2027-01-08` through `2027-01-17`):** Ten calendar days strictly after the MiCA CASP remediation deadline and strictly before the `2027-01-18` GENIUS statutory effective date, isolating immediate MiCA remediation moves in on-chain supply, DEX liquidity, and peg stability. Early year-end CASP compliance (`2027-01-01..2027-01-07`) is inspected separately in event-study leads.
- **On-chain / DEX DiD contrasts:** Primary causal estimates run on the active coin panel (`n = 343` at `c4ec79a08`) using frozen pre-cliff cohorts for supply, DEX liquidity/volume, and peg stability across `[0, +9]`, `[0, +30]`, and `[0, +90]`, reporting overlapping MiCA × GENIUS strata separately rather than claiming full coin-level separability beyond `+9` days.
- **Descriptive / secondary CEX orderbooks and regional eligibility notices:** Kraken (`kraken-global`) and Coinbase Exchange (`coinbase-global`) expose **shared global spot orderbooks**, not jurisdiction-segregated EEA-vs-US liquidity books, and the verified live CEX roster covers only 9 coins (17 global pairs) — well below the `>= 20` active-coin arm gate. CEX `±1%` orderbook depth is therefore pre-registered strictly as **descriptive / secondary** microstructure evidence, paired with separately archived official regional-eligibility notices rather than treated as a causal EEA-vs-US DDD arm.

Reference venue and notice records tracked in the sealed baseline manifest (`venues`, static review metadata dated separately from live run `capturedAt`) and live notice observations (`regionalEligibility`):

- **Shared global CEX orderbooks (descriptive / secondary):** `kraken-global` (Payward, Inc.; resolved dynamically via `/0/public/AssetPairs`), `coinbase-global` (Coinbase, Inc.; resolved dynamically via `/products`).
- **Regional eligibility & primary notice sources (`#2215`):** `kraken-eea-eligibility` (Payward Europe Solutions Limited — EEA stablecoin offerings notice), `coinbase-eea-eligibility` (Coinbase Europe Limited — MiCA restricted stablecoins notice; archived when reachable, otherwise explicitly marked `unavailable`), `esma-emtwp-register` (ESMA EMT white-paper CSV register), `stablr-holder-notices` (StablR dissolution/winding-up notices).
- **Permissionless on-chain market surface:** `dex-permissionless` (aggregated on-chain DEX liquidity and volume from `/api/dex-liquidity`).

## 2. Frozen Pre-Cliff Cohorts (`c4ec79a08` Census)

Cohort membership is **frozen at the December 2026 seal commit** (`gitSha` + `designSha256`) and never back-updated after post-cliff delisting notices, withdrawals, or new approvals. Post-cliff status changes are recorded separately to compare intent-to-treat (frozen pre-cliff assignment) against treatment-on-treated sensitivity without look-ahead bias.

**Non-coercion rule:** an absent `mica` or `genius` compliance sidecar means `unassessed` (research gap) and is **never** coerced to `non-compliant`, `out-of-scope`, `no-public-authorization-found`, or `not-applicable` ([mica-tracker.md](../mica-tracker.md#status-criteria), [genius-tracker.md](../genius-tracker.md#applicability)).

Exact cohort census derived directly from the Git-tracked per-coin source files under `shared/data/stablecoins/coins/*.json` (519 total coins: 343 active, 66 pre-launch, 43 frozen, 56 delisted, 11 quarantined) and compliance domain sidecars under `shared/data/stablecoins/domains/compliance/*.json` (402 sidecar rows) at commit `c4ec79a08` — with zero dependency on gitignored `coins*.generated.json` artifacts:

### Active DiD Panel Universe (`n = 343` active stablecoins; 306 with compliance sidecars + 37 unassessed in both regimes)

| Regime | Cohort (`cohorts[].mica` / `cohorts[].genius`) | Active coins | Distinct issuers | Power gate (`>= 20` coins) | Role in design |
| --- | --- | ---: | ---: | --- | --- |
| MiCA | `authorized` | 14 | 10 (`authorizedEntity`) | Below gate (descriptive unless `>= 20` at seal) | Licensed EEA beneficiary / descriptive arm (multi-token issuers cluster 14 coins into 10 entities) |
| MiCA | `pending` | 1 | 1 | Below gate (`usdm-moneta`; excluded from primary arm) | Tracked separately |
| MiCA | `transitional` | 0 | 0 | Empty (Art. 143(3) ended 2026-07-01) | Not applicable |
| MiCA | `non-compliant` | 34 | ~30 | Passes (`>= 20`) | Primary MiCA treated arm (in-force EU venue notices; 32/34 also GENIUS-treated) |
| MiCA | `out-of-scope` | 177 | ~170 | Passes (`>= 20`) | Primary MiCA control / placebo arm |
| MiCA | `unassessed` | 117 | ~113 | Separate (never coerced to `non-compliant`) | Excluded from primary contrast; sensitivity check only |
| GENIUS | `ppsi-approved` | 0 | 0 | Empty pre-effectiveness | Monitored for pre-cliff approvals |
| GENIUS | `state-qualified` | 0 | 0 | Empty pre-effectiveness | Monitored for pre-cliff approvals |
| GENIUS | `official-application-pending` | 0 | 0 | Empty pre-effectiveness | Monitored for pre-cliff filings |
| GENIUS | `issuer-announced-intent` | 19 | 13 | Below gate (`19 < 20`; descriptive or pooled sensitivity) | Major USD issuers (`usdt-tether`, `usdc-circle`, `pyusd-paypal`, `rlusd-ripple`, `usdp-paxos`; all 19 `apparent-payment-stablecoin`) |
| GENIUS | `no-public-authorization-found` | 138 | ~125 | Passes (`>= 20`) | Primary GENIUS treated arm: **64** `apparent-payment-stablecoin` (cleanest in-scope stratum) + **74** `unclear` (separate sensitivity stratum) |
| GENIUS | `not-applicable` | 122 | ~120 | Passes (`>= 20`) | Primary GENIUS control / placebo arm (110 `non-payment-token` + 12 `excluded-security`) |
| GENIUS | `unknown` | 6 | 6 | Below gate | Excluded from primary contrast |
| GENIUS | `unassessed` | 58 | ~58 | Separate (never coerced) | Excluded from primary contrast |

### MiCA × GENIUS Active Treatment Cross-Tab (`n = 343` at `c4ec79a08`)

| MiCA \ GENIUS | `no-public-authorization-found` | `issuer-announced-intent` | `not-applicable` | `unknown` | `unassessed` | **MiCA total** |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `authorized` | 13 | 1 | 0 | 0 | 0 | **14** |
| `pending` | 0 | 1 | 0 | 0 | 0 | **1** |
| `non-compliant` | 22 | 10 | 2 | 0 | 0 | **34** |
| `out-of-scope` | 40 | 4 | 110 | 2 | 21 | **177** |
| `unassessed` | 63 | 3 | 10 | 4 | 37 | **117** |
| **GENIUS total** | **138** | **19** | **122** | **6** | **58** | **343** |

Key structural facts from the cross-tab:

- **32 of 34** active MiCA `non-compliant` coins are simultaneously GENIUS-treated (`22` `no-public-authorization-found` + `10` `issuer-announced-intent`), leaving only `2` MiCA-only `non-compliant` coins (`not-applicable` under GENIUS).
- **Major USD coins** (`usdt-tether`, `usdc-circle`, `pyusd-paypal`, `rlusd-ripple`, `usdp-paxos`) sit in GENIUS `issuer-announced-intent` (`n = 19` coins / `13` issuers), not `no-public-authorization-found`. Primary GENIUS regressions therefore report (a) `apparent-payment-stablecoin` + `no-public-authorization-found` (`n = 64`), (b) pooled in-scope `apparent-payment-stablecoin` (`64 + 19 = 83`), and (c) `unclear` (`n = 74`) separately against `not-applicable` (`n = 122`).

### Full Tracked Compliance Sidecar Census (`shared/data/stablecoins/domains/compliance/*.json`, `n = 402` rows across all lifecycle statuses)

- **MiCA (`n = 402`):** `authorized` 37 (14 active, 20 pre-launch, 3 frozen), `pending` 1, `transitional` 0, `non-compliant` 35 (34 active, 1 frozen), `out-of-scope` 221, `unassessed` 108 (GENIUS-only sidecars).
- **GENIUS (`n = 402`):** `ppsi-approved` 0, `state-qualified` 0, `official-application-pending` 0, `issuer-announced-intent` 23, `no-public-authorization-found` 155, `not-applicable` 172, `unknown` 6, `unassessed` 46 (MiCA-only sidecars).

## 3. Outcomes, Windows & Estimation

### Outcomes

1. **Observed circulating supply (primary):** `log(observed_circulating_usd)` using `getCirculatingRawOrNull` semantics. Unavailable supply stays `null` (never zero-filled, ADR-28 / R1); explicit observed zero is tracked separately via extensive-margin indicators.
2. **DEX liquidity & volume (primary):** DEX TVL (`log(1 + tvlUsd)` when observed) and 24h DEX volume from `/api/dex-liquidity` and daily `/api/snapshots/<date>.json`.
3. **Peg stability (primary):** absolute peg deviation `|peg deviation|` in bps from `/api/peg-summary` and daily snapshots.
4. **CEX global orderbook depth & regional eligibility (descriptive / secondary):** `±1%` quote-currency depth (`bidDepthQuote1pct`, `askDepthQuote1pct`), same-run FX-converted USD depth (`bidDepthUsd1pct`, `askDepthUsd1pct`, `fxRate`, `fxSource`, `fxObservedAt`; `null` when FX is unavailable — never raw EUR written into USD fields), explicit truncation flags (`bidDepthTruncated`, `askDepthTruncated` whenever the last returned book level remains inside `±1%`), strict tri-state `listed` (`true` only on schema-valid orderbooks, `false` only on explicit catalog `status === "delisted"`, confirmed absence from a non-empty catalog, or Kraken `EQuery:Unknown asset pair`, and `null` on empty catalogs, `trading_disabled`, `offline`/`internal`/unknown product statuses, rate-limit/HTTP failures, or malformed top-of-book/orderbook payloads), and separately archived regional eligibility notices (`kraken-eea-offerings`, `coinbase-eea-mica`, `esma-emtwp-register`, `stablr-holder-notices`).
5. **Safety Score grade / score (descriptive only):** captured from `/api/report-cards/v9` and rolling daily-first accepted archives for descriptive context only — never as a causal outcome, because methodology and curation updates move grades independently of regulatory shocks.

### Windows & Estimator

- **Event windows:** pre-cliff `[-30, -1]` days; clean MiCA-only post-cliff `[0, +9]` days (`2027-01-08..2027-01-17`); short post-cliff `[0, +30]` days; medium post-cliff `[0, +90]` days relative to `2027-01-08` and `2027-01-18`. (The `2028-07-18` GENIUS §3(b) DASP offer/sale prohibition is tracked as a separate downstream event window.)
- **Fixed effects & clustering:** coin + day fixed effects (`alpha_i + gamma_t`), with standard errors clustered by **issuer** (`issuerEntity` / canonical issuer group). Effective cluster counts are reported alongside coin counts because multi-token issuers compress clusters (e.g., MiCA `authorized` = 14 active coins across 10 EEA entities; GENIUS `issuer-announced-intent` = 19 coins across 13 issuers).
- **Minimum arm-size gate (`>= 20` active coins):** any cohort arm below 20 active coins at seal (and the 9-coin global CEX sample) is reported descriptively only, never as a headline causal estimate.

## 4. Falsifications & Robustness

1. **Clean pre-cliff placebo event dates:** re-estimate the full coin-panel specification on three pre-cliff dates whose pre- and post-windows do not collide with the `2026-07-01` MiCA Art. 143(3) expiry, the `2026-10-08` ESMA opinion, the `2026-10-23` OCC final rule, or the January 2027 cliffs:
   - `2026-08-15` with window `[-21, +14]` (`2026-07-25 .. 2026-08-29`)
   - `2026-11-16` with window `[-14, +14]` (`2026-11-02 .. 2026-11-30`)
   - `2026-12-07` with window `[-14, +14]` (`2026-11-23 .. 2026-12-21`)
2. **Pre-trend test:** event-study leads over `[-30, -1]` with a joint F-test against zero differential pre-trend across arms.
3. **Placebo cohort:** test `out-of-scope` (MiCA) and `not-applicable` (`non-payment-token` / `excluded-security`, GENIUS) coins for spurious regime-date shifts.
4. **Leave-one-out USDT (`usdt-tether`) & GENIUS `unclear` stratum split:** re-estimate supply-weighted and unweighted specifications excluding `usdt-tether`, and separate GENIUS `apparent-payment-stablecoin` (`n = 64`) from `unclear` (`n = 74`).

## 5. Immutable Archive & Rolling Procedure

All validation artifacts write exclusively to `pharos-measurements` under `pinned/validation/...` — **never** under `captures/`, which has a 180-day R2 expiry lifecycle. Every PUT forces `If-None-Match: *`. Payload object PUTs resume safely on retry by re-GETting an existing key and verifying exact byte length and SHA-256 match (failing hard on any mismatch); `manifest.json` collisions always remain fatal (`R2ObjectExistsError`).

- **Pre-cliff baseline seal** (run in December 2026 on or before `2026-12-31`, **after the `daily-0800` (`08:00 UTC`) `snapshot-public-dataset` cron runs** so the seal-day `/api/snapshots/<date>.json` exists; target `2026-12-28` so retry days remain before `2026-12-31`; omit `--seal` or pass `--dry-run` without `--out` for a local preview):
  ```bash
  PHAROS_API_KEY=... npx tsx scripts/maintenance/freeze-validation-archive.ts baseline --date 2026-12-28 --out agents/pre-cliff-baseline-manifest.json
  PHAROS_API_KEY=... npx tsx scripts/maintenance/freeze-validation-archive.ts baseline --date 2026-12-28 --seal --out agents/pre-cliff-baseline-manifest.json
  ```
  - **`PHAROS_API_KEY` is required for `baseline`:** all 4 Pharos endpoints (`/api/snapshots/<date>.json`, `/api/peg-summary`, `/api/dex-liquidity`, `/api/report-cards/v9`) require `X-API-Key`. The script attaches `X-API-Key` strictly when `new URL(apiBase).origin === "https://api.pharos.watch"`, enforces `redirect: "error"` so credentials and responses never follow cross-origin redirects, refuses `--seal` against any non-production `--api-base`/`PHAROS_API_BASE` override unless `--dry-run` is active, and records `apiBase` in the manifest.
  - **Fail-closed seal guards:** `baseline --seal` refuses dates after `2026-12-31`, refuses `--date` disagreeing with actual UTC capture date, refuses uncommitted or untracked changes under `docs/process/pre-cliff-baseline.md`, `shared/data/stablecoins/`, or `shared/lib/compliance-regime-state.ts`, and validates every Pharos API response against its published contract (non-empty `stablecoins` with matching `snapshotDate` on all 14 snapshots, non-empty `coins` with nullable `currentDeviationBps` + `summary` on `/api/peg-summary`, non-empty map with nullable `totalVolume24hUsd` on `/api/dex-liquidity`, non-empty `cards` obeying V9 `ratingStatus`/`grade`/`score` rules including legitimate `pipeline-gap` cards with `grade: null` + valid `safetyScoreIdentity` on `/api/report-cards/v9`) before issuing any R2 PUT. Cohorts and compliance snapshots are derived directly from tracked `shared/data/stablecoins/coins/*.json` and `domains/compliance/*.json` (never gitignored `coins*.generated.json`). Partial seals (`--allow-partial`) are refused on any canonical `pinned/validation/pre-cliff-YYYY-MM/` or `pinned/validation/rolling/` prefix and require a non-canonical `--prefix` (e.g. `pinned/validation/partial/...`). Writes gzipped payloads (`pinned/validation/pre-cliff-2026-12/<sha256>.json.gz`), archived regional eligibility sources (`*.bin.gz`, covering all 4 tracked notice/register sources including `stablr-holder-notices`), and `pinned/validation/pre-cliff-2026-12/manifest.json`.
- **Daily rolling archive & retention cadence:** D1 source retention windows are:
  - `reserve_composition_history` and `reserve_sync_attempt_history`: **30 days** (`LIVE_RESERVE_HISTORY_RETENTION_SEC` in `worker/src/lib/live-reserves/store-shared.ts`).
  - `safety_score_capture_archive` / `captures/`: **180 days** (`SAFETY_SCORE_CAPTURE_ARCHIVE_RETENTION_SEC`).
  - `report_card_evidence_journal`: **dormant** (its writer `appendReportCardEvidenceJournalV1` was retired in `ef1052443`; `roll` still exports any existing rows for archival continuity, but empty exports are normal and do not impose a shorter retention guard).

  Run `roll` **daily** after `00:15 UTC` (enforced 15-minute day-end grace) so live global CEX orderbooks and regional eligibility notices are captured on time, or catch up missed days inside the 30-day reserve-history retention window via resumable `--from/--to`:
  ```bash
  npx tsx scripts/maintenance/freeze-validation-archive.ts roll --date YYYY-MM-DD --dry-run
  npx tsx scripts/maintenance/freeze-validation-archive.ts roll --date YYYY-MM-DD
  npx tsx scripts/maintenance/freeze-validation-archive.ts roll --from YYYY-MM-DD --to YYYY-MM-DD
  ```
  `roll` executes bounded, index-supported read-only remote D1 `SELECT`s (joining `reserve_sync_attempt_history` via `idx_reserve_sync_attempt_history_time` to `reserve_composition_history` via `idx_reserve_composition_history_coin_attempt_unique` to preserve `payload_sha256` and attempt evidence; traversing dormant `report_card_evidence_journal` via `idx_report_card_evidence_journal_retention`; and traversing `safety_score_capture_archive` via `idx_safety_score_capture_archive_published`), skips already-sealed days in `--from/--to` range mode, decodes the M4 daily-first accepted V9 capture through `decodeSafetyScoreCaptureArchiveObject` (`worker/src/lib/safety-score-v9/capture-archive-contract.ts`), samples the clock at live collection to capture live global CEX `markets` + regional eligibility notices for the latest completed UTC day under content-addressed keys (`rolling/markets/<observedDate>.<sha8>.json.gz` and `rolling/eligibility/<observedDate>/<sourceId>.<sha8>.<ext>.gz`) stamped with `observedDate` distinct from D1 `exportDay` (`day`) (recovering prior-day live captures automatically if a manifest PUT failed and the retry runs after UTC midnight, or skipping live orderbooks with `historical-day-no-live-orderbook` on true backfill days), refuses sealing if a required source (`reserve-composition-history`, `v9-accepted`) is missing or older than the 30-day reserve-history retention window (unless `--allow-partial` is passed with a non-canonical `--prefix` or `--dry-run`), and forces `--dry-run` whenever `--local` or a non-default `--database` is selected.
- **Integrity verification** (re-GETs every manifest object, checks exact byte length and SHA-256, validates strict calendar dates and UTC timestamps, re-checks manifest completeness including every successful `regionalEligibility[].r2Key` object, verifies `designSha256` strictly against `git show <gitSha>:docs/process/pre-cliff-baseline.md` with no working-tree fallback, reports `partial` explicitly, and rejects `partial: true` manifests unless `--allow-partial` is passed):
  ```bash
  npx tsx scripts/maintenance/freeze-validation-archive.ts verify --manifest pinned/validation/pre-cliff-2026-12/manifest.json
  npx tsx scripts/maintenance/freeze-validation-archive.ts verify --prefix pinned/validation/
  ```
- **Sealed run log:** Record sealed manifest keys, SHA-256 digests, and verification timestamps in the unhashed [Sealed Baseline Run Log](./pre-cliff-baseline-log.md) rather than editing this file.
