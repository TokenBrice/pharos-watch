# Digest Pipeline

Daily AI-generated stablecoin market recap, distributed to the web, Twitter, and Telegram.

---

## Overview

The digest pipeline has four layers:

1. **Generation** — a Cloudflare Worker cron collects market data and calls Claude to produce a short editorial recap
2. **Storage** — the result is persisted to D1 (`daily_digest` table)
3. **Distribution** — posted to Twitter and Telegram immediately after generation
4. **Frontend** — served via public API endpoints, displayed on the homepage and a dedicated archive

Each digest has three fields produced by the LLM:

| Field | Description | Constraint |
|-------|-------------|------------|
| `title` | 2–6 word punchy headline | — |
| `text` | Tweet-sized distillation of the day's key take | ≤270 chars combined with title |
| `extended` | 1–3 sentences of sharp editorial analysis | No limit |

---

## Generation

**File:** `worker/src/cron/daily-digest.ts`
**Schedule:** daily at **08:00 UTC** (`"0 8 * * *"`)
**Dependency:** runs after `snapshot-psi` completes (PSI data must be fresh)
**Dedup guard:** skips if the latest digest is <1 hour old (bypassed by `force=true`)

### Data collection

The cron assembles a `DigestInputData` object from 8 sources before calling the LLM:

| Category | Source | Key signals |
|----------|--------|-------------|
| Market metrics | stablecoins cache | Total mcap, 7d delta, biggest supply mover (>$1M) |
| Depeg events | `depeg_events` table | Active count, top 3 by impact (bps × mcap) |
| Stability Index | `stability_index_samples` + `stability_index` | Current PSI from latest 15-min sample, yesterday's from daily table |
| Blacklist activity | `blacklist_events` (last 24h) | Event count, total USD affected; threshold: ≥2 events OR ≥$10M single |
| Supply velocity | top 10 coins by mcap | 1d vs 7d changes; signals: "reversed", "accelerating", "decelerating" (threshold: 2.5× weekly avg OR direction reversal) |
| Safety scores | computed real-time | Report card grades for mentioned coins + 2 "tension" coins (high peg score but low overall grade — structurally fragile despite stable peg) |
| Resolved depegs | `depeg_events` (last 48h) | Filters: peak >200 bps AND mcap >$50M; top 3 by peak deviation |
| Recent digests | last 5 rows from `daily_digest` | Passed to LLM to enforce variety |

`DigestInputData` is defined once in `shared/types/index.ts` and imported by the digest cron, digest snapshot API, and frontend snapshot hook.

Safety score computation is shared with the yield cron via `worker/src/lib/safety-scores.ts` (`computeSafetyScoresSnapshot()`), so grade lookups use one canonical scoring path.

### LLM call

- **Model:** `claude-sonnet-4-6` via `https://api.anthropic.com/v1/messages`
- **Voice:** sardonic financial columnist — dry, precise, no emojis, no exclamation marks
- **Priority rule:** rank everything by market impact (deviation × mcap); band transitions lead the headline
- **Variety enforcement:** last 5 digests are included so the LLM avoids repeating phrasing or structure
- **Output:** raw JSON `{ "title": "...", "extended": "...", "text": "..." }` — no markdown fences

### Failure handling

If JSON parsing fails, `title` and `extended` fall back to empty strings and `text` falls back to the raw LLM response (`rawText.trim()`). The digest is still stored and distribution is still attempted.

---

## Storage

**Table:** `daily_digest`

```sql
CREATE TABLE daily_digest (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_at INTEGER NOT NULL,   -- Unix seconds
  digest_text  TEXT    NOT NULL,   -- tweet-sized text
  digest_title TEXT,               -- headline (added migration 0021)
  digest_extended TEXT,            -- longer editorial (added migration 0027)
  input_data   TEXT    NOT NULL    -- full DigestInputData JSON for reconstruction
);

CREATE INDEX idx_daily_digest_generated_at ON daily_digest(generated_at);
```

The full `input_data` JSON is stored verbatim so detail pages can reconstruct the contextual snapshot for any historical date without re-fetching live data.

---

## API Endpoints

Read endpoints are public with standard/slow cache headers (5-min or 60-min edge, depending on route). The manual trigger endpoint is admin-only. See `docs/api-reference.md` for full response shapes.

| Endpoint | Description |
|----------|-------------|
| `GET /api/daily-digest` | Latest digest only |
| `GET /api/digest-archive` | All digests, newest first (up to 365) |
| `GET /api/digest-snapshot?date=YYYY-MM-DD` | Input data + depeg/blacklist context for a specific date — used by SSG detail pages |
| `POST /api/trigger-digest` *(admin)* | Force-regenerate digest and post to all distribution channels; requires `X-Admin-Key` header |

---

## Distribution

After the digest is stored in D1, it is posted to external channels. Both integrations are **non-fatal**: a delivery failure logs a warning but never prevents the digest from being stored.

### Twitter

**File:** `worker/src/lib/twitter.ts`

- Auth: **OAuth 1.0a** signed with `crypto.subtle.HMAC-SHA1` (no third-party library)
- Format: `{title}\n\n{text}` — cashtag `$` prefixes auto-injected on first mention of each tracked ticker; truncated to 280 chars if needed
- Endpoint: `POST https://api.twitter.com/2/tweets`

**Required secrets:**

| Variable | Description |
|----------|-------------|
| `TWITTER_API_KEY` | OAuth consumer key |
| `TWITTER_API_SECRET` | OAuth consumer secret |
| `TWITTER_ACCESS_TOKEN` | OAuth access token |
| `TWITTER_ACCESS_TOKEN_SECRET` | OAuth access token secret |

If any of the four are absent, Twitter posting is skipped silently.

### Telegram

**File:** `worker/src/lib/telegram.ts`

- Auth: bot token embedded in the request URL (no OAuth)
- Parse mode: **HTML** — title is wrapped in `<b>`, link uses `<a href>`
- Format:
  ```
  <b>{title}</b>

  {extended}

  <a href="https://pharos.watch/digest/YYYY-MM-DD">Read on Pharos →</a>
  ```
- Endpoint: `POST https://api.telegram.org/bot{token}/sendMessage`

The `extended` field is used (not `text`) because Telegram's 4096-char limit removes the need for truncation, and the longer copy reads better in a channel context.

**Required secrets:**

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Channel username (e.g. `@pharoswatch`) or numeric channel ID |

If either is absent, Telegram posting is skipped silently.

**Channel setup (one-time):**

1. Create a bot via @BotFather → `/newbot` → copy token
2. Create the public channel
3. Add the bot as Admin with "Post Messages" permission only
4. Add secrets: `cd worker && npx wrangler secret put TELEGRAM_BOT_TOKEN` / `npx wrangler secret put TELEGRAM_CHAT_ID`

`telegram.ts` currently exports digest-posting helpers only (`buildTelegramMessage`, `postDigestToTelegram`).

### Distribution status logging

Both statuses are returned in the cron result metadata and the admin trigger response:

```json
{ "metadata": "243 chars, tweet: ok, telegram: ok" }
```

Possible values per channel: `"no-creds"`, `"ok"`, `"failed: <truncated error>"`.

---

## Frontend

### Broadsheet (shared component)

**Component:** `src/components/daily-digest.tsx`
**Hook:** `src/hooks/use-daily-digest.ts` → `GET /api/daily-digest`
**Cache:** `staleTime: 86400s`, `refetchInterval: 172800s`

The latest digest is presented in a broadsheet newspaper style:
- **Masthead:** "PHAROS DAILY DIGEST" centered in small-caps with the full date below, bordered by horizontal rules
- **Headline:** Digest title in large serif font (Georgia)
- **Body:** Extended text paragraphs in serif italic

The `text` field (tweet-sized copy) is **never rendered on the website** — it exists solely for Twitter distribution. Only `title` and `extended` appear on the site.

Used in two places: the homepage (with "Read all previous recaps" link) and the `/digest/` archive page (without the link, since the wire table follows).

### Archive page

**Route:** `/digest/`
**Page:** `src/app/digest/page.tsx` (SSR)
**Component:** `src/components/digest-archive-client.tsx`
**Hook:** `src/hooks/use-digest-archive.ts` → `GET /api/digest-archive`

The archive page has two zones:
1. **Broadsheet** — today's digest in full broadsheet layout (via `DailyDigest`)
2. **Wire table** — all historical digests in a dense, wire-service style list

The wire table shows each digest as a compact row: **date** (monospace, e.g. "27 FEB"), **title**, **PSI badge** (pill colored by condition band), and **total market cap**. A month picker dropdown filters the table by month. PSI and mcap data are served from the enriched archive API response (`psiScore`, `psiBand`, `totalMcapUsd` — parsed from the stored `input_data` JSON).

### Detail pages

**Route:** `/digest/[date]/`
**Page:** `src/app/digest/[date]/page.tsx` (SSG)
**Static params:** generated from `data/digests.json` at build time
**Component:** `src/components/digest-snapshot.tsx`
**Hook:** `src/hooks/use-digest-snapshot.ts` → `GET /api/digest-snapshot?date={date}`

Each detail page shows the full digest text plus 8 contextual data cards (Market Snapshot, Stability Index, Supply Mover, Active Depegs, Blacklist Activity, Safety Scores, Supply Velocity, Resolved Depegs). Includes JSON-LD Article structured data and prev/next navigation.

---

## Static Generation Pipeline

**Script:** `scripts/sync-digests.ts`
**Command:** `npm run sync:digests`

Fetches `GET /api/digest-archive` from the live API, transforms to the `data/digests.json` format (`date`, `title`, `text`, `extended`, `generatedAt`), and writes the file. This must run before `next build` so `generateStaticParams()` in `[date]/page.tsx` has fresh data.

---

## Environment Variables

| Variable | Type | Required | Description |
|----------|------|----------|-------------|
| `ANTHROPIC_API_KEY` | Secret | Yes | Claude API key for digest generation |
| `TWITTER_API_KEY` | Secret | No | Twitter OAuth consumer key |
| `TWITTER_API_SECRET` | Secret | No | Twitter OAuth consumer secret |
| `TWITTER_ACCESS_TOKEN` | Secret | No | Twitter OAuth access token |
| `TWITTER_ACCESS_TOKEN_SECRET` | Secret | No | Twitter OAuth access token secret |
| `TELEGRAM_BOT_TOKEN` | Secret | No | Telegram bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Secret | No | Telegram channel username or numeric ID |

Without `ANTHROPIC_API_KEY`, generation is skipped entirely. Twitter and Telegram are both optional — the digest is always stored regardless.

---

## File Index

| File | Role |
|------|------|
| `worker/src/cron/daily-digest.ts` | Generation logic: data collection, LLM call, storage, distribution dispatch |
| `worker/src/lib/twitter.ts` | OAuth 1.0a signing, cashtag injection, tweet posting |
| `worker/src/lib/telegram.ts` | HTML message formatting, Telegram Bot API posting |
| `worker/src/api/daily-digest.ts` | `GET /api/daily-digest` handler |
| `worker/src/api/digest-archive.ts` | `GET /api/digest-archive` handler |
| `worker/src/api/digest-snapshot.ts` | `GET /api/digest-snapshot` handler |
| `worker/src/index.ts` | Cron scheduling, `POST /api/trigger-digest` admin handler, `Env` interface |
| `worker/migrations/0018_daily_digest.sql` | Initial `daily_digest` table |
| `worker/migrations/0021_digest_title.sql` | Added `digest_title` column |
| `worker/migrations/0027_digest_extended.sql` | Added `digest_extended` column |
| `src/components/daily-digest.tsx` | Broadsheet component (shared: homepage + archive page) |
| `src/components/digest-archive-client.tsx` | Archive page: broadsheet + wire table with month picker |
| `src/components/digest-snapshot.tsx` | Date-specific data cards (8 categories) |
| `src/app/digest/page.tsx` | Archive page (SSR) |
| `src/app/digest/[date]/page.tsx` | Detail page (SSG, JSON-LD, prev/next nav) |
| `src/hooks/use-daily-digest.ts` | TanStack Query hook for latest digest |
| `src/hooks/use-digest-archive.ts` | TanStack Query hook for full archive |
| `src/hooks/use-digest-snapshot.ts` | TanStack Query hook for date snapshot |
| `scripts/sync-digests.ts` | Pre-build script: fetches archive → writes `data/digests.json` |
| `data/digests.json` | Static digest list for SSG (generated, not hand-edited) |
