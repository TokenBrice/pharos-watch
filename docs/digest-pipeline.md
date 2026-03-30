# Digest Pipeline

Daily AI-generated stablecoin market recap, distributed to the web, Twitter, and Telegram.

---

## Overview

The digest pipeline has four layers:

1. **Generation** — a Cloudflare Worker cron collects market data and calls Claude to produce a short editorial recap
2. **Storage** — the result is persisted to D1 (`daily_digest` table)
3. **Distribution** — posted to Twitter and Telegram immediately after generation
4. **Frontend** — served via public API endpoints, displayed on the homepage and a dedicated archive

Daily and weekly generation now share a common worker substrate in `worker/src/cron/digest/platform.ts` for the Anthropic request/parse path, `daily_digest` row insertion, and circuit-aware delivery wrappers. The daily and weekly jobs still own their distinct input-building and prompt logic.

Each digest has four fields produced by the LLM:

| Field | Description | Constraint |
|-------|-------------|------------|
| `title` | 2–6 word punchy headline | — |
| `text` | Tweet-sized distillation of the day's key take | ≤270 chars combined with title |
| `extended` | 3–4 short paragraphs of editorial analysis | 150–280 words target |
| `meta` | Editorial choice metadata for variety enforcement | `{ lead, tone, coins }` |

---

## Generation

**File:** `worker/src/cron/daily-digest.ts`
**Schedule:** daily at **08:05 UTC** (`"5 8 * * *"`)
**Dependency:** runs on the daily 08:05 UTC slot, five minutes after `snapshot-psi` writes the daily PSI row at 08:00 UTC
**Dedup guard:** skips if the latest digest is <1 hour old (bypassed by `force=true`)

### Data collection

The cron assembles a `DigestInputData` object from 16 sources before calling the LLM:

| Category | Source | Key signals |
|----------|--------|-------------|
| Market metrics | stablecoins cache | Total mcap, 7d delta, biggest supply mover (>$1M) |
| Depeg events | `depeg_events` table | Active count, top 3 by impact (bps × mcap) |
| Stability Index | `stability_index_samples` + `stability_index` | Current PSI from latest 15-min sample, yesterday's from daily table |
| Blacklist activity | `blacklist_events` (last 24h) | Event count, total USD affected; threshold: ≥2 events OR ≥$10M single |
| Supply velocity | top 10 coins by mcap | 1d vs 7d changes; signals: "reversed", "accelerating", "decelerating" (threshold: 2.5× weekly avg OR direction reversal) |
| Safety scores | computed real-time | Report card grades for mentioned coins + 2 "tension" coins (high peg score but low overall grade — structurally fragile despite stable peg) |
| Resolved depegs | `depeg_events` (last 48h) | Filters: peak >200 bps AND mcap >$50M; top 3 by peak deviation |
| Mint-burn flows | `mint_burn_hourly` | Bank Run Gauge (mcap-weighted composite), Flight-to-Quality (digest-local safe-haven vs risky net flows from `SAFE_HAVEN_IDS`), top pressure coins (\|FIS\| > 20) |
| DEWS stress | `stress_signals` + `stress_signal_history` | Band distribution (CALM/WATCH/ALERT/WARNING/DANGER), band changes crossing WATCH/ALERT boundary, elevated coins (ALERT+ with mcap >$10M) |
| Historical context | `stability_index` + `supply_history` | PSI precedent (last time score was at/below current), band streak, supply mover ATH and largest historical weekly change |
| Grade transitions | `safety_grade_history` | Report card grade changes (last 48h) with dimensional context; methodology re-grade guard (>10 simultaneous changes excluded) |
| PSI contributors | `stability_index_samples` (input_snapshot) | Top 3 coins driving PSI severity by market impact (|bps| x mcap x factor) |
| Yield anomalies | `yield_data` (is_best rows) | Coins with active warning signals (spike, divergence, tvl-outflow); APY vs 7d/30d averages; filtered to mcap >$10M |
| DEX liquidity shifts | `dex_liquidity_history` | Day-over-day score changes >=8 points; TVL comparison; filtered to mcap >$10M |
| Cross-day trends | `daily_digest` (archived input_data) | 7-day trajectories for PSI score/band, total mcap, and Bank Run Gauge; requires >=3 days of history |
| Recent digests | last 7 rows from `daily_digest` | Passed to LLM to enforce variety |

`DigestInputData` is defined in `shared/types/digest.ts` (re-exported via `shared/types/index.ts`) and imported by the digest cron, digest snapshot API, and frontend snapshot hook.

Four additional optional fields were added to `DigestInputData` in the v2 refinement: `mintBurnFlows`, `dewsStress`, `historicalContext`, and `gradeTransitions`. All are populated only when their source data exists — the LLM writes from what's available.

A further enrichment pass added four more optional fields: `psiContributors`, `yieldAnomalies`, `liquidityShifts`, and `crossDayTrends`. All are populated only when their source data exists.

Safety score computation is shared with the yield cron via `worker/src/lib/safety-scores.ts` (`computeSafetyScoresSnapshot()`), so grade lookups use one canonical scoring path.

The digest's Flight-to-Quality collector is not yet wired to the public `/api/mint-burn-flows` classification path. `worker/src/cron/daily-digest/collectors.ts` still buckets safe-haven flows using hardcoded `SAFE_HAVEN_IDS` from `worker/src/lib/mint-burn-contracts.ts`, while the public API now uses report-card-cache classification when available.

### LLM call

- **Model:** `claude-opus-4-6` via `https://api.anthropic.com/v1/messages`
- **Timeout:** 120 seconds (Opus generates slower than Sonnet; the cron runs at 08:05 UTC with no downstream time pressure)
- **Overload retries:** Anthropic `529 Overloaded` responses now back off exponentially (`5s`, `10s`, `20s`, `30s`) before the digest gives up
- **Voice:** sardonic financial columnist — dry, precise, no emojis, no exclamation marks
- **Priority rule:** rank everything by market impact (deviation × mcap); enrichment priority varies by regime
- **Regime classification:** a `classifyRegime()` function labels each day as CRISIS, TENSION, WATCHFUL, or CALM based on PSI band, active depegs, gauge score, FTQ status, and DEWS ALERT+ count
- **Narrative structure:** regime-aware P1/P2/P3 paragraph structure; PSI is always referenced but doesn't have to open; max 3 data categories per digest
- **Density contract:** 40–70 words per paragraph, 150–280 words total for the extended field
- **Structured sections:** When the digest covers two distinct stories, the LLM may use bold inline headers (e.g., `**Peg Watch**`, `**Capital Flows**`) to separate paragraphs. P1 (the lead) never has a header. The frontend renders these as styled inline spans.
- **Variety enforcement:** structured `meta` field (lead signal, tone, featured coins) from recent digests replaces raw text dump; falls back to raw text for pre-meta entries
- **Output:** raw JSON `{ "title": "...", "extended": "...", "text": "...", "meta": { "lead": "...", "tone": "...", "coins": [...] } }` — no markdown fences

### Failure handling

If JSON parsing fails, `title` and `extended` fall back to empty strings and `text` falls back to the raw LLM response (`rawText.trim()`). The digest is still stored and distribution is still attempted.

Digest generation now fails closed on stablecoins-cache availability: if the cached stablecoin payload is missing, malformed, or otherwise non-`ok`, the cron returns `status: "degraded"` and skips regeneration instead of synthesizing a false zero-mcap digest.

Safety-score enrichment also uses explicit degraded semantics. When `computeSafetyScoresSnapshot()` returns a degraded result, the digest still renders from the remaining inputs, but the safety section is omitted and the cron metadata records the degraded reason rather than fabricating distribution stats from an empty score set.

The early collectors now distinguish "no signal" from "collector failed". If the active-depeg, blacklist-activity, or supply-velocity queries error, `generateDailyDigest()` still stores the digest but:

- returns cron `status: "degraded"`
- appends the collector key to the cron metadata string
- stores the collector keys in `input_data.degradedSources`

---

## Storage

**Table:** `daily_digest`

```sql
CREATE TABLE daily_digest (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_at INTEGER NOT NULL,   -- Unix seconds
  digest_text  TEXT    NOT NULL,   -- tweet-sized text
  digest_title TEXT,               -- headline
  digest_extended TEXT,            -- longer editorial
  digest_meta    TEXT,             -- editorial metadata (lead, tone, coins) for variety enforcement
  input_data   TEXT    NOT NULL    -- full DigestInputData JSON for reconstruction
);

CREATE INDEX idx_daily_digest_generated_at ON daily_digest(generated_at);
```

The full `input_data` JSON is stored verbatim so detail pages can reconstruct the contextual snapshot for any historical date without re-fetching live data. When one of the early collectors fails, `input_data.degradedSources` records the failed collector keys (`active-depegs-query`, `blacklist-activity-query`, `supply-velocity-query`, etc.).

The `digest_meta` column stores structured metadata about editorial choices (lead signal, tone, featured coins) for variety enforcement across consecutive digests. Older rows with `NULL` `digest_meta` fall back to raw text comparison.

---

## API Endpoints

Read endpoints are public, but they do not all share the same cache profile: `GET /api/daily-digest` and `GET /api/digest-archive` use the standard 5-minute edge profile, while `GET /api/digest-snapshot` is treated as archive data and uses `s-maxage=86400, max-age=3600`. The manual trigger endpoint is admin-only. See [API Reference](./api-reference.md) for the full response shapes.

| Endpoint | Description |
|----------|-------------|
| `GET /api/daily-digest` | Latest digest only |
| `GET /api/digest-archive` | All digests, newest first (up to 365) |
| `GET /api/digest-snapshot?date=YYYY-MM-DD` | Input data + depeg/blacklist context for a daily digest date — used by SSG detail pages; cached as archive data (`s-maxage=86400, max-age=3600`) |
| `GET /api/digest-snapshot?date=YYYY-MM-DD-weekly` | Input data for a weekly recap slug; the handler strips `-weekly` for date parsing and returns the weekly snapshot when that digest row exists |
| `POST /api/trigger-digest` *(admin)* | Queue a background force-regeneration run and post to all distribution channels; requires Access service-token headers on `ops-api.pharos.watch` |

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

Before the Telegram channel post is sent, `worker/src/cron/daily-digest.ts` also asks `worker/src/lib/telegram-digest-appendices.ts` for any pending deploy-diff notices. When present, those notices are appended beneath the digest body:

- `New Cemetery Entries` for newly added cemetery rows
- `Tracking Changes` for newly tracked coins, split into live tracked vs pre-launch

Active tracked additions are queued earlier by `worker/src/cron/sync-stablecoins.ts`, which diffs the just-built stablecoins payload against the previous `stablecoins` cache before the cache row is overwritten. That queue is then consumed by the next successful Telegram digest post, so tracked additions are not lost when the digest appendix snapshot key is missing or has to be reseeded.

Appendix snapshots advance only after Telegram accepts the digest post, so a failed channel delivery does not lose pending additions.

Telegram delivery is also replay-safe per UTC date. `daily-digest.ts` writes a `daily-digest:telegram-sent:YYYY-MM-DD` marker only after Telegram accepts the post; if the digest later re-runs the same day, Telegram delivery is skipped as `already-sent` while appendix state can still be committed. This prevents duplicate channel posts without dropping pending appendix changes on a failed earlier attempt.

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
4. Add secrets from the worker directory: `cd worker && npx --no-install wrangler secret put TELEGRAM_BOT_TOKEN` and `cd worker && npx --no-install wrangler secret put TELEGRAM_CHAT_ID`

`telegram.ts` also exports `sendToChat()` for the Telegram webhook command handler, but digest generation still uses the same HTML `sendMessage` API path and credentials.

### Distribution status logging

Both statuses are returned in the cron result metadata and the admin trigger response:

```json
{ "metadata": "243 chars, tweet: ok, telegram: ok" }
```

Possible values per channel: `"no-creds"`, `"ok"`, `"failed: <truncated error>"`.

---

## Weekly Recap

**File:** `worker/src/cron/weekly-recap.ts`
**Schedule:** Mondays only, chained after `daily-digest` via `.finally()` on the same `"5 8 * * *"` trigger
**Dedup guard:** skips if a `digest_meta.type = "weekly"` row exists within the last 2 days

### Data collection

Fetches the last 7 daily digests (excluding weekly entries via `json_extract(digest_meta, '$.type') != 'weekly'`), parses their stored `input_data`, and aggregates:

| Metric | Derivation |
|--------|-----------|
| PSI range | Min, max, start, end scores + dominant band (most frequent) |
| Market cap range | Start, end, net change, percentage change |
| Depeg total | Sum of `activeDepegCount` across all days |
| Blacklist total | Sum of `blacklistActivity.eventCount` across all days |
| Grade transitions | Sum of `gradeTransitions.length` across all days |
| Gauge range | Min/max `mintBurnFlows.gaugeScore` (null if <3 data points) |

Requires >=5 daily digests to proceed.

### LLM call

- **Model:** `claude-opus-4-6`
- **Timeout:** 120 seconds
- **max_tokens:** 2000
- **Voice:** Same sardonic columnist, but synthesizing rather than reporting
- **Structure:** 4-6 paragraphs, 250-400 words: week's headline, dominant story, counter-narrative, supply/capital flows, optional structural observation

### Storage

Stored in the same `daily_digest` table. The `digest_meta` column includes `"type": "weekly"` plus `weekStart` and `weekEnd` date strings. The `input_data` column stores the `WeeklyInputData` aggregation (not raw `DigestInputData`).

### Distribution

Posted to Telegram only (no Twitter for weekly recaps). Title is prefixed with "Weekly Recap:".

---

## Frontend

### Broadsheet (shared component)

**Component:** `src/components/daily-digest.tsx`
**Hook:** `src/hooks/api-hooks.ts` (`useDailyDigest`) → `GET /api/daily-digest`
**Cache:** `staleTime: 86400s`, `refetchInterval: 172800s`

The latest digest is presented in a broadsheet newspaper style:
- **Masthead:** compact uppercase lockup with the full date; the homepage preview uses a slightly sharper mono masthead treatment than the archive broadsheet
- **Headline:** the homepage preview uses `Newsreader` at a larger newspaper-style display scale, while the full `/digest/` broadsheet keeps the original serif headline treatment
- **Body:** Extended text paragraphs in italic Courier-style monospace (`EDITORIAL_BODY_STYLE`). On the homepage, only the first editorial paragraph is shown as a teaser; the paragraph is preserved whole and never character-clamped mid-sentence. The `/digest/` archive broadsheet shows the full editorial body.
- **Homepage preview split:** desktop uses an asymmetric two-column layout with a hairline `Executive Summary` label and headline block on the left, then the lead paragraph plus CTA rail on the right

The `text` field remains the short distribution summary used for metadata and digest detail intros. The shared broadsheet renderer prefers `extended`, and falls back to `text` only if `extended` is unavailable.

Used in two places: the homepage (title + first editorial paragraph + "Read today's full digest" link) and the `/digest/` archive page (full broadsheet body, without the link since the wire table follows).

### Archive page

**Route:** `/digest/`
**Page:** `src/app/digest/page.tsx` (static route in the Next.js export)
**Component:** `src/components/digest-archive-client.tsx`
**Hook:** `src/hooks/api-hooks.ts` (`useDigestArchive`) → `GET /api/digest-archive`

The archive page has two zones:
1. **Broadsheet** — today's digest in full broadsheet layout (via `DailyDigest`)
2. **Wire table** — all historical digests in a dense, wire-service style list

The wire table shows each digest as a compact row: **date** (monospace, e.g. "27 FEB"), **title**, **PSI badge** (pill colored by condition band), and **total market cap**. A month picker dropdown filters the table by month. PSI and mcap data are served from the enriched archive API response (`psiScore`, `psiBand`, `totalMcapUsd` — parsed from the stored `input_data` JSON).

### Detail pages

**Route:** `/digest/[date]/`
**Page:** `src/app/digest/[date]/page.tsx` (SSG)
**Static params:** generated from `data/digests.json` at build time
**Component:** `src/components/digest-snapshot.tsx`
**Hook:** `src/hooks/api-hooks.ts` (`useDigestSnapshot`) → `GET /api/digest-snapshot?date={date}`

Daily detail pages use slugs like `/digest/2026-03-24/`. Weekly recap pages use `/digest/2026-03-24-weekly/`; the archive client builds those slugs from `digestType === "weekly"` and the snapshot API accepts the matching `?date=YYYY-MM-DD-weekly` query.

Each detail page shows the short summary intro (`text`) followed by every extended editorial paragraph plus 8 contextual data cards (Market Snapshot, Stability Index, Supply Mover, Active Depegs, Blacklist Activity, Safety Scores, Supply Velocity, Resolved Depegs). Includes JSON-LD Article structured data and prev/next navigation.

---

## Static Generation Pipeline

**Script:** `scripts/sync-digests.ts`
**Command:** `npm run sync:digests`

Fetches `GET /api/digest-archive` from an explicit API source, transforms it to the `data/digests.json` format (`date`, `title`, `text`, `extended`, `generatedAt`), and writes the file. The script accepts `--api-url` or `DIGEST_API_URL`, and falls back to `SMOKE_API_BASE` / `API_BASE_URL` when those are already set.

For local/manual use, point it at the intended environment explicitly:

```bash
npx tsx scripts/sync-digests.ts --api-url https://ops-api.example.com
```

CI now runs digest sync inside `.github/workflows/pages-prepare.yml`:

1. `build-pages` fetches `GET /api/digest-archive` once from the selected API environment and writes the normalized JSON directly to `data/digests.json` before `next build`.
2. On combined worker + Pages deploys, that selected API environment is the uploaded worker preview URL, so the static digest pages are built against the exact candidate worker before production promotion completes.

This keeps the Pages build itself network-independent once the digest snapshot has been fetched and avoids hard-coding `https://api.pharos.watch` into the build path.

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
| `worker/src/cron/daily-digest.ts` | Daily digest orchestration: data collection, prompt assembly, edition counting, and daily-specific publish behavior |
| `worker/src/cron/weekly-recap.ts` | Weekly recap orchestration: aggregates 7 days, builds weekly prompt/input, and weekly-specific Telegram title/meta shaping |
| `worker/src/cron/digest/platform.ts` | Shared digest substrate: Anthropic request/parse flow, `daily_digest` insertion, and circuit-aware channel delivery wrappers |
| `worker/src/lib/twitter.ts` | OAuth 1.0a signing, cashtag injection, tweet posting |
| `worker/src/lib/telegram.ts` | HTML message formatting, Telegram Bot API posting |
| `worker/src/api/daily-digest.ts` | `GET /api/daily-digest` handler |
| `worker/src/api/digest-archive.ts` | `GET /api/digest-archive` handler |
| `worker/src/api/digest-snapshot.ts` | `GET /api/digest-snapshot` handler |
| `worker/src/handlers/scheduled.ts` | Cron scheduling orchestration (daily digest runs after `snapshot-psi`) |
| `worker/src/route-registry.ts` | Static worker route bindings keyed by shared endpoint descriptors, including the background `trigger-digest` enqueue path |
| `worker/src/router.ts` | Worker route dispatcher for static registry lookup plus dynamic route matching |
| `worker/src/lib/env.ts` | `Env` interface used by fetch/scheduled handlers |
| `worker/migrations/0000_baseline.sql` | Baseline `daily_digest` schema, including the historical title/extended/meta additions |
| `src/components/daily-digest.tsx` | Broadsheet component (shared: homepage + archive page) |
| `src/components/digest-archive-client.tsx` | Archive page: broadsheet + wire table with month picker |
| `src/components/digest-snapshot.tsx` | Date-specific data cards (8 categories) |
| `src/app/digest/page.tsx` | Archive page route shell (static export) |
| `src/app/digest/[date]/page.tsx` | Detail page (SSG, JSON-LD, prev/next nav) |
| `src/hooks/api-hooks.ts` | TanStack Query hook exports for `useDailyDigest()`, `useDigestArchive()`, and `useDigestSnapshot()` |
| `scripts/sync-digests.ts` | Pre-build script: fetches archive → writes `data/digests.json` |
| `.github/workflows/pages-prepare.yml` | CI predeploy path: syncs digests, builds Pages export, runs local browser smoke |
| `.github/workflows/pages-publish.yml` | CI publish path: deploys the verified artifact and runs live browser smoke |
| `.github/workflows/pages-release.yml` | Wrapper workflow that composes the prepare + publish paths for scheduled/manual rebuilds |
| `data/digests.json` | Static digest list for SSG (generated, not hand-edited) |
