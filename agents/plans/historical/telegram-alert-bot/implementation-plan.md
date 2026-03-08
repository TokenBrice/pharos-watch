# Telegram Alert Bot — Implementation Plan

> **For Claude:** REQUIRED PROCESS: Use cmcs-driven-development to execute this plan via Codex agents.

**Goal:** Add a Telegram bot that lets users subscribe to per-coin DEWS, depeg, and safety score alerts, integrated into the existing Cloudflare Worker.

**Architecture:** Webhook endpoint receives Telegram commands, writes subscriptions to D1. A cron job piggybacking on existing triggers diffs current state against cached snapshots and fans out consolidated alert messages to subscribers.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), Telegram Bot API, TypeScript

**Design document:** `agents/plans/2026-03-08-telegram-alert-bot-design.md`

---

## Execution Strategy

- **4 phases**, 5 worktrees (Phase 3 has 2 parallel worktrees), 12 tickets
- Phases are sequential gates. Phase 3 has two parallel worktrees (webhook + dispatch) touching non-overlapping files.
- Each phase merges to main before the next starts.

## Phase 1: Foundation (1 worktree, 3 tickets)

**Worktree:** `telegram-bot-foundation`

Scaffolding that everything else depends on: D1 schema, env types, telegram lib extension, endpoint registration + route context + rate limiter exemption.

| Ticket | Title | Model | Effort | Key Files |
|--------|-------|-------|--------|-----------|
| TICKET-001 | D1 migration for telegram tables | spark | low | `worker/migrations/0054_telegram_subscribers.sql` |
| TICKET-002 | Env interface + telegram lib extension | codex | medium | `worker/src/lib/env.ts`, `worker/src/lib/telegram.ts`, `worker/src/lib/__tests__/telegram.test.ts` (new) |
| TICKET-003 | Endpoint registration + route wiring + rate limiter exemption | codex | medium | `shared/lib/api-endpoints.ts`, `worker/src/router.ts`, `worker/src/handlers/http.ts` |

**Gate:** `npm run build && cd worker && npx tsc --noEmit && npm test` all pass.

## Phase 2: Shared Logic (1 worktree, 2 tickets)

**Worktree:** `telegram-bot-shared-logic`

The `telegram-alerts.ts` module used by both webhook handler and dispatch cron.

| Ticket | Title | Model | Effort | Key Files |
|--------|-------|-------|--------|-----------|
| TICKET-001 | Ticker resolution + command parsing | codex | high | `worker/src/lib/telegram-alerts.ts` (new), `worker/src/lib/__tests__/telegram-alerts.test.ts` (new) |
| TICKET-002 | Message templates + subscriber queries | codex | high | `worker/src/lib/telegram-alerts.ts`, `worker/src/lib/__tests__/telegram-alerts.test.ts` |

**Gate:** `npm run build && cd worker && npx tsc --noEmit && npm test` all pass.

## Phase 3: Webhook + Dispatch (2 parallel worktrees, 3+3 tickets)

### Worktree A: `telegram-bot-webhook`

| Ticket | Title | Model | Effort | Key Files |
|--------|-------|-------|--------|-----------|
| TICKET-001 | Webhook handler with all commands | gpt-5.4 | high | `worker/src/api/telegram-webhook.ts` (new) |
| TICKET-002 | Router wiring for webhook | spark | low | `worker/src/router.ts` |
| TICKET-003 | Webhook handler tests | codex | medium | `worker/src/api/__tests__/telegram-webhook.test.ts` (new) |

### Worktree B: `telegram-bot-dispatch`

| Ticket | Title | Model | Effort | Key Files |
|--------|-------|-------|--------|-----------|
| TICKET-001 | Alert dispatch cron job | gpt-5.4 | high | `worker/src/cron/dispatch-telegram-alerts.ts` (new) |
| TICKET-002 | Scheduled handler wiring + cron-schedule registration | codex | medium | `worker/src/handlers/scheduled.ts`, `worker/src/lib/cron-schedule.ts` |
| TICKET-003 | Dispatch cron tests | codex | medium | `worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts` (new) |

**File ownership (no overlap):**
- Worktree A owns: `worker/src/api/telegram-webhook.ts`, `worker/src/router.ts`, `worker/src/api/__tests__/telegram-webhook.test.ts`
- Worktree B owns: `worker/src/cron/dispatch-telegram-alerts.ts`, `worker/src/handlers/scheduled.ts`, `worker/src/lib/cron-schedule.ts`, `worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts`

**Gate:** Merge A first, then B. `npm run build && cd worker && npx tsc --noEmit && npm test` after each merge.

## Phase 4: Docs & Scripts (1 worktree, 1 ticket)

**Worktree:** `telegram-bot-docs`

| Ticket | Title | Model | Effort | Key Files |
|--------|-------|-------|--------|-----------|
| TICKET-001 | Documentation updates + webhook script | codex | medium | `scripts/register-telegram-webhook.sh`, `docs/architecture.md`, `docs/api-reference.md`, `docs/worker-infrastructure.md` |

**Gate:** `npm run build && cd worker && npx tsc --noEmit && npm test` all pass.

## Manual Steps

| Step | When | Command |
|------|------|---------|
| Apply D1 migration | After Phase 1 merge, before deploy | `cd worker && npx wrangler d1 migrations apply stablecoin-db --remote` |
| Deploy worker | After Phase 4 merge | `cd worker && npx wrangler deploy` |
| Register webhook | After deploy | `scripts/register-telegram-webhook.sh` |

## Worktree Dispatch Summary

```bash
# Phase 1
cmcs worktree create telegram-bot-foundation
# copy tickets/phase1-foundation/ to worktree
cmcs run worktrees/telegram-bot-foundation
cmcs wait worktrees/telegram-bot-foundation

# Phase 2
cmcs worktree create telegram-bot-shared-logic
# copy tickets/phase2-shared-logic/ to worktree
cmcs run worktrees/telegram-bot-shared-logic
cmcs wait worktrees/telegram-bot-shared-logic

# Phase 3 (parallel)
cmcs worktree create telegram-bot-webhook
cmcs worktree create telegram-bot-dispatch
# copy tickets to respective worktrees
cmcs run worktrees/telegram-bot-webhook 2>&1 &
cmcs run worktrees/telegram-bot-dispatch 2>&1 &
wait

# Phase 4
cmcs worktree create telegram-bot-docs
# copy tickets/phase4-docs/ to worktree
cmcs run worktrees/telegram-bot-docs
cmcs wait worktrees/telegram-bot-docs
```
