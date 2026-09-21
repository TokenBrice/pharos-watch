# Dated source age caps

This runbook covers reserve sources whose scoring or publication eligibility changes at a known age boundary. The reserve evidence maintainer owns every entry below. Treat each time as a UTC operational deadline, not as an estimate of when an issuer will publish.

## Scheduled boundaries

| Boundary instant | Coin | Constant | Symptom | Refresh procedure | Owner |
| --- | --- | --- | --- | --- | --- |
| 2026-10-02T00:00:00Z | EURQ (`eurq-quantoz`) | 33-day live-reserve source-age cap | The Quantoz snapshot becomes stale; confirm `freshnessMode` and scoring eligibility within 24 hours. | Re-read the official transparency table, verify its `UPDATED` timestamp and every EURQ reserve row, update the reviewed source only when the table has advanced, then confirm the published snapshot's freshness verdict. | Reserve evidence maintainer |
| 2026-10-08T08:00:00Z | EUROP (`europ-schuman`) | 100-day assurance-report age cap | The Q2 SALVUS report becomes stale for Safety Score V9. A newer discovered report causes a fail-closed throw; the fetched snapshot also expires after its two-day grace. | Check the official report index for the expected Q3 SALVUS report. Verify the exact report URL, SHA-256, byte length, report date, report-as-of instant, and complete asset and liability rows; update the reviewed manifest and deploy before the prior snapshot's grace expires. | Reserve evidence maintainer |

## Expected publication windows

Escalate a missing report at the end of its window. A discovered newer independent-assurance report is never accepted provisionally: verify and update its exact artifact identity before publication resumes.

| Product | Expected publication window | Owner |
| --- | --- | --- |
| AUDD | Monthly; by 47 days after period end | Reserve evidence maintainer |
| AUDM | Monthly; by 47 days after period end | Reserve evidence maintainer |
| AUDX | Monthly; by 47 days after period end | Reserve evidence maintainer |
| AUSD | Monthly; by 47 days after period end | Reserve evidence maintainer |
| BRLA | Monthly; by 47 days after period end | Reserve evidence maintainer |
| BRLV | Monthly; by 47 days after period end | Reserve evidence maintainer |
| CADD | Monthly; by 47 days after period end | Reserve evidence maintainer |
| EUROP | Quarterly; by 100 days after period end | Reserve evidence maintainer |
| FDUSD | Monthly; by 47 days after period end | Reserve evidence maintainer |
| FIDD | Monthly; by 47 days after period end | Reserve evidence maintainer |
| GUSD | Monthly; by 75 days after period end | Reserve evidence maintainer |
| PAXG | Monthly; by 47 days after period end | Reserve evidence maintainer |
| PGOLD | Monthly; by 47 days after period end | Reserve evidence maintainer |
| PYUSD | Monthly; by 47 days after period end | Reserve evidence maintainer |
| RLUSD | Monthly; by 47 days after period end | Reserve evidence maintainer |
| SBC | Monthly; by 47 days after period end | Reserve evidence maintainer |
| TGBP | Monthly; by 47 days after period end | Reserve evidence maintainer |
| TRYB | Monthly; by 47 days after period end | Reserve evidence maintainer |
| USAT | Monthly; by 47 days after period end | Reserve evidence maintainer |
| USDG | Monthly; by 47 days after period end | Reserve evidence maintainer |
| USDGO | Monthly; by 47 days after period end | Reserve evidence maintainer |
| USDP | Monthly; by 47 days after period end | Reserve evidence maintainer |
| USDPT | Monthly; by 47 days after period end | Reserve evidence maintainer |
| USX | Monthly; by 47 days after period end | Reserve evidence maintainer |
| XSGD | Monthly; by 47 days after period end | Reserve evidence maintainer |
| XUSD | Monthly; by 47 days after period end | Reserve evidence maintainer |

## Refresh checklist

1. Use the official report index and select the newest dated candidate.
2. Verify the exact URL, SHA-256, byte length, reporting period, publication date, and all reconciled asset and liability rows.
3. Preserve fail-closed behavior: do not widen a URL pattern, reuse an old hash, or accept an unreviewed newer report.
4. Update the reviewed manifest, run the adapter's targeted verification, and deploy before the previous fetched snapshot's grace expires.
