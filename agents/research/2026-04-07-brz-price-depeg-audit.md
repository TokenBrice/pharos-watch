# BRZ Price + Depeg Audit

Date: 2026-04-07

## Scope

Validate whether Pharos BRZ pricing and depeg history align with external market sources.

## Internal observations

- Public stablecoin payload is current:
  - `BRZ.price = 0.193421`
  - `BRZ.priceSource = "coingecko+defillama-list"`
  - `BRZ.priceConfidence = "single-source"`
  - `fxFallbackRates.peggedREAL = 0.192983`
- That implies current BRZ ~= `1.00227 BRL` against the live internal BRL/USD fallback, or about `+23 bps`, which is inside the non-USD depeg threshold (`150 bps`).
- Public depeg history still shows an active BRZ event:
  - event `88066`
  - started `2026-03-23T19:34:00Z`
  - `startPrice = 0.190587`
  - `pegReference = 0.18765951`
  - implied BRZ ~= `1.0156 BRL`
  - recorded as `+156 bps`
- In the last 90 days, Pharos reports `66` BRZ depeg events, with `64` of them in March 2026.

## External checks

### Current spot

- CoinGecko current spot:
  - `BRZ = 0.193382 USD`
  - `BRZ = 0.993927 BRL`
- Open Exchange Rates sample:
  - `1 BRL = 0.194187 USD` at `2026-04-07T00:02:31Z`
- Frankfurter latest business-day FX:
  - `1 BRL = 0.19298 USD` on `2026-04-02`

Interpretation:

- External spot puts BRZ near peg right now:
  - vs CoinGecko BRL direct quote: about `-61 bps`
  - vs open.er-api BRL/USD + CoinGecko USD: about `-41 bps`
  - vs Pharos `fxFallbackRates.peggedREAL`: about `+23 bps`
- All of those are well inside the `150 bps` non-USD threshold.

### March 23, 2026 active event open

- CoinGecko hourly BRL chart for `2026-03-23` stayed between:
  - min `0.995018 BRL` (`-50 bps`)
  - max `1.006118 BRL` (`+61 bps`)
- CoinGecko hourly USD chart near the event open was about `0.1902 USD`.
- Frankfurter FX for `2026-03-23` was `1 BRL = 0.19013 USD`.

Interpretation:

- The March 23 active event is not corroborated externally.
- BRZ did not cross `150 bps` from peg that day on CoinGecko’s BRL chart.
- The suspicious field is the stored `pegReference = 0.18765951`, which is about `1.30%` below Frankfurter’s `0.19013`.

### March 16, 2026 cluster

- Pharos reports many short BRZ live events on `2026-03-15` to `2026-03-16`, mostly around `-152` to `-214 bps`.
- CoinGecko BRL chart for `2026-03-16` stayed between:
  - min `0.989596 BRL` (`-104 bps`)
  - max `1.012188 BRL` (`+122 bps`)
- Frankfurter FX for `2026-03-16` was `1 BRL = 0.18974 USD`.

Interpretation:

- Those March 16 micro-events are not corroborated by CoinGecko’s BRL quote.
- They are likely false positives or over-fragmented detections.

### Last 90 days

- CoinGecko hourly BRL data over the last 90 days shows only `8` threshold-breach segments, all concentrated around `2026-03-07` to `2026-03-11`.
- The largest external move is real:
  - `2026-03-07T07:04:32Z`
  - `0.019949 BRL`
  - about `-9801 bps`

Interpretation:

- Some BRZ depegs are real, especially the March 7 crash/outlier window.
- But the current active event and many later March rows appear overstated or false when checked against external BRL pricing.

## Likely internal failure modes

### 1. Thin-group peg-reference fallback is fragile

Relevant code:

- `shared/lib/peg-rates.ts:81`

Observation:

- Thin fiat peg groups are intended to use fallback FX rates, but if the fallback is absent, the function still falls through to a peer-price median.
- For BRL-pegged assets, that can manufacture a bad peg reference exactly when the external FX lane is unavailable.

### 2. False open events can stick when recovery is only `confirm_required`

Relevant code:

- `worker/src/lib/depeg-helpers.ts:208`
- `worker/src/cron/detect-depegs.ts:268`

Observation:

- Recovery closes immediately only when the current primary price is `authoritative`, or when trusted DEX recovery corroborates it.
- BRZ currently carries `priceConfidence = "single-source"` with `priceObservedAtMode = "unknown"`, so the recovery path can leave a stale false positive open if DEX recovery is unavailable.

### 3. `/api/depeg-events` freshness can look newer than the underlying event timestamp

Relevant code:

- `worker/src/api/depeg-events.ts:56`

Observation:

- The endpoint freshness header follows the latest successful `sync-stablecoins` run, while the response `methodology.asOf` follows the latest returned event timestamp.
- That is correct technically, but it makes a stuck old live event easy to miss during manual checks.

## Conclusion

- BRZ is not materially depegged right now.
- The currently displayed active BRZ event is not accurate.
- The March 23 open event is externally contradicted and should be treated as a false positive.
- The March 15-16 burst is also not corroborated by CoinGecko BRL pricing.
- The March 7 to March 11 crash window does look real.

## Follow-up

- Patch the thin-fiat peg-reference logic so depeg detection does not fall back to peer medians when external FX is missing.
- Add a stale-live-event retirement path for near-peg `confirm_required` recoveries, or an explicit repair/admin cleanup flow for affected rows.
- Run the BRZ history through the existing admin audit/remediation path after the code fix lands.
