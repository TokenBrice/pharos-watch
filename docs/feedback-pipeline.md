# Feedback Pipeline

In-app feedback collection that routes all submissions to GitHub Issues.

---

## Overview

The feedback pipeline has four layers:

1. **`FeedbackButton`** — floating desktop/global trigger rendered in the root layout
2. **`MobileUtilityDock`** — mobile-only dock that can also open the feedback modal
3. **`FeedbackModal`** — dialog with a type selector, context banner, and form fields
4. **`POST /api/feedback`** — Cloudflare Worker endpoint that validates, rate-limits, and forwards to GitHub

Inside the worker route, the handler is intentionally split into focused modules:

- `worker/src/api/feedback/request.ts` for JSON parsing, business-rule validation, canonical ID normalization, and rate-limit / env policy checks
- `worker/src/api/feedback/verification.ts` for auto-verification snapshots
- `worker/src/api/feedback/submission.ts` plus `github.ts` / `format.ts` for GitHub routing and payload assembly

---

## Frontend Components

### `FeedbackButton` (`src/components/feedback-button.tsx`)

A fixed-position FAB rendered globally in `src/app/layout.tsx`. Renders at `bottom-6 right-6 z-50`. Opens `FeedbackModal` with default type `"bug"`.

```tsx
<FeedbackButton />
```

### `MobileUtilityDock` (`src/components/mobile-utility-dock.tsx`)

Mounted globally in `src/app/layout.tsx` alongside `FeedbackButton`.

- Mobile only (`sm:hidden`)
- Shows a compact feedback trigger after modest scroll depth
- Opens the same `FeedbackModal` component with default type `"bug"`

### `FeedbackModal` (`src/components/feedback-modal.tsx`)

A shadcn `Dialog` with three feedback modes selected via a segmented tab control.

**Props:**

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `open` | `boolean` | — | Controlled open state |
| `onOpenChange` | `(open: boolean) => void` | — | Open state callback |
| `defaultType` | `FeedbackType` | `"bug"` | Pre-selected feedback type |
| `stablecoinId` | `string` | — | Passed to the API for auto-verification |
| `stablecoinName` | `string` | — | Shown in the context banner |
| `pegValue` | `string` | — | Shown in the context banner |

**Feedback types:**

| Value | Label | Fields |
|-------|-------|--------|
| `"bug"` | Bug Report | Title (required), Description |
| `"data-correction"` | Data Correction | Description, Expected Value (optional) |
| `"feature-request"` | Feature Request | Title (required), Description |

**Context banner** — when `stablecoinName` or `pageUrl` is available, a muted banner above the form shows the stablecoin name, current value, and current page path. This gives maintainers the submission context without users needing to copy-paste it.

**Validation (client-side):**

- Description: 10–2000 characters
- Title: 3–100 characters (required for `bug` and `feature-request`)
- Submit button is disabled until both pass

**Honeypot:** a hidden `website` input (off-screen, `tabIndex=-1`, `aria-hidden`) is sent as an empty string. If the worker receives a non-empty `website` value, the submission is silently accepted but discarded.

**Submission:** `POST buildApiUrl("/api/feedback")` with `Content-Type: application/json`. On Pharos production and Pages preview hosts this resolves to `https://api.pharos.watch/api/feedback`; local proxy and explicit `NEXT_PUBLIC_API_BASE` setups follow the frontend runtime API rules in `src/lib/api.ts`. Optional contact handles are echoed publicly in the created GitHub issue. On success the modal transitions to a thank-you screen. On error the server's error message is displayed inline.

---

## API Endpoint

### `POST /api/feedback`

**Auth:** none (public endpoint)
**CORS:** standard Pharos headers (`Access-Control-Allow-Origin` = Worker `CORS_ORIGIN`, checked-in production allowlist `https://pharos.watch,https://ops.pharos.watch`)
**Caching:** not cached (bypasses edge cache)

#### Request body

```typescript
{
  type: "bug" | "data-correction" | "feature-request";
  title?: string;               // required for bug + feature-request
  description: string;          // 10–2000 characters
  expectedValue?: string;       // data-correction only; optional
  stablecoinId?: string;        // Pharos ID, used for auto-verification
  stablecoinName?: string;      // display name, appended to issue title
  pageUrl: string;              // must start with "/"
  pegValue?: string;            // current displayed peg value
  contactHandle?: string;       // optional Telegram/X handle shown on GitHub
  website?: string;             // honeypot — must be empty
}
```

#### Validation

| Field | Rule |
|-------|------|
| `type` | Must be one of the three valid values |
| `description` | 10–2000 characters after trim |
| `title` | 3–100 characters after trim; required for `bug` / `feature-request` |
| `pageUrl` | Must start with `"/"` |
| `contactHandle` | Optional; 2–100 characters after trim |
| `stablecoinId` | Checked with `resolveStablecoinId(...)`; unknown values return `400 Invalid stablecoinId` |
| `website` | Non-empty → silent 200 OK, no GitHub call |

#### Rate limiting

Implemented in D1 via the `feedback_rate_limit` table. Logic:

1. The client IP is taken from `CF-Connecting-IP` → `X-Forwarded-For` → `"unknown"`.
2. The IP is hashed: `SHA-256(ip + FEEDBACK_IP_SALT)`, truncated to 32 hex characters.
3. A single SQL statement atomically inserts only when the 10-minute count is below 3:
   - `INSERT INTO ... SELECT ... WHERE (SELECT COUNT(*)) < 3`
4. If no row is inserted, the endpoint returns `429 Too Many Submissions`.
5. Rows older than 3600 seconds are pruned in a non-blocking fire-and-forget call.

**D1 schema** (now part of `worker/migrations/0000_baseline.sql`; see `worker/migrations/MANIFEST.md` for the pre-squash lineage):

```sql
CREATE TABLE IF NOT EXISTS feedback_submissions (
  submission_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  submitted_at INTEGER,
  status TEXT NOT NULL,
  feedback_type TEXT NOT NULL,
  title TEXT,
  description TEXT NOT NULL,
  expected_value TEXT,
  stablecoin_id TEXT,
  stablecoin_name TEXT,
  page_url TEXT NOT NULL,
  peg_value TEXT,
  contact_consent INTEGER NOT NULL DEFAULT 0,
  contact_channel TEXT,
  contact_handle TEXT,
  github_target_kind TEXT,
  github_target_number INTEGER,
  github_target_url TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS feedback_rate_limit (
  ip_hash      TEXT    NOT NULL,
  submitted_at INTEGER NOT NULL   -- Unix timestamp (seconds)
);

CREATE INDEX IF NOT EXISTS idx_feedback_rate_limit_ip
  ON feedback_rate_limit(ip_hash, submitted_at);
```

`feedback_submissions` is retained in the schema as durable storage for the feedback domain, but the current runtime path creates the GitHub issue directly and does not yet persist one row per submission there.

#### Auto-verification (data corrections)

When `type === "data-correction"` and a valid `stablecoinId` is provided, the worker pulls the `stablecoins` cache row from D1 and computes a snapshot:

| Output | Source |
|--------|--------|
| Cached price | `coin.price` from the cached DefiLlama payload |
| Circulating supply | Sum of `coin.circulating` values |
| Peg deviation | `((price - pegReference) / pegReference) * 100` using the tracked peg currency |
| Cache age | `now - cache.updatedAt` in seconds |

The verification result produces one of three GitHub labels:

| Label | Meaning |
|-------|---------|
| `verified: confirmed` | `\|deviation\| > 1%` — the data issue is likely real |
| `verified: unconfirmed` | Price available but within 1% — data looks OK |
| `verified: pending` | Cache unavailable at submission time |

The full snapshot block is embedded in the GitHub issue body as a `**--- Auto-Verification Snapshot ---**` section.

For non-USD pegs, the worker now derives `pegReference` from the tracked peg type plus cached fallback rates (`peggedEUR`, `peggedGOLD`, etc.). Commodity pegs also respect `commodityOunces`, so tokens such as XAUT and PAXG are compared against per-token gold references rather than `$1`.

#### GitHub routing

| Type | Destination | Labels |
|------|-------------|--------|
| `"bug"` | GitHub Issue | `["bug"]` |
| `"data-correction"` | GitHub Issue | `["data-correction", "<verified-label>"]` |
| `"feature-request"` | GitHub Issue | `["feature-request"]` |

**Issue title format:**

| Type | Title |
|------|-------|
| `"bug"` | `[Bug] <title>` |
| `"data-correction"` | `[Data Correction] <stablecoinName>: <first 60 chars of description>…` |
| `"feature-request"` | `[Feature Request] <title>` |

**Issue body fields:**

- Type
- Stablecoin (name + ID, if provided)
- Page URL
- Current value (`pegValue`, if provided)
- Expected value / source (`expectedValue`, if provided)
- Description
- Auto-verification snapshot (data corrections only)
- Footer: `*Submitted via Pharos feedback widget*`

User-supplied strings are normalized before the GitHub write:

- `stablecoinName` and `pageUrl` have newlines stripped and length caps applied in `worker/src/api/feedback/format.ts`
- issue titles are length-validated by the request schema / handler rules
- `description` and `expectedValue` are trimmed, CRLF/NUL-normalized, `@` mentions are defanged as `@ `, and long backtick runs are escaped before the values are placed in fenced text blocks

#### Responses

| Status | Body | Condition |
|--------|------|-----------|
| `200` | `{"ok": true}` | Accepted (including honeypot trap) |
| `400` | `{"error": "<message>"}` | Validation failure |
| `429` | `{"error": "Too many submissions. Please wait a few minutes."}` | Rate limit exceeded |
| `500` | `{"error": "Failed to submit feedback. Please try again."}` | GitHub API error |
| `503` | `{"error": "Service misconfigured"}` | `FEEDBACK_IP_SALT` missing |
| `503` | `{"error": "Feedback service temporarily unavailable"}` | `GITHUB_PAT` not configured |

---

## Environment Variables

Set in `worker/wrangler.toml` (non-secret) or via Cloudflare dashboard / `wrangler secret put` (secrets):

| Variable | Type | Required | Description |
|----------|------|----------|-------------|
| `GITHUB_PAT` | Secret | Yes | Personal access token with `repo` scope (write Issues) |
| `FEEDBACK_IP_SALT` | Secret | Yes | Random string used to hash IPs before storage |

Without `FEEDBACK_IP_SALT` or `GITHUB_PAT` the endpoint returns 503.

---

## File Index

| File | Role |
|------|------|
| `src/components/feedback-button.tsx` | Floating action button, rendered in root layout |
| `src/components/mobile-utility-dock.tsx` | Mobile-only utility dock with a second feedback entry point |
| `src/components/feedback-modal.tsx` | Feedback dialog (form + submission logic) |
| `src/app/layout.tsx` | Mounts `<FeedbackButton />` and `<MobileUtilityDock />` globally |
| `worker/src/api/feedback.ts` | Thin route handler / coordinator |
| `worker/src/api/feedback/request.ts` | Request parsing, canonicalization, and policy checks |
| `worker/src/api/feedback/verification.ts` | Auto-verification snapshot builder for data corrections |
| `worker/src/api/feedback/submission.ts` | GitHub routing orchestration |
| `worker/src/api/feedback/github.ts` | GitHub REST transport helper |
| `worker/src/api/feedback/format.ts` | Issue body and title formatting |
| `worker/src/routes/registry.ts` | Registers `POST /api/feedback` route to `handleFeedback()` |
| `worker/migrations/0000_baseline.sql` | Baseline D1 rate-limit table schema for feedback submissions |
