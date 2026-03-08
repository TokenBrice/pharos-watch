---
title: "Create webhook handler with all bot commands"
agent: "codex"
model: "gpt-5.4"
reasoning_effort: "high"
done: false
---

## Goal

Create the Telegram webhook handler that processes all bot commands: /start, /help, /list, /subscribe (with disambiguation), and /unsubscribe.

## Context

**Design document:** Read `agents/plans/2026-03-08-telegram-alert-bot-design.md` for full specification of command interface, subscription semantics, disambiguation flow, validation rules, and upsert semantics.

**Key dependencies (already merged from Phase 1 + 2):**
- `worker/src/lib/telegram.ts` exports `sendToChat(chatId, text, botToken, opts)` returning `{ ok, blocked }`
- `worker/src/lib/telegram-alerts.ts` exports: `resolveTicker`, `parseSubscribeArgs`, `validateSubscribeArgs`, `formatDisambiguation`, `parseDisambiguationReply`, `formatListOutput`
- D1 tables: `telegram_subscribers`, `telegram_subscriptions`, `telegram_pending_disambiguation`

## Task

1. **Create `worker/src/api/telegram-webhook.ts`** with this structure:

```typescript
import { sendToChat } from "../lib/telegram";
import {
  resolveTicker,
  parseSubscribeArgs,
  validateSubscribeArgs,
  formatDisambiguation,
  parseDisambiguationReply,
  formatListOutput,
  type ResolvedCoin,
} from "../lib/telegram-alerts";

export async function handleTelegramWebhook(
  db: D1Database,
  request: Request,
  webhookSecret?: string,
  botToken?: string,
): Promise<Response> {
  // Always return 200 — Telegram retries on non-2xx
  const ok = () => new Response("ok", { status: 200 });

  // Validate secret
  const url = new URL(request.url);
  if (!webhookSecret || url.searchParams.get("secret") !== webhookSecret) {
    return ok(); // silent reject — don't leak info
  }
  if (!botToken) return ok();

  let update: { message?: { chat?: { id?: number; username?: string }; text?: string } };
  try {
    update = await request.json();
  } catch {
    return ok();
  }

  const chatId = update.message?.chat?.id?.toString();
  const text = update.message?.text?.trim();
  const username = update.message?.chat?.username ?? null;
  if (!chatId || !text) return ok();

  const reply = async (msg: string) => {
    try {
      await sendToChat(chatId, msg, botToken, { disableWebPagePreview: true });
    } catch { /* best-effort */ }
  };

  try {
    // Check for pending disambiguation first
    const pending = await db
      .prepare("SELECT * FROM telegram_pending_disambiguation WHERE chat_id = ?")
      .bind(chatId)
      .first<{
        alert_types: string; resolved_ids: string; ambiguous_ticker: string;
        candidates: string; remaining_tickers: string; expires_at: number;
      }>();

    if (pending) {
      const now = Math.floor(Date.now() / 1000);
      if (now < pending.expires_at) {
        // Handle disambiguation reply
        await handleDisambiguationReply(db, chatId, text, pending, botToken);
        return ok();
      }
      // Expired — delete and treat as fresh command
      await db.prepare("DELETE FROM telegram_pending_disambiguation WHERE chat_id = ?").bind(chatId).run();
    }

    // Route commands
    if (!text.startsWith("/")) return ok(); // Ignore non-commands

    const spaceIdx = text.indexOf(" ");
    const command = (spaceIdx === -1 ? text : text.slice(0, spaceIdx)).toLowerCase().replace(/@\w+$/, "");
    const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();

    switch (command) {
      case "/start":
        await reply(START_MESSAGE);
        break;
      case "/help":
        await reply(HELP_MESSAGE);
        break;
      case "/list":
        await handleList(db, chatId, botToken);
        break;
      case "/subscribe":
        await handleSubscribe(db, chatId, username, args, botToken);
        break;
      case "/unsubscribe":
        await handleUnsubscribe(db, chatId, args, botToken);
        break;
      default:
        await reply("Unknown command. Try /help");
    }
  } catch (err) {
    console.error("[telegram-webhook] Error:", err);
    await reply("Something went wrong, please try again.");
  }

  return ok();
}
```

2. **Implement the command handlers** as private functions in the same file:

**`handleList`**: Query `telegram_subscribers` for alert flags + `telegram_subscriptions` for coins. Format with `formatListOutput`. If no subscriber row exists, reply "No active subscriptions."

**`handleSubscribe`**:
- Parse with `parseSubscribeArgs`, validate with `validateSubscribeArgs`
- Resolve tickers left-to-right via `resolveTicker`
- If all unique: upsert subscriber + subscriptions via `db.batch()` using the upsert semantics from the design doc:
  - `INSERT INTO telegram_subscribers ... ON CONFLICT(chat_id) DO UPDATE SET alert_dews = MAX(alert_dews, ?), alert_depeg = MAX(alert_depeg, ?), alert_safety = MAX(alert_safety, ?), last_active_at = ?`
  - `INSERT OR IGNORE INTO telegram_subscriptions (chat_id, stablecoin_id) VALUES (?, ?)`
- If ambiguous ticker found: write `telegram_pending_disambiguation` row, send disambiguation prompt
- If not_found: report error with suggestion if available

**`handleUnsubscribe`**:
- If args is "all": `DELETE FROM telegram_subscriptions WHERE chat_id = ?` + `UPDATE telegram_subscribers SET alert_dews = 0, alert_depeg = 0, alert_safety = 0 WHERE chat_id = ?`
- Otherwise: resolve tickers, `DELETE FROM telegram_subscriptions WHERE chat_id = ? AND stablecoin_id IN (...)`

**`handleDisambiguationReply`**: Parse reply numbers, select candidates, merge into resolved_ids, continue with remaining tickers (may hit another ambiguity). When all resolved, upsert subscriptions.

3. **Define message constants** at the top of the file:

```typescript
const START_MESSAGE = `<b>Welcome to PharosWatcher</b>

I send you alerts when stablecoin risk signals change for the coins you choose.

<b>Alert types:</b>
- <b>dews</b> — DEWS threat level reaches ALERT, WARNING, or DANGER
- <b>depeg</b> — Depeg event triggered or resolved
- <b>safety</b> — Safety grade changes

<b>Quick start:</b>
/subscribe dews depeg USDC BOLD

Use /help for all commands.`;

const HELP_MESSAGE = `<b>Commands</b>

/subscribe &lt;types&gt; &lt;tickers&gt;
  Subscribe to alerts. Types: dews, depeg, safety
  Example: /subscribe dews depeg USDC BOLD

/unsubscribe &lt;tickers&gt;
  Remove coins from your subscriptions
  Example: /unsubscribe BOLD

/unsubscribe all
  Remove all subscriptions

/list
  Show your current subscriptions`;
```

## Acceptance Criteria

- `worker/src/api/telegram-webhook.ts` exists
- `grep -c 'export async function handleTelegramWebhook' worker/src/api/telegram-webhook.ts` returns 1
- `grep -c 'handleList\|handleSubscribe\|handleUnsubscribe\|handleDisambiguationReply' worker/src/api/telegram-webhook.ts` returns at least 4
- `grep -c 'ON CONFLICT' worker/src/api/telegram-webhook.ts` returns at least 1
- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
