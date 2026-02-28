# Telegram Channel Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Post the daily digest to a public Telegram channel immediately after it is generated, using a reusable Telegram module that future crons can also call.

**Architecture:** A generic `worker/src/lib/telegram.ts` module with a `TelegramCreds` type and `postDigestToTelegram()` function. `generateDailyDigest()` accepts an optional `TelegramCreds | null` parameter (mirrors the existing Twitter pattern exactly). Both call sites in `worker/src/index.ts` (the scheduled cron and the `/api/trigger-digest` admin endpoint) construct creds from env vars and pass them in. Telegram posts are non-fatal — a failure logs a warning but never prevents the digest from being stored.

**Tech Stack:** Cloudflare Workers (fetch API, AbortSignal.timeout), Telegram Bot API (REST, HTML parse mode). No new dependencies.

---

### Task 1: Create `worker/src/lib/telegram.ts`

**Files:**
- Create: `worker/src/lib/telegram.ts`

**Step 1: Create the file**

```typescript
export interface TelegramCreds {
  botToken: string;
  chatId: string;
}

/** Escape HTML special characters for Telegram HTML parse mode. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Build the full Telegram message for a digest. */
export function buildTelegramMessage(title: string, extended: string, date: string): string {
  return `<b>${escapeHtml(title)}</b>\n\n${extended}\n\n<a href="https://pharos.watch/digest/${date}">Read on Pharos →</a>`;
}

/** Post a raw text message to a Telegram channel. Throws on API error. */
async function postTelegramMessage(text: string, creds: TelegramCreds): Promise<void> {
  const url = `https://api.telegram.org/bot${creds.botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: creds.chatId,
      text,
      parse_mode: "HTML",
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram API ${res.status}: ${body.slice(0, 300)}`);
  }
}

/**
 * Format and post a digest to the Telegram channel.
 * The caller is responsible for catching errors (this is non-fatal).
 */
export async function postDigestToTelegram(
  title: string,
  extended: string,
  date: string,
  creds: TelegramCreds,
): Promise<void> {
  const text = buildTelegramMessage(title, extended, date);
  await postTelegramMessage(text, creds);
  console.log(`[telegram] Posted digest (${text.length} chars)`);
}
```

**Step 2: Type-check**

```bash
cd worker && npx tsc --noEmit
```

Expected: no errors.

**Step 3: Commit**

```bash
git add worker/src/lib/telegram.ts
git commit -m "feat(telegram): add Telegram posting module"
```

---

### Task 2: Wire Telegram into `generateDailyDigest`

**Files:**
- Modify: `worker/src/cron/daily-digest.ts`

The function signature currently is:
```typescript
export async function generateDailyDigest(
  db: D1Database,
  anthropicApiKey: string | null,
  twitterCreds: TwitterCreds | null = null,
  force = false,
): Promise<CronResult>
```

**Step 1: Add the import at the top of `daily-digest.ts`** (after the existing `postDigestTweet` import on line 18):

```typescript
import { postDigestToTelegram, type TelegramCreds } from "../lib/telegram";
```

**Step 2: Add `telegramCreds` parameter to the function signature** (after `twitterCreds`):

Old:
```typescript
export async function generateDailyDigest(
  db: D1Database,
  anthropicApiKey: string | null,
  twitterCreds: TwitterCreds | null = null,
  force = false,
): Promise<CronResult>
```

New:
```typescript
export async function generateDailyDigest(
  db: D1Database,
  anthropicApiKey: string | null,
  twitterCreds: TwitterCreds | null = null,
  force = false,
  telegramCreds: TelegramCreds | null = null,
): Promise<CronResult>
```

**Step 3: Add the Telegram post block** directly after the existing Twitter block (around line 714). The `now` variable (Unix seconds) is set just before the INSERT on line 697.

Find this block (ends around line 715):
```typescript
  // Post to Twitter if credentials are available
  let tweetStatus = "no-creds";
  if (twitterCreds) {
    try {
      await postDigestTweet(digestTitle, digestText, twitterCreds);
      tweetStatus = "ok";
    } catch (err) {
      console.error("[daily-digest] Failed to post tweet (non-fatal):", err);
      tweetStatus = `failed: ${String(err).slice(0, 100)}`;
    }
  }
```

Add immediately after:
```typescript
  // Post to Telegram if credentials are available
  let telegramStatus = "no-creds";
  if (telegramCreds) {
    try {
      const date = new Date(now * 1000).toISOString().slice(0, 10);
      await postDigestToTelegram(digestTitle, digestExtended, date, telegramCreds);
      telegramStatus = "ok";
    } catch (err) {
      console.error("[daily-digest] Failed to post to Telegram (non-fatal):", err);
      telegramStatus = `failed: ${String(err).slice(0, 100)}`;
    }
  }
```

**Step 4: Update the final log line** (line 717) to include Telegram status.

Old:
```typescript
  console.log(`[daily-digest] Generated and stored digest: "${digestTitle}" (${digestText.length} chars + ${digestExtended.length} extended), tweet: ${tweetStatus}`);
  return { itemCount: 1, metadata: `${digestText.length} chars, tweet: ${tweetStatus}` };
```

New:
```typescript
  console.log(`[daily-digest] Generated and stored digest: "${digestTitle}" (${digestText.length} chars + ${digestExtended.length} extended), tweet: ${tweetStatus}, telegram: ${telegramStatus}`);
  return { itemCount: 1, metadata: `${digestText.length} chars, tweet: ${tweetStatus}, telegram: ${telegramStatus}` };
```

**Step 5: Type-check**

```bash
cd worker && npx tsc --noEmit
```

Expected: no errors. If you see errors about `digestExtended` being possibly undefined, check that `digestExtended` is guaranteed non-null at the point of the Telegram call (look for how `tweetStatus` uses `digestText` right above — same guarantee applies).

**Step 6: Commit**

```bash
git add worker/src/cron/daily-digest.ts
git commit -m "feat(telegram): wire Telegram into digest generation"
```

---

### Task 3: Update `worker/src/index.ts` — Env + two call sites

**Files:**
- Modify: `worker/src/index.ts`

**Step 1: Add two env vars to the `Env` interface** (lines 18–39, after the Twitter vars on lines 35–38):

Old:
```typescript
  TWITTER_API_KEY?: string;
  TWITTER_API_SECRET?: string;
  TWITTER_ACCESS_TOKEN?: string;
  TWITTER_ACCESS_TOKEN_SECRET?: string;
}
```

New:
```typescript
  TWITTER_API_KEY?: string;
  TWITTER_API_SECRET?: string;
  TWITTER_ACCESS_TOKEN?: string;
  TWITTER_ACCESS_TOKEN_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}
```

**Step 2: Update the `/api/trigger-digest` admin handler** to construct `telegramCreds` and pass it. Find the block around line 107–112:

Old:
```typescript
      const twitterCreds =
        env.TWITTER_API_KEY && env.TWITTER_API_SECRET && env.TWITTER_ACCESS_TOKEN && env.TWITTER_ACCESS_TOKEN_SECRET
          ? { apiKey: env.TWITTER_API_KEY, apiSecret: env.TWITTER_API_SECRET, accessToken: env.TWITTER_ACCESS_TOKEN, accessTokenSecret: env.TWITTER_ACCESS_TOKEN_SECRET }
          : null;
      try {
        const result = await generateDailyDigest(env.DB, env.ANTHROPIC_API_KEY ?? null, twitterCreds, true);
```

New:
```typescript
      const twitterCreds =
        env.TWITTER_API_KEY && env.TWITTER_API_SECRET && env.TWITTER_ACCESS_TOKEN && env.TWITTER_ACCESS_TOKEN_SECRET
          ? { apiKey: env.TWITTER_API_KEY, apiSecret: env.TWITTER_API_SECRET, accessToken: env.TWITTER_ACCESS_TOKEN, accessTokenSecret: env.TWITTER_ACCESS_TOKEN_SECRET }
          : null;
      const telegramCreds =
        env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
          ? { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID }
          : null;
      try {
        const result = await generateDailyDigest(env.DB, env.ANTHROPIC_API_KEY ?? null, twitterCreds, true, telegramCreds);
```

**Step 3: Update the scheduled cron handler** (around line 228–241). Find:

Old:
```typescript
        ctx.waitUntil(psiPromise.then(() => logCronRun(db, "daily-digest", () => {
          const twitterCreds =
            env.TWITTER_API_KEY &&
            env.TWITTER_API_SECRET &&
            env.TWITTER_ACCESS_TOKEN &&
            env.TWITTER_ACCESS_TOKEN_SECRET
              ? {
                  apiKey: env.TWITTER_API_KEY,
                  apiSecret: env.TWITTER_API_SECRET,
                  accessToken: env.TWITTER_ACCESS_TOKEN,
                  accessTokenSecret: env.TWITTER_ACCESS_TOKEN_SECRET,
                }
              : null;
          return generateDailyDigest(db, env.ANTHROPIC_API_KEY ?? null, twitterCreds);
        })));
```

New:
```typescript
        ctx.waitUntil(psiPromise.then(() => logCronRun(db, "daily-digest", () => {
          const twitterCreds =
            env.TWITTER_API_KEY &&
            env.TWITTER_API_SECRET &&
            env.TWITTER_ACCESS_TOKEN &&
            env.TWITTER_ACCESS_TOKEN_SECRET
              ? {
                  apiKey: env.TWITTER_API_KEY,
                  apiSecret: env.TWITTER_API_SECRET,
                  accessToken: env.TWITTER_ACCESS_TOKEN,
                  accessTokenSecret: env.TWITTER_ACCESS_TOKEN_SECRET,
                }
              : null;
          const telegramCreds =
            env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
              ? { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID }
              : null;
          return generateDailyDigest(db, env.ANTHROPIC_API_KEY ?? null, twitterCreds, false, telegramCreds);
        })));
```

**Step 4: Type-check**

```bash
cd worker && npx tsc --noEmit
```

Expected: no errors.

**Step 5: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat(telegram): add Telegram env vars and wire into cron + admin handler"
```

---

### Task 4: Add secrets and verify end-to-end

**Step 1: Create the Telegram bot and channel (one-time manual setup)**

1. Open Telegram, message `@BotFather`
2. `/newbot` → follow prompts → copy the bot token
3. Create the channel (public, e.g. `@pharos_watch`)
4. Add the bot to the channel → promote to Admin → enable "Post Messages"
5. The channel's `CHAT_ID` is either its username (`@pharos_watch`) or numeric ID

**Step 2: Add secrets to the Worker**

```bash
cd worker
npx wrangler secret put TELEGRAM_BOT_TOKEN
# Paste the bot token when prompted

npx wrangler secret put TELEGRAM_CHAT_ID
# Paste @pharos_watch (or numeric channel ID) when prompted
```

**Step 3: Force-trigger a test digest**

```bash
curl -H "X-Admin-Key: <your-admin-key>" https://api.pharos.watch/api/trigger-digest
```

Expected response: `{"ok":true,"result":{"itemCount":1,"metadata":"... telegram: ok"}}`

Check the Telegram channel — the digest should appear as a formatted message with bold title, extended text, and a link to `pharos.watch/digest/{date}`.

**Step 4: Final type-check and lint**

```bash
cd worker && npx tsc --noEmit
cd .. && npm run lint
```

Expected: no errors.

**Step 5: Commit if any remaining changes**

```bash
git add -p
git commit -m "chore: verify Telegram integration end-to-end"
```
