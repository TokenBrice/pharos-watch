# Dated source age caps

This runbook covers reserve sources and retained-data windows whose publication behavior changes at a known boundary. The named owner in each row is accountable for its observation. Treat calendar times as UTC operational deadlines and count thresholds as observation triggers, not as estimates of when an issuer or pipeline will change.

## Scheduled boundaries

| Boundary instant | Coin | Constant | Symptom | Refresh procedure | Owner |
| --- | --- | --- | --- | --- | --- |
| 2026-10-02T00:00:00Z | EURQ/USDQ (Quantoz) | 33-day live-reserve source-age cap | The August 30 disclosure remains stale in October even when fetched again; 99% whole-number rounding is informational, not the rejection cause. | Verify the `Published snapshot` `<time datetime>` and each token's reported-composition card, circulation and reserve ratio; only a genuinely newer issuer disclosure renews freshness. | Reserve evidence maintainer |
| 2026-10-08 (00:00 / 08:00 UTC) | EUROP (`europ-schuman`) | Separate 100-day V9 assurance and 150-day live-source (`LAGGED_QUARTERLY_ATTESTATION_SOURCE_MAX_AGE_SEC`, from 2026-10-24) caps | V9 assurance ages from UTC start of June 30; the live report ages from its reviewed 08:00 UTC as-of clock. Each becomes stale only past its cap; refetching does not renew either. | Verify the newest SALVUS report's exact URL, SHA-256, byte length, dates and complete asset/liability rows; update the reviewed manifest before the retained fetch snapshot's two-day grace expires. | Reserve evidence maintainer |
| Non-blocked digest count reaches 360 (projected January 2027) | Digest archive | 365-row public response limit | The archive is approaching its first window eviction; edition labels must remain stable when older rows leave the response. | Count all non-blocked `daily_digest` rows during the crossing month, compare shared edition labels before and after the first eviction, and confirm the oldest returned daily and weekly editions retain their full-history numbers. | Digest pipeline maintainer |
| 2026-10-10T00:00:00Z | JLTXX (`jltxx-jpmorgan`) | Quarantined listing review deadline | Lifecycle remains quarantined; the current config has no `bootstrapForSupplyAdmission` authorization. | Require an explicit operator decision plus legal/native-share scope, pinned supply, matched NAV and runtime price/market-cap PASS; see [listing policy](../listing-policy.md#lifecycle-policy). Staged evidence is not admission. | Reserve evidence maintainer |

### Suspended-source and stale-publisher recovery

These are source-owned holds, not automatic calendar reactivation. Access/upload/signature clocks cannot replace tested balance dates. Prior snapshots retain their clocks and warnings.

| Source | Hold / review boundary | Required recovery evidence and action |
| --- | --- | --- |
| DLLR / Mynt ZUSD claim | Zero halted November 7; November 12 review retains unavailable whole-book composition and suspended Mynt conversions; next owner review November 19 | Keep active monitoring while the owner reviews the lifecycle proposal. [Sovryn's recovery manifest](https://forum.sovryn.com/t/sovryn-mitigation-and-recovery-manifest/3611) records precautionary containment, not DLLR termination. Before replacing the unavailable fallback or reopening the channel, verify authorized reviewed ZUSD implementation restoration (or an approved replacement), readable balances and a reconciled current book, plus successful funded DOC/ZUSD conversions for the supported paths. Readable DOC alone or false Mynt pause flags are insufficient. The reserve reader remains enabled and fail-closed; this is an evidence/recovery hold, not a source-suspension flag. Reserve evidence maintainer owns the follow-up. |
| XUSD / BabelFish conversion | Ownership stop November 4; November 12 review retains the conversion suspension; next owner review November 19 | Keep active monitoring with the incident notice. The [recovery manifest](https://forum.sovryn.com/t/sovryn-mitigation-and-recovery-manifest/3611) requires qualified code/settings and authorized recovery before restrictions change. Verify restored converter mint/burn authority, successful funded basket redemption, complete current backing/bridge valuation and a reconciled liability book before lifting the corresponding holds. Historical composition dates remain unchanged; exact-contract market recovery is a separate pricing question. The [reward-inventory disclosure](https://forum.sovryn.com/t/sovryn-attack-disclosure-bob-rootstock-and-babelfish/3612) establishes no equal remaining-holder loss. No automatic reactivation at the review date; reserve evidence maintainer owns the follow-up. |
| USDXL | Suspended August 27; October 26 review continued the hold; next review November 20 | Complete facilitator/deployment map, pinned gross borrower collateral/debt and every PSM, including USDT0, must reconcile the book. Repair pool-cash-versus-gross and omitted-facilitator regressions before removing suspension. |
| Nest inALPHA | Suspended September 9; review March 9, 2027 or actual publisher repair | October 7 positions $0.410183 versus NAV $1.8890182896 and accountant clock 1771867979 remain incompatible. Current accountant prices and complete positions must reconcile under both clock/coverage gates in `nest-vault-positions`; dust/empty positions are not 100% cash. |
| tGBP | Suspended September 11 after Worker 403; October 26 review (public API 503, newest report August 31) continued the hold; next review November 20 | Issuer-approved deployed Worker access, real schema-valid permitted 200 and persisted success. Local 200 is insufficient and has no accounting timestamp; retain weak-probe/unknown freshness absent separately reviewed dated evidence. |
| USDY | Runtime discovery retired October 8; manual reviewed holdings refresh retained | A new runtime source requires reliable newest-daily archive discovery and the full tracked liability perimeter, including BVI rather than only LLC issuance. HTTP 200 or manual static refresh does not establish independent eligibility; do not revive the retired `usdy-holdings-report` path. |
| ZARSC | August 31 balances; September 16 issue and October 5 webpage publication do not refresh them | New exact balance report within the coin's 70-day `scoring.maxSourceAgeSec`, reviewed facts/artifact and `reviewedReport` update. ISRS 4400 AUP restores static validation only, not independent assurance. |
| USDU | Monthly Crowe examinations land 12-30 days after balance date; coin cap 70 days (`scoring.maxSourceAgeSec`, decision 2026-10-24) | Fresh successor with reviewed engagement, scope, reconciled facts and artifact. Independent-manifest/cadence promotion is separate. |
| wCOP/wARS/wBRL/wMXN | June 30 certifications; August URL folder is hosting date | Fresh currency-specific certification within the 150-day lagged-quarterly adapter cap, preserving `linkMatch` identity guards, restores static validation only. Current reports exclude audit/review opinions; independent-grade requires qualifying current assurance or independent whole-book measurement. |

## Expected publication windows

Escalate a missing report at the end of its window. A discovered newer independent-assurance report is never accepted provisionally: the pinned reviewed report keeps publishing with a degraded `newer-unreviewed-report` warning until its own source-age cap, so verify and update the newer artifact identity before that cap expires. Where a product is bound to a live adapter, its window tracks that adapter's declared source-age tier (`LAGGED_MONTHLY_EXAMINATION_SOURCE_MAX_AGE_SEC` for GUSD, `NEXT_MONTH_DISCLOSURE_SOURCE_MAX_AGE_SEC` for the month-end publishers whose successor lands weeks into the following month, the shared late-monthly tier otherwise), so the escalation deadline and the runtime admission ceiling stay one authority; products without a runtime binding keep their reviewed-manifest publication window.

Every publication window below is owned by the reserve evidence maintainer.

| Product | Expected publication window |
| --- | --- |
| EUROP | Quarterly; by 150 days after period end |
| GUSD | Monthly; by 75 days after period end |
| PGOLD | Ad-hoc reviewed reports; no verified 47-day publication deadline or report-age tier on its `single-asset` adapter |
| TGBP | Monthly reviewed reports; its suspended `single-asset` feed declares no report-age cap |
| TRYB | Quarterly reviewed reports; its `single-asset` feed declares no report-age cap |
| USX (`usx-solstice`) | Weekly live attestations; 14-day source-age ceiling in `solstice-attestation` |
| Other dated-report publishers bound to live adapters | Read `proofOfReserves.cadence` and `liveReservesConfig.adapter` in the product's `shared/data/stablecoins/coins/*.json`. Resolve the adapter's `validation.maxSourceAgeSec` through `shared/types/live-reserve-adapter-declarations.ts` and its referenced policy; any coin `liveReservesConfig.scoring.maxSourceAgeSec` may tighten that ceiling. Escalate at the resulting report-age ceiling. |

## Refresh checklist

1. Use the official report index and select the newest dated candidate.
2. Verify exact URL, content SHA-256, byte length, engagement type, tested balance date, publication date, complete reconciled assets/liabilities and slice scope. Fetch, folder, signature and upload dates do not renew historical balances.
3. Preserve fail-closed behavior: do not widen a URL pattern, reuse an old hash, or accept an unreviewed newer report.
4. Human-review the manifest or `params.reviewedReport` and curated reserve review together, preserving currency-specific `linkMatch`; run targeted adapter checks and deploy through normal sync/recovery.
5. Observe an actual attempt and API readback, distinguishing static restoration from independent scoring eligibility. `attestation-pdf-index` declares the 150-day lagged-quarterly ceiling for quarterly Ripio wFIAT reports; monthly publishers tighten it per coin (USDU and ZARSC 6,048,000 s / 70 days, ZARP 4,000,000 s); do not excuse `stale-redemption-source-timestamp`, manufacture cash weights or treat reports as executable redemption capacity.
