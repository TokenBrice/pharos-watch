---
title: "Create D1 migration for telegram subscriber tables"
agent: "codex"
model: "gpt-5.3-codex-spark"
reasoning_effort: "low"
done: false
---

## Goal

Create the D1 migration SQL file that adds three new tables for Telegram bot subscriber management.

## Task

1. **Create `worker/migrations/0054_telegram_subscribers.sql`** with the following SQL:

```sql
CREATE TABLE IF NOT EXISTS telegram_subscribers (
  chat_id TEXT PRIMARY KEY,
  username TEXT,
  alert_dews INTEGER NOT NULL DEFAULT 0,
  alert_depeg INTEGER NOT NULL DEFAULT 0,
  alert_safety INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_subscriptions (
  chat_id TEXT NOT NULL,
  stablecoin_id TEXT NOT NULL,
  PRIMARY KEY (chat_id, stablecoin_id)
);

CREATE INDEX IF NOT EXISTS idx_tg_sub_coin ON telegram_subscriptions (stablecoin_id);

CREATE TABLE IF NOT EXISTS telegram_pending_disambiguation (
  chat_id TEXT PRIMARY KEY,
  alert_types TEXT NOT NULL,
  resolved_ids TEXT NOT NULL,
  ambiguous_ticker TEXT NOT NULL,
  candidates TEXT NOT NULL,
  remaining_tickers TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
```

## Acceptance Criteria

- `worker/migrations/0054_telegram_subscribers.sql` exists
- File contains exactly 3 `CREATE TABLE` statements
- File contains exactly 1 `CREATE INDEX` statement
- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
