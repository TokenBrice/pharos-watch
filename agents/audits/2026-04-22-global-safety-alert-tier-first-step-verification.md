# Global Safety Alert Tier First-Step Verification

Date: 2026-04-22

## Scope

Verify the implementation of `agents/plans/2026-04-22-global-safety-alert-tier-first-step.md` before commit/push.

Files reviewed:

- `worker/src/cron/dispatch-telegram-alerts.ts`
- `worker/src/cron/dispatch-telegram-routing.ts`
- `worker/src/api/telegram-webhook-messages.ts`
- `worker/src/api/telegram-webhook-shared.ts`
- `worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts`
- `worker/src/api/__tests__/telegram-webhook.test.ts`
- `worker/src/api/__tests__/telegram-webhook-messages.test.ts`
- `src/app/telegram/page.tsx`
- `docs/telegram-alerts.md`

## Independent Review Outcome

Three `gpt-5.4` `xhigh` reviewer subagents were spawned.

- Worker semantics review: no logic findings. Residual risk noted around the scoreless-downgrade edge and the explicit-per-coin override rule.
- Test/edge-case review: no logic findings. Highest-value gap was missing coverage for restrictive per-coin precedence over the global tier.
- Copy/docs review: found two wording issues:
  - Global safety copy overclaimed “material-only” even though scoreless downgrades intentionally still pass through.
  - `docs/telegram-alerts.md` mixed the old daily safety snapshot producer with the current live `publish-report-card-cache` source.

## Follow-up Changes Made During Verification

- Added a test proving an explicit per-coin `upgrade-only` safety mode suppresses a material downgrade even when the same chat also has global `safety all`.
- Added a test proving scoreless downgrades still notify global `safety all` followers.
- Tightened bot/UI/docs copy to the precise rule:
  - downgrade-only
  - 3-point score-drop filter only when scores are present
- Corrected Telegram doc wording to describe the live `publish-report-card-cache` source/cadence consistently.

## Validation

Completed successfully on the final worktree before commit:

- `npx vitest run worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts worker/src/api/__tests__/telegram-webhook.test.ts worker/src/api/__tests__/telegram-webhook-messages.test.ts`
- `npm run lint`
- `npm run test:merge-gate` on the branch worktree before the final copy/test follow-up

Final pre-push plan after this audit note:

1. Commit the Telegram change set.
2. Re-run `npm run test:merge-gate` against the new commit.
3. Push the branch.
