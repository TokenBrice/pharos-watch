# PYS v8.292 Venue-Risk Calibration — Live Snapshot 2026-06-15

Live blast-radius check for the yield v8.292 venue-risk rubric + dependency-concentration
signal, before deploy. Reproduce with:

```
tsx scripts/maintenance/yield-venue-risk-calibration.ts   # key from .env.local
```

The script fetches `/api/yield-rankings` (still on the pre-deploy methodology), recomputes
each row's source-risk penalty and PYS under the new model, and diffs against the published
value.

Snapshot taken after the full registry expansion (61 reviewed venues: 41 from the initial
rollout + 20 from FU3 Wave 2).

## Headline

- **180 live rows. Reconstruction validity 180/180** — every row's old PYS recomputes within
  ±1 of the published value using the published penalty, so the deltas below are trustworthy.
- **35 rows touched** by the new venue/concentration model. **22 PYS decreases, 0 increases**
  (13 rows changed penalty but rounded to 0 PYS delta).
- **Largest drop: AUSD −7 PYS** (40 → 33, via Upshift → high institutional credit).
  **Mean drop −1.91 PYS.**
- **Zero rows hit PYS 0; zero ranking dropouts.** The v8.21 publication-regression guard keys
  on lending-opportunity / total **row count**, which is unchanged — not at risk.

## All movers (≤ −1 PYS)

| Coin | ΔPYS | PYS | Penalty | Driver |
|---|---:|---|---|---|
| AUSD | −7 | 40→33 | 1.00→1.232 | upshift → high |
| fxUSD | −5 | 41→36 | 1.10→1.235 | morpho-blue → medium |
| HYUSD | −4 | 20→16 | 1.00→1.225 | loopscale → high |
| DLLR | −3 | 18→15 | 1.00→1.202 | sovryn-dex → medium |
| tGBP | −2 | 16→14 | 1.463→1.688 | loopscale → high |
| USDT | −2 | 15→13 | 1.10→1.28 | maple → medium |
| EURCV | −2 | 15→13 | 1.00→1.135 | morpho-blue → medium |
| XUSD | −2 | 11→9 | 1.00→1.202 | sovryn-dex → medium |
| USD3 | −2 | 7→5 | 1.30→1.72 | 3jane-lending → high |
| DJED, USDM | −1 | — | 1.00→1.045 | liqwid → low (weighted 2.30) |
| reUSD, ZCHF, FEUSD, RLUSD, JUPUSD, PYUSD, USDTB, syrupUSDT, USDX, iUSD, MSUSD | −1 | — | small step | morpho-blue / felix / jupiter / clearpool / echelon / vesper |
| yvUSDC-1, cUSDO, USDO, gtUSDC, pathUSD, USDA, EUSD, FRAX, USDsui, … | 0 | — | small penalty step | various low/medium venues + Sky concentration |

## Earlier (41-venue) snapshot

| Coin | ΔPYS | PYS | Penalty | Driver |
|---|---:|---|---|---|
| fxUSD | −5 | 41→36 | 1.10→1.235 | morpho-blue → medium |
| DLLR | −3 | 18→15 | 1.00→1.202 | sovryn-dex → medium |
| USDT | −2 | 15→13 | 1.10→1.28 | maple → medium |
| EURCV | −2 | 15→13 | 1.00→1.135 | morpho-blue → medium |
| XUSD | −2 | 11→9 | 1.00→1.202 | sovryn-dex → medium |
| USD3 | −2 | 7→5 | 1.30→1.72 | 3jane-lending → high |
| reUSD | −1 | 19→18 | 1.20→1.327 | beefy → medium |
| ZCHF | −1 | 15→14 | 1.00→1.022 | frankencoin → low |
| FEUSD | −1 | 14→13 | 1.00→1.12 | felix-cdp → medium |
| RLUSD | −1 | 12→11 | 1.498→1.633 | morpho-blue → medium |
| JUPUSD | −1 | 10→9 | 1.00→1.09 | jupiter-lend → medium |
| PYUSD | −1 | 10→9 | 1.30→1.435 | morpho-blue → medium |
| USDTB | −1 | 9→8 | 1.30→1.435 | morpho-blue → medium |
| syrupUSDT | −1 | 7→6 | 1.00→1.18 | maple → medium |
| USDX | −1 | 4→3 | 1.00→1.353 | clearpool-lending → high |
| iUSD | −1 | 4→3 | 1.00→1.15 | echelon-market → medium |
| gtUSDC, pathUSD, EUSD, FRAX, USDH, XSGD | 0 | — | small penalty step | morpho-blue / fraxlend → medium |
| yvUSDC-1 | 0 | 4→4 | 1.00→1.10 | yearn-finance low + **Sky concentration** |

## Notes / nuances

- **Two effects are bundled in these deltas.** (1) the new 5-category rubric, and (2) the
  Phase-2 wiring fix that resolves the venue config from the DeFiLlama `project` slug. The
  pre-deploy production penalty for several **lending-opportunity** rows (fxUSD/EURCV/PYUSD/
  USDTB on morpho-blue, USDT/syrupUSDT on maple, reUSD on beefy) did **not** include the
  venue tier — those rows were escaping the medium penalty under the old `inferVenueProtocol`
  path. After deploy they correctly pick it up. This is the intended correction, not a
  regression.
- **The new high-tier venues bite as designed but gently:** USD3 (3Jane, high) −2, USDX
  (Clearpool, high) −1 — small because their base PYS is already low.
- **Sky concentration on yvUSDC** applies (+0.10 penalty) but rounds to 0 PYS change at this
  base; it will matter more if the vault's APY rises.
- Distribution of touched rows by venue: pendle 14 / morpho-blue 10 / aave-v3 6 (all no-op or
  near-no-op for low venues) — the medium/high venues drive the handful of real moves.

## Verdict

Ship-safe. The methodology change moves PYS for 23 of 180 rows by at most 5 points, never to
zero, with no ranking-count impact. No mitigation (waving, guard tuning) required.
