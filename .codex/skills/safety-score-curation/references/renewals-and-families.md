# Renewals And Curated Families

`shared/data/safety-score-v9/AGENTS.md` owns the invariants; the sweep doc owns the procedure. This file only routes.

## Renewal Clock

Run against the same replay as the sweep ([renew before the boundary](../../../../docs/process/safety-score-curation-expiry-sweep.md#4b-renew-before-the-boundary-then-check-and-book-the-ledger-sentinels) owns flags, lead times and the SLA):

```bash
npm run safety-score-v9:expiry-queue -- --replay <replay> --days 14 --by-week
npm run safety-score-v9:expiry-queue -- --replay <replay> --horizon <YYYY-MM-DD> --by-week --output <path>
```

- `--horizon` and `--days` conflict. Curated reserve compositions are not week-bucketed; they stay in the reserve queue.
- Renew from current primary sources, or list an issuer wait with a date or event trigger. Never date-bump, never shorten a review window to exclude a known event, and renew an incident review only from a fresh primary search of the same surfaces.
- Incident reviews renew by stable authored identity, never by a legacy control digest; a `retired` row renews nothing.

## Ledger Sentinels

- Append decisions only through `scripts/maintenance/ledger-append.ts` (append-only history; the churn park rule lives in [the typed registry step](../../../../docs/process/safety-score-curation-expiry-sweep.md#4a-generate-and-drain-the-typed-missing-data-registry)).
- Check the reviewed ledger against the regenerated registry from the same capture with `worker/scripts/check-safety-score-v9-ledger-sentinels.ts`. It is report-only and needs the enlarged Node heap shown in the sweep doc.
- Booking a closure is an operator PR made with `scripts/maintenance/apply-sentinel-closures.ts`; never hand-edit `.github/artifacts/safety-score-missing-data-reviewed-ledger.json`.

## Curated Families

Files under `shared/data/safety-score-v9/`; the directory listing wins over this table.

| File | Before editing |
| --- | --- |
| `mechanism-review-overlays-v1.json` | `docs/process/mechanism-overlay-evidence-standard.md` |
| `reserve-bound-facts-v1.json` | [Bounded reserve facts](../../../../docs/process/mechanism-overlay-evidence-standard.md#bounded-reserve-maturity-and-liquidity-facts); renew with the reserve composition it bounds |
| `incident-reviews-v1.json`, `lane-screening-emitter-inventory-v1.json` | [Incident reviews and lane closure](../../../../docs/process/mechanism-overlay-evidence-standard.md#incident-reviews-and-lane-closure-v1038); regenerate the incident runtime, then `npm run check:incident-review-keys` |
| `evidence-gap-classifications-v1.json` | One active row per scope key: replace a same-scope review, never append a second |
| `exit-execution-model-reviews-v1.json` | `docs/redemption-backstops.md` |
| `supply-attribution-reviews-v1.json`, `wrapper-allocation-reviews-v1.json`, `lender-collateral-classes-v1.json` | `docs/process/report-cards-appendix.md` |
| `chain-maturity-reviews-v1.ts` | `docs/process/report-cards-appendix.md`; imported by `shared/lib/safety-score-v9/policy.ts`, so a renewal is score-affecting and needs the replay gates |
| `access-lookthrough-reviews-v1.json` | `docs/access-lookthrough.md` |
| `transfer-review-overlays-v1.json` | `docs/runbooks/blacklist-sync.md` |
| Shock coverage files, `mechanism-measurements/` | The shock and protocol producer branches in [SKILL.md](../SKILL.md) |

## Admission Tools

- New-asset admission receipt: `npm run safety-score-v9:admit-receipt`, under [Safety Score admission receipt](../../../../docs/process/adding-a-stablecoin.md#5j-safety-score-admission-receipt-new-asset-evidence-packet).
- `npm run safety-score-v9:anchor-gate -- --replay <path>` is a calibration sniff check, not a production-acceptance gate.
