# Telegram Alert Bot — Execution Handover

## What this does

Adds a Telegram bot that lets users subscribe to per-coin alerts for DEWS state changes, depeg events, and safety score changes. Integrated into the existing Cloudflare Worker — D1 for subscriber storage, cron dispatch piggybacking on existing triggers, webhook endpoint for command handling.

## File inventory

```
agents/plans/2026-03-08-telegram-alert-bot-design.md   # Design document (approved)
agents/plans/telegram-alert-bot/
  implementation-plan.md                                 # Phase breakdown + ticket tables
  execution-handover.md                                  # This file
  PROGRESS.md                                            # Progress tracker
  tickets/
    phase1-foundation/
      TICKET-001.md    # D1 migration
      TICKET-002.md    # Env + telegram lib
      TICKET-003.md    # Endpoint + route + rate limiter
    phase2-shared-logic/
      TICKET-001.md    # Ticker resolution + parsing
      TICKET-002.md    # Message templates + queries
    phase3-webhook/
      TICKET-001.md    # Webhook handler
      TICKET-002.md    # Router wiring
      TICKET-003.md    # Webhook tests
    phase3-dispatch/
      TICKET-001.md    # Dispatch cron job
      TICKET-002.md    # Scheduled handler wiring
      TICKET-003.md    # Dispatch tests
    phase4-docs/
      TICKET-001.md    # Docs + webhook script
```

## Execution commands per phase

### Phase 1: Foundation

```bash
cmcs worktree create telegram-bot-foundation
cp agents/plans/telegram-alert-bot/tickets/phase1-foundation/TICKET-*.md worktrees/telegram-bot-foundation/.cmcs/tickets/
cmcs run worktrees/telegram-bot-foundation
cmcs wait worktrees/telegram-bot-foundation
```

### Phase 2: Shared Logic

```bash
cmcs worktree create telegram-bot-shared-logic
cp agents/plans/telegram-alert-bot/tickets/phase2-shared-logic/TICKET-*.md worktrees/telegram-bot-shared-logic/.cmcs/tickets/
cmcs run worktrees/telegram-bot-shared-logic
cmcs wait worktrees/telegram-bot-shared-logic
```

### Phase 3: Webhook + Dispatch (parallel)

```bash
cmcs worktree create telegram-bot-webhook
cmcs worktree create telegram-bot-dispatch
cp agents/plans/telegram-alert-bot/tickets/phase3-webhook/TICKET-*.md worktrees/telegram-bot-webhook/.cmcs/tickets/
cp agents/plans/telegram-alert-bot/tickets/phase3-dispatch/TICKET-*.md worktrees/telegram-bot-dispatch/.cmcs/tickets/
cmcs run worktrees/telegram-bot-webhook 2>&1 &
cmcs run worktrees/telegram-bot-dispatch 2>&1 &
wait
```

### Phase 4: Docs & Scripts

```bash
cmcs worktree create telegram-bot-docs
cp agents/plans/telegram-alert-bot/tickets/phase4-docs/TICKET-*.md worktrees/telegram-bot-docs/.cmcs/tickets/
cmcs run worktrees/telegram-bot-docs
cmcs wait worktrees/telegram-bot-docs
```

## Review checklists per phase

### Phase 1

```bash
npm run build && cd worker && npx tsc --noEmit && npm test
# Verify migration file
test -f worker/migrations/0054_telegram_subscribers.sql && echo "OK: migration exists"
grep -c 'CREATE TABLE' worker/migrations/0054_telegram_subscribers.sql  # expect 3
# Verify env
grep 'TELEGRAM_WEBHOOK_SECRET' worker/src/lib/env.ts
# Verify telegram lib
grep 'export function escapeHtml' worker/src/lib/telegram.ts
grep 'export async function sendToChat' worker/src/lib/telegram.ts
grep 'export async function postTelegramMessage' worker/src/lib/telegram.ts
# Verify sendToChat consumes response body
grep -A2 'ok: true' worker/src/lib/telegram.ts | grep -q 'json\|text'
# Verify endpoint registration
grep 'telegram-webhook' shared/lib/api-endpoints.ts
# Verify rate limiter exemption
grep 'telegram-webhook' worker/src/handlers/http.ts
# Verify route context — both secret and bot token must be separate fields
grep 'telegramWebhookSecret' worker/src/router.ts
grep 'telegramBotToken' worker/src/router.ts
# Verify bot token passed separately from telegramCreds
grep 'TELEGRAM_BOT_TOKEN' worker/src/handlers/http.ts | grep -v telegramCreds
```

### Phase 2

```bash
npm run build && cd worker && npx tsc --noEmit && npm test
# Verify exports
grep 'export function resolveTicker' worker/src/lib/telegram-alerts.ts
grep 'export function parseSubscribeArgs' worker/src/lib/telegram-alerts.ts
grep 'export function formatConsolidatedMessage' worker/src/lib/telegram-alerts.ts
grep 'export function isDewsAlertable' worker/src/lib/telegram-alerts.ts
# Verify escapeHtml is imported from telegram.ts (NOT redefined)
grep 'import.*escapeHtml.*from.*telegram' worker/src/lib/telegram-alerts.ts
# Verify invalidTypes uses SYMBOL_INDEX for classification
grep 'SYMBOL_INDEX' worker/src/lib/telegram-alerts.ts | grep -q 'parseSubscribeArgs\|has(lower)'
# Verify tests exist
test -f worker/src/lib/__tests__/telegram-alerts.test.ts && echo "OK"
```

### Phase 3

```bash
npm run build && cd worker && npx tsc --noEmit && npm test
# Webhook
grep 'handleTelegramWebhook' worker/src/api/telegram-webhook.ts
grep 'handleTelegramWebhook' worker/src/router.ts
# Verify botToken uses telegramBotToken, NOT telegramCreds
grep 'telegramBotToken' worker/src/router.ts
# Dispatch
grep 'dispatchTelegramAlerts' worker/src/cron/dispatch-telegram-alerts.ts
grep 'dispatchTelegramAlerts' worker/src/handlers/scheduled.ts
# Cron schedule registration
grep 'dispatch-telegram-alerts' worker/src/lib/cron-schedule.ts
# Tests use vi.mock for cache (not mockD1 cache key matching)
grep 'vi.mock.*lib/db' worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts
# Tests
test -f worker/src/api/__tests__/telegram-webhook.test.ts && echo "OK"
test -f worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts && echo "OK"
```

### Phase 4

```bash
npm run build && cd worker && npx tsc --noEmit && npm test
test -x scripts/register-telegram-webhook.sh && echo "OK: script executable"
grep 'telegram-webhook' docs/architecture.md
grep 'telegram-webhook' docs/api-reference.md
grep 'dispatch-telegram-alerts' docs/worker-infrastructure.md
grep -i 'telegram' src/app/about/page.tsx
```

## Merge instructions

1. Phase 1 → main (no conflicts expected)
2. Phase 2 → main (no conflicts — new files only)
3. Phase 3A (webhook) → main first, then Phase 3B (dispatch) → main (no overlap)
4. Phase 4 → main (docs only)

## Worktree cleanup

After all phases are merged, remove the worktrees:

```bash
cmcs worktree remove telegram-bot-foundation
cmcs worktree remove telegram-bot-shared-logic
cmcs worktree remove telegram-bot-webhook
cmcs worktree remove telegram-bot-dispatch
cmcs worktree remove telegram-bot-docs
```

## Post-deploy smoke tests

After deploying to production:

```bash
# Verify webhook endpoint responds
curl -s -X POST "https://api.pharos.watch/api/telegram-webhook" \
  -H "Content-Type: application/json" \
  -d '{"message":{"chat":{"id":1},"text":"/start"}}' \
  -w "\n%{http_code}"
# Expect: 200 (rejected silently — no secret param)

# Verify endpoint is registered (health check)
curl -s "https://api.pharos.watch/api/health" | grep -o '"ok"'

# Register webhook with Telegram
TELEGRAM_BOT_TOKEN=<token> TELEGRAM_WEBHOOK_SECRET=<secret> ./scripts/register-telegram-webhook.sh

# Test bot: send /start in Telegram DM to the bot — should reply with welcome message
```

## Rollback procedures per phase

### Phase 1 (foundation)

```bash
# Revert code
git revert <phase1-merge-commit>
# D1: tables are new and empty — safe to drop
cd worker && npx wrangler d1 execute stablecoin-db --remote --command="DROP TABLE IF EXISTS telegram_pending_disambiguation; DROP TABLE IF EXISTS telegram_subscriptions; DROP TABLE IF EXISTS telegram_subscribers;"
```

### Phase 2 (shared logic)

```bash
git revert <phase2-merge-commit>
# No DB changes — code-only revert
```

### Phase 3 (webhook + dispatch)

```bash
git revert <phase3b-merge-commit>
git revert <phase3a-merge-commit>
# Deregister webhook
curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook"
```

### Phase 4 (docs)

```bash
git revert <phase4-merge-commit>
# Docs-only — no runtime impact
```

### Full rollback

```bash
# Revert all phases in reverse order
git revert <phase4> <phase3b> <phase3a> <phase2> <phase1>
# Drop tables
cd worker && npx wrangler d1 execute stablecoin-db --remote --command="DROP TABLE IF EXISTS telegram_pending_disambiguation; DROP TABLE IF EXISTS telegram_subscriptions; DROP TABLE IF EXISTS telegram_subscribers;"
# Delete webhook
curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook"
# Clean up cache entries
cd worker && npx wrangler d1 execute stablecoin-db --remote --command="DELETE FROM cache WHERE key LIKE 'alert:%';"
# Deploy reverted code
cd worker && npx wrangler deploy
```

## Known risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Fan-out exceeds Worker wall-time | 50-message cap per run, most-active-first ordering |
| Telegram API downtime | Circuit breaker skips dispatch, retries next cycle |
| Mass DEWS shift floods subscribers | 50-message cap, snapshot-based dedup |
| Bot blocked by user | Immediate deactivation on 403, no retry waste |
| D1 failure during webhook command | User gets "Something went wrong" reply, 200 returned |
| Stale snapshot after outage | 24h max age — re-seeds instead of alerting on old diffs |

## Orchestrator protocol

1. Create worktree for current phase
2. Copy tickets into worktree's `.cmcs/tickets/`
3. Run `cmcs run`, wait for completion
4. Review diff against implementation plan and design doc
5. Run review checklist commands
6. If all pass: merge to main, update PROGRESS.md
7. If failures: diagnose, fix ticket or code, re-run
8. Repeat for next phase

## When Codex fails

1. `cmcs logs <worktree>` — read agent output
2. Identify failure type: compilation error, test failure, wrong approach
3. If ticket was unclear: rewrite ticket with more specificity, re-run
4. If code bug: fix directly in worktree, re-run remaining tickets
5. If architectural issue: stop, reassess, potentially rewrite tickets

## After context compaction

Read these files in order:
1. `agents/plans/telegram-alert-bot/PROGRESS.md` — current state
2. This file (`execution-handover.md`) — pick up where progress says
3. `agents/plans/2026-03-08-telegram-alert-bot-design.md` — if you need design context

## Pre-flight checks

Before starting execution:
- [ ] `cmcs` is initialized (`cmcs status` works)
- [ ] Working tree is clean (`git status`)
- [ ] Main branch is up to date (`git pull`)
- [ ] `npm run build && cd worker && npx tsc --noEmit && npm test` all pass on main
- [ ] **Migration number check:** Verify `ls worker/migrations/ | tail -1` — the latest migration number must be `0053`. If another migration has been added since planning, update TICKET-001 in `phase1-foundation` to use the next available number.
- [ ] `TELEGRAM_WEBHOOK_SECRET` has been set via `wrangler secret put` (done by user)
- [ ] BotFather commands have been registered (done by user)
