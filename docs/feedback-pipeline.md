# Feedback Pipeline

In-app feedback collection that routes submissions to GitHub Issues or Discussions.

---

## Overview

The feedback pipeline has three layers:

1. **`FeedbackButton`** — floating action button rendered in the root layout on every page
2. **`FeedbackModal`** — dialog with a type selector, context banner, and form fields
3. **`POST /api/feedback`** — Cloudflare Worker endpoint that validates, rate-limits, and forwards to GitHub

---

## Frontend Components

### `FeedbackButton` (`src/components/feedback-button.tsx`)

A fixed-position FAB rendered globally in `src/app/layout.tsx`. Renders at `bottom-6 right-6 z-50`. Opens `FeedbackModal` with default type `"bug"`.

```tsx
<FeedbackButton />
```

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

**Submission:** `POST https://api.pharos.watch/api/feedback` with `Content-Type: application/json`. On success the modal transitions to a thank-you screen. On error the server's error message is displayed inline.

---

## API Endpoint

### `POST /api/feedback`

**Auth:** none (public endpoint)
**CORS:** standard Pharos headers (`Access-Control-Allow-Origin` = Worker `CORS_ORIGIN`, production `https://pharos.watch`)
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
| `stablecoinId` | Validated with `isValidStablecoinId()`; silently stripped if invalid |
| `website` | Non-empty → silent 200 OK, no GitHub call |

#### Rate limiting

Implemented in D1 via the `feedback_rate_limit` table. Logic:

1. The client IP is taken from `CF-Connecting-IP` → `X-Forwarded-For` → `"unknown"`.
2. The IP is hashed: `SHA-256(ip + FEEDBACK_IP_SALT)`, truncated to 32 hex characters.
3. If the hash has ≥ 3 rows in the last 600 seconds → `429 Too Many Submissions`.
4. Otherwise, a new row is inserted.
5. Rows older than 3600 seconds are pruned in a non-blocking fire-and-forget call.

Note: D1 lacks row-level locking, so a small burst above 3 is possible in practice; this is acceptable for the use case.

**D1 schema** (`worker/migrations/0029_feedback_rate_limit.sql`):

```sql
CREATE TABLE IF NOT EXISTS feedback_rate_limit (
  ip_hash      TEXT    NOT NULL,
  submitted_at INTEGER NOT NULL   -- Unix timestamp (seconds)
);

CREATE INDEX IF NOT EXISTS idx_feedback_rate_limit_ip
  ON feedback_rate_limit(ip_hash, submitted_at);
```

#### Auto-verification (data corrections)

When `type === "data-correction"` and a valid `stablecoinId` is provided, the worker pulls the `stablecoins` cache row from D1 and computes a snapshot:

| Output | Source |
|--------|--------|
| Cached price | `coin.price` from the cached DefiLlama payload |
| Circulating supply | Sum of `coin.circulating` values |
| Peg deviation | `((price - 1.0) / 1.0) * 100` |
| Cache age | `now - cache.updatedAt` in seconds |

The verification result produces one of three GitHub labels:

| Label | Meaning |
|-------|---------|
| `verified: confirmed` | `\|deviation\| > 1%` — the data issue is likely real |
| `verified: unconfirmed` | Price available but within 1% — data looks OK |
| `verified: pending` | Cache unavailable at submission time |

The full snapshot block is embedded in the GitHub issue body as a `**--- Auto-Verification Snapshot ---**` section.

**Limitation:** `pegRef` is hardcoded to `1.0`, so non-USD stablecoins will show inflated deviation. The snapshot is still useful for triage context.

#### GitHub routing

| Type | Destination | Labels |
|------|-------------|--------|
| `"bug"` | GitHub Issue | `["bug"]` |
| `"data-correction"` | GitHub Issue | `["data-correction", "<verified-label>"]` |
| `"feature-request"` | GitHub Discussion (preferred) → Issue (fallback) | `["feature-request"]` (Issue fallback only) |

Feature requests are posted to GitHub Discussions using the GraphQL `createDiscussion` mutation when `GITHUB_REPO_NODE_ID` and `GITHUB_DISCUSSION_CATEGORY_ID` are configured. If either env var is absent or the GraphQL call fails, a regular Issue is created instead.

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

All user-supplied string fields are sanitised: newlines stripped, lengths capped.

#### Responses

| Status | Body | Condition |
|--------|------|-----------|
| `200` | `{"ok": true}` | Accepted (including honeypot trap) |
| `400` | `{"error": "<message>"}` | Validation failure |
| `429` | `{"error": "Too many submissions. Please wait a few minutes."}` | Rate limit exceeded |
| `500` | `{"error": "Failed to submit feedback. Please try again."}` | GitHub API error |
| `503` | `{"error": "Feedback service temporarily unavailable"}` | `GITHUB_PAT` not configured |

---

## Environment Variables

Set in `wrangler.toml` (non-secret) or via Cloudflare dashboard / `wrangler secret put` (secrets):

| Variable | Type | Required | Description |
|----------|------|----------|-------------|
| `GITHUB_PAT` | Secret | Yes | Personal access token with `repo` scope (write Issues + Discussions) |
| `FEEDBACK_IP_SALT` | Secret | Recommended | Random string used to hash IPs before storage |
| `GITHUB_REPO_NODE_ID` | Var | No | GraphQL node ID of the repo (enables Discussion routing for feature requests) |
| `GITHUB_DISCUSSION_CATEGORY_ID` | Var | No | GraphQL ID of the target Discussion category |

Without `GITHUB_PAT` the endpoint returns 503. Without `GITHUB_REPO_NODE_ID` / `GITHUB_DISCUSSION_CATEGORY_ID` feature requests fall back to Issues silently.

To retrieve the GraphQL IDs:

```bash
# Repo node ID
gh api graphql -f query='{ repository(owner: "TokenBrice", name: "stablecoin-dashboard") { id } }'

# Discussion category IDs
gh api graphql -f query='{ repository(owner: "TokenBrice", name: "stablecoin-dashboard") { discussionCategories(first: 10) { nodes { id name } } } }'
```

---

## File Index

| File | Role |
|------|------|
| `src/components/feedback-button.tsx` | Floating action button, rendered in root layout |
| `src/components/feedback-modal.tsx` | Feedback dialog (form + submission logic) |
| `src/app/layout.tsx` | Mounts `<FeedbackButton />` globally |
| `worker/src/api/feedback.ts` | Handler: validation, rate limiting, auto-verification, GitHub dispatch |
| `worker/src/index.ts` | Routes `POST /api/feedback` to `handleFeedback()` |
| `worker/migrations/0029_feedback_rate_limit.sql` | D1 rate-limit table migration |
