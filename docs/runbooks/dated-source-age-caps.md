# Dated source age caps

This runbook covers reserve sources and retained-data windows whose publication behavior changes at a known boundary. The named owner in each row is accountable for its observation. Treat calendar times as UTC operational deadlines and count thresholds as observation triggers, not as estimates of when an issuer or pipeline will change.

## Scheduled boundaries

| Boundary instant | Coin | Constant | Symptom | Refresh procedure | Owner |
| --- | --- | --- | --- | --- | --- |
| 2026-10-02T00:00:00Z | EURQ/USDQ (Quantoz) | 33-day live-reserve source-age cap | The August 30 disclosure remains stale in October even when fetched again; 99% whole-number rounding is informational, not the rejection cause. | Verify the `Published snapshot` `<time datetime>` and each token's reported-composition card, circulation and reserve ratio; only a genuinely newer issuer disclosure renews freshness. | Reserve evidence maintainer |
| 2026-10-08T08:00:00Z | EUROP (`europ-schuman`) | 100-day assurance-report age cap | The Q2 SALVUS report becomes stale for Safety Score V9. A newer discovered report causes a fail-closed throw; the fetched snapshot also expires after its two-day grace. | Check the official report index for the expected Q3 SALVUS report. Verify the exact report URL, SHA-256, byte length, report date, report-as-of instant, and complete asset and liability rows; update the reviewed manifest and deploy before the prior snapshot's grace expires. | Reserve evidence maintainer |
| Non-blocked digest count reaches 360 (projected January 2027) | Digest archive | 365-row public response limit | The archive is approaching its first window eviction; edition labels must remain stable when older rows leave the response. | Count all non-blocked `daily_digest` rows during the crossing month, compare shared edition labels before and after the first eviction, and confirm the oldest returned daily and weekly editions retain their full-history numbers. | Digest pipeline maintainer |
| 2026-10-10T00:00:00Z | JLTXX (`jltxx-jpmorgan`) | Reserve-only bootstrap authorization expiry | One bounded prerequisite opportunity expires at UTC start of `reviewBy`; lifecycle remains quarantined. | Observe permitted recovery and a durable exact-class NAV/asset attempt before expiry, then perform separate complete supply/fresh price admission; see [listing policy](../listing-policy.md#lifecycle-policy). Failure/expiry requires a separately authorized operator decision. | Reserve evidence maintainer |

### Suspended-source and stale-publisher recovery

These are source-owned holds, not automatic calendar reactivation. Access/upload/signature clocks cannot replace tested balance dates. Prior snapshots retain their clocks and warnings.

| Source | Hold / review boundary | Required recovery evidence and action |
| --- | --- | --- |
| USDXL | Suspended August 27; September 10 review overdue | Complete facilitator/deployment map, pinned gross borrower collateral/debt and every PSM, including USDT0, must reconcile the book. Repair pool-cash-versus-gross and omitted-facilitator regressions before removing suspension. |
| Nest inALPHA | Suspended September 9; review March 9, 2027 or actual publisher repair | October 7 positions $0.410183 versus NAV $1.8890182896 and accountant clock 1771867979 remain incompatible. Current accountant prices and complete positions must reconcile under both clock/coverage gates in `nest-vault-positions`; dust/empty positions are not 100% cash. |
| tGBP | Suspended September 11 after Worker 403; review October 11 | Issuer-approved deployed Worker access, real schema-valid permitted 200 and persisted success. Local 200 is insufficient and has no accounting timestamp; retain weak-probe/unknown freshness absent separately reviewed dated evidence. |
| USDY | Suspended September 9; review October 9 | Official machine-readable newest daily Ankura report index/direct publication with tested balance date. Implement exact reviewed discovery in `usdy-holdings-report`, retain five-day cap and reject missing-date/unreviewed reports. No protobuf guess, ZIP workaround or pinned-PDF restamping. |
| ZARSC | August 31 balances; September 16 issue and October 5 webpage publication do not refresh them | New exact balance report within 33 days, reviewed facts/artifact and `reviewedReport` update. ISRS 4400 AUP restores static validation only, not independent assurance. |
| USDU | August 24/31 examination balances exceed 33 days | Fresh successor with reviewed engagement, scope, reconciled facts and artifact. Independent-manifest/cadence promotion is separate; no 70-day rescue budget. |
| wCOP/wARS/wBRL/wMXN | June 30 certifications; August URL folder is hosting date | Fresh currency-specific certification within 33 days, preserving `linkMatch` identity guards, restores static validation only. Current reports exclude audit/review opinions; independent-grade requires qualifying current assurance or independent whole-book measurement. |

## Expected publication windows

Escalate a missing report at the end of its window. A discovered newer independent-assurance report is never accepted provisionally: verify and update its exact artifact identity before publication resumes. Where a product is bound to a live adapter, its window tracks that adapter's declared source-age tier (`LAGGED_MONTHLY_EXAMINATION_SOURCE_MAX_AGE_SEC` for GUSD, `NEXT_MONTH_DISCLOSURE_SOURCE_MAX_AGE_SEC` for the month-end publishers whose successor lands weeks into the following month, the shared late-monthly tier otherwise), so the escalation deadline and the runtime admission ceiling stay one authority; products without a runtime binding keep their reviewed-manifest publication window.

| Product | Expected publication window | Owner |
| --- | --- | --- |
| AUDD | Monthly; by 4,000,000 seconds (46 days 07:06:40) after period end, the exact shared late-monthly runtime ceiling | Reserve evidence maintainer |
| AUDM | Monthly; by 47 days after period end | Reserve evidence maintainer |
| AUDX | Monthly; by 70 days after period end | Reserve evidence maintainer |
| AUSD | Monthly; by 70 days after period end | Reserve evidence maintainer |
| BRLA | Monthly; by 47 days after period end | Reserve evidence maintainer |
| BRLV | Monthly; by 47 days after period end | Reserve evidence maintainer |
| CADD | Monthly; by 47 days after period end | Reserve evidence maintainer |
| EUROP | Quarterly; by 100 days after period end | Reserve evidence maintainer |
| FDUSD | Monthly; by 4,000,000 seconds (46 days 07:06:40) after period end, the exact shared late-monthly runtime ceiling | Reserve evidence maintainer |
| FIDD | Monthly; by 70 days after period end | Reserve evidence maintainer |
| GUSD | Monthly; by 75 days after period end | Reserve evidence maintainer |
| PAXG | Monthly; by 70 days after period end | Reserve evidence maintainer |
| PGOLD | Monthly; by 47 days after period end | Reserve evidence maintainer |
| PYUSD | Monthly; by 70 days after period end | Reserve evidence maintainer |
| RLUSD | Monthly; by 70 days after period end | Reserve evidence maintainer |
| SBC | Monthly; by 47 days after period end | Reserve evidence maintainer |
| TGBP | Monthly; by 47 days after period end | Reserve evidence maintainer |
| TRYB | Monthly; by 47 days after period end | Reserve evidence maintainer |
| USAT | Monthly; by 70 days after period end | Reserve evidence maintainer |
| USDG | Monthly; by 70 days after period end | Reserve evidence maintainer |
| USDGO | Monthly; by 70 days after period end | Reserve evidence maintainer |
| USDP | Monthly; by 70 days after period end | Reserve evidence maintainer |
| USDPT | Monthly; by 70 days after period end | Reserve evidence maintainer |
| USX | Monthly; by 47 days after period end | Reserve evidence maintainer |
| XSGD | Monthly; by 70 days after period end | Reserve evidence maintainer |
| XUSD | Monthly; by 70 days after period end | Reserve evidence maintainer |

## Refresh checklist

1. Use the official report index and select the newest dated candidate.
2. Verify exact URL, content SHA-256, byte length, engagement type, tested balance date, publication date, complete reconciled assets/liabilities and slice scope. Fetch, folder, signature and upload dates do not renew historical balances.
3. Preserve fail-closed behavior: do not widen a URL pattern, reuse an old hash, or accept an unreviewed newer report.
4. Human-review the manifest or `params.reviewedReport` and curated reserve review together, preserving currency-specific `linkMatch`; run targeted adapter checks and deploy through normal sync/recovery.
5. Observe an actual attempt and API readback, distinguishing static restoration from independent scoring eligibility. Retain the 2,851,200-second (33-day) ceiling for these monthly static sources; do not excuse `stale-redemption-source-timestamp`, manufacture cash weights or treat reports as executable redemption capacity.
