# DEWS Telegram Alerts — Design

**Date:** 2026-03-02
**Status:** Approved

## Overview

Post a Telegram alert to the existing Pharos channel whenever DEWS detects a coin entering the WARNING (56-75) or DANGER (76-100) band. The message includes coin context (name, backing, governance, market cap, price) and the top elevated stress signals.

---

## Trigger Logic

An alert fires when a coin's band transitions **upward** into WARNING or DANGER:

| Transition | Alert |
|---|---|
| CALM / WATCH / ALERT → WARNING | ⚠️ WARNING alert |
| CALM / WATCH / ALERT / WARNING → DANGER | 🚨 DANGER alert |
| No band change | nothing |
| Downward movement | nothing |

The previous band is read from the existing `stress_signals` table (`band` column). The cron already queries this table for signal smoothing — we extend that query to also fetch `band`. No migration needed.

---

## Message Format

HTML parse mode (same as the daily digest). Example for a WARNING entry:

```
⚠️ <b>WARNING: USDC</b>

<b>USD Coin</b> (RWA-backed, centralized) has entered the DEWS WARNING band.
Score: <b>62</b>/100 — up from ALERT
Market cap: $43.2B | Price: $0.9987

<b>Top stress signals:</b>
• Pool Balance Drift: 68
• Liquidity Erosion: 54
• Supply Velocity: 42

<a href="https://pharos.watch/stablecoin/5">View full analysis →</a>
```

For DANGER, the emoji changes to 🚨 and the band label to DANGER.

### Context fields

| Field | Source |
|---|---|
| Coin name | `PSI_ELIGIBLE_META_BY_ID[id].name` |
| Backing + governance | `meta.flags.backing`, `meta.flags.governance` |
| Market cap | `current` (already computed per coin in the cron) |
| Price | `asset.price` (already in scope per coin) |
| Previous band | extended prev-signals query |
| Top signals | `result.signals` — available signals with `value >= 30`, sorted descending, top 3 |

Signal keys are mapped to human-readable labels:

| Key | Label |
|---|---|
| `supply` | Supply Velocity |
| `pool` | Pool Balance Drift |
| `liq` | Liquidity Erosion |
| `price` | Price Confidence |
| `diverg` | Cross-source Divergence |
| `black` | Blacklist Activity |
| `flow` | Mint/Burn Flow |
| `yield` | Yield Anomaly |

---

## Cadence

Alerts are checked every 15 minutes (DEWS cron frequency). Since DEWS signals are smoothed, transitions typically build over multiple cycles rather than jumping immediately. Worst-case lag from real-world event to alert: ~15 min + `syncStablecoins` runtime.

No cooldown table. A coin that oscillates at a band boundary (drops to ALERT then re-enters WARNING) will re-alert on each upward crossing — this is considered acceptable and informative.

---

## Delivery Channel

Same Telegram channel as the daily digest (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`). Alerts are non-fatal: a delivery failure logs a warning but never blocks the DEWS cron.

---

## Implementation Plan

### Files changed

| File | Change |
|---|---|
| `worker/src/lib/telegram.ts` | Add `postDewsAlert(params, creds)` function |
| `worker/src/cron/compute-dews.ts` | Accept `telegramCreds`, extend prev-band query, fire alerts post-INSERT |
| `worker/src/index.ts` | Pass `telegramCreds` to `computeAndStoreDEWS` in `*/15` cron handler |
| `docs/dews.md` | Add Alerts section |
| `docs/digest-pipeline.md` | Update Telegram subsection to mention DEWS alerts |

### No migration required

`stress_signals` already has the `band` column. The existing prev-signals query just needs `band` added to the `SELECT`.
