# Global Safety Alert Tier: First-Step Scope

Date: 2026-04-22

## Goal

Ship the smallest useful reduction in safety-alert noise for users who follow **all** stablecoins, without changing the core Safety Score methodology or adding new subscription schema.

## In Scope

- Reinterpret global `safety all` follows as a narrower product tier:
  - downgrade-only
  - material-only when scores are present (`oldScore - newScore >= 3`)
- Keep explicit per-coin safety follows unchanged.
- Keep the existing command surface unchanged.
- Update bot copy, landing-page copy, and Telegram docs to match the new behavior.
- Add tests proving:
  - global material downgrades notify
  - minor global downgrades do not
  - explicit per-coin follows still override the global tier

## Out Of Scope

- New DB columns or migration work
- New user-configurable global safety modes
- New batching cadence for safety alerts
- Core score/grade hysteresis or smoothing
- Alert-body dimension-delta explanations

## Implementation Shape

- Use the existing `telegram_subscribers.global_alert_safety` flag.
- Apply the narrower policy only on global safety fan-out rows inside `dispatch-telegram-alerts`.
- Leave `telegram_subscriptions.safety_mode` semantics untouched.
- Preserve current precedence: explicit per-coin rows still win over the global all-stablecoin tier for the same chat and coin.

## Success Criteria

- `/subscribe safety all` and `/set all safety on` now mean "material safety downgrades across all tracked stablecoins".
- A `B- -> C+` transition with `65 -> 64` no longer pages global safety followers.
- A larger downgrade such as `B -> C+` with `70 -> 66` still pages global safety followers.
- The same minor downgrade still reaches a user who explicitly follows that coin for safety alerts.
