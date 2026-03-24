# Admin status stale investigation

Date: 2026-03-23

## Symptom

- `/admin` reported `overallStatus=stale`
- Most cron lanes were healthy
- The visible stale driver was `staleOnchainSupply = 115 / 117`

## Production evidence

- `onchain_supply` currently holds 117 distinct `stablecoin_id` values
- Only 2 coins have updates inside the active 3-day monitoring window:
  - `kau-kinesis`
  - `kag-kinesis`
- The other 115 latest rows were historical, clustered around `2026-02-21T23:30:28Z`

## Root cause

`worker/src/lib/status/data-quality.ts` treated the full lifetime `onchain_supply` table as the active monitor population:

- `onchainSupplyTrackedCoins = COUNT(DISTINCT stablecoin_id)` across the whole table
- `staleOnchainSupply` grouped across the whole table too

That made historical rows look like live stale feeds, so data quality flipped to `stale` even though the current cron lanes were mostly healthy.

## Fix

- Count `onchainSupplyTrackedCoins` only for coins with at least one row inside the active 3-day monitoring window
- Count `staleOnchainSupply` only inside that same active window
- Preserve historical `onchain_supply` rows for audit/debug use without letting them affect live admin health
- Gate ratio-based on-chain stale/degraded escalation until the active monitor has at least 10 tracked coins

## Remaining live signal

Even with the historical-row bug removed, current production still has one genuine active divergence:

- `kau-kinesis`
  - on-chain supply: `2,586,388.6348`
  - implied supply from cached USD circulation / price: `2,380,776.7315`
  - divergence: `8.64%`

With the active-window fix plus the low-sample ratio gate, the admin status becomes more accurate (`staleOnchainSupply` should collapse from `115/117` to `0/2`) and a `1/2` divergence sample no longer escalates global status by ratio alone. The live KAU divergence still remains visible as an informational signal until the active monitor population grows to at least 10 coins or an absolute on-chain threshold is crossed.
