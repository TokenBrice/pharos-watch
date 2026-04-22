# Hotspot Retirement Tracker - 2026-04-22

Owner: Codex
Source plan: `agents/plans/2026-04-22-full-audit-remediation-implementation-plan.md`

## Scope

This tracker records the explicit retirement path for the `S-01` hotspot set so waiver/baseline carry-forward is never implicit.

## Active entries

| File | Current state | Owner | Next checkpoint | Exit condition |
| --- | --- | --- | --- | --- |
| `worker/src/cron/dispatch-telegram-alerts.ts` | baseline regression cleared in Gate 0; still a tracked hotspot | Codex | WS-6 / PR-07 | orchestration shell split lands and ratchet passes without a special growth allowance |
| `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts` | waiver-backed hotspot | Codex | WS-6 / PR-08 | provider/consensus/hardening phases are separated and hotspot metadata is reduced or removed |
| `worker/src/lib/mint-burn-contracts.ts` | waiver-backed hotspot | Codex | WS-6 / PR-09 | config registry is split from schema/validator logic and hotspot metadata is reduced or removed |
| `scripts/lib/hotspot-ratchet-baseline.json` | active baseline authority | Codex | after each hotspot PR | update only when code movement materially changes the hotspot shape |
| `scripts/lib/hotspot-ratchet-waivers.json` | active waiver authority | Codex | after each hotspot PR | remove or narrow affected waiver entries as soon as the underlying hotspot shrinks enough |

## Notes

- Gate 0 restored `npm run check:hotspot-ratchet` to green before broader deploy-impacting changes.
- Any PR touching hotspot metadata must land serially with other hotspot-metadata PRs from the plan.
