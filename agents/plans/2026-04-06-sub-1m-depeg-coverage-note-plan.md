# Sub-$1M Depeg Coverage Note Plan

## Goal

Implement the smallest safe fix for low-cap tracked coins that show a large live price deviation but no depeg event history.

## Scope

- Keep the live depeg-event floor at `$1M` circulating supply.
- Do not broaden depeg recording, alerts, PSI inputs, or aggregate depeg tables.
- Expose an explicit per-coin coverage flag through `peg-summary`.
- Replace misleading detail-page copy that currently implies "maintained peg" when the coin is simply below the live-event floor.

## Planned Changes

1. Add a shared `DEPEG_EVENT_MIN_SUPPLY_USD` constant and reuse it in live depeg detection / peg-summary coverage logic.
2. Thread a `depegEventCoverageLimited` flag through `PegSummaryCoin` and the `peg-summary` API response.
3. Surface the flag on the stablecoin detail page:
   - show a small warning near the live price when the coin is off peg but below the event floor
   - replace the depeg-history empty-state "maintained peg" claim with coverage-limited copy
4. Update the matching depeg methodology/docs and API reference text.
5. Run targeted tests for peg analytics, peg-summary, and the detail hero card.
