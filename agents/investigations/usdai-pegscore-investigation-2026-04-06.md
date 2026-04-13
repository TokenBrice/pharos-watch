# USDAI PegScore Investigation

Date: 2026-04-06

## Question

Why does `usdai-usd-ai` carry a suspiciously weak PegScore even though base USDAI behaves like a PYUSD wrapper?

## Findings

- Production `peg-summary` showed USDAI at `pegScore: 82` with `eventCount: 218` and `worstDeviationBps: 1484`.
- D1 `depeg_events` showed almost all USDAI rows were `source='backfill'`, with three newer `source='live'` downside events around `0.979`.
- The recent live downside prints were not corroborated by CoinGecko, DefiLlama, or Pyth around the same timestamps. Those sources stayed near par, so the recent live USDAI events look like false positives.
- Historical USDAI daily prices stored in `supply_history` and served by CoinGecko/DefiLlama really did sit around `1.03` to `1.06` for stretches in late Sep / Oct 2025, so the long USDAI event history was internally consistent with raw market feeds.
- USD.AI docs describe base USDAI as fully backed and instantly redeemable, which makes those thin-market wrapper prints a poor source of truth for peg stability.

## Conclusion

This was a modeling problem, not random DB corruption:

- raw USDAI market feeds were allowed to define PegScore even though base USDAI should shadow PYUSD redemption semantics
- the recent live USDAI downside events were almost certainly false positives

## Fix Implemented

- Added USDAI to `worker/src/lib/authoritative-price-sources.ts`
- Live USDAI now inherits tracked `pyusd-paypal` pricing through the `protocol-redeem` override lane
- Historical USDAI backfill now replays the tracked PYUSD market series instead of trusting USDAI's own thin secondary-market history
- Updated pricing methodology docs and bumped the pricing methodology version to `v3.95`

## Verification

- `npx vitest run worker/src/lib/__tests__/authoritative-price-sources.test.ts`
- `npm run lint`
- `cd worker && npx tsc --noEmit`
- `npm run build`
