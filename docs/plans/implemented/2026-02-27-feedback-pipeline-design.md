# Feedback Pipeline Design

**Date:** 2026-02-27
**Status:** Draft

## Overview

Pharos users have no in-app way to report data issues, bugs, or suggest features. This document designs a feedback collection and processing pipeline starting from zero. The guiding constraints:

- Users submit feedback **without leaving Pharos**
- Data corrections are the highest-priority feedback type
- Triage happens in **GitHub** (Issues + Discussions) — zero new tooling
- The stack is Cloudflare Worker + D1; no new infrastructure

---

## Architecture

```
[Pharos frontend]
  Floating "Feedback" button (all pages)
  Inline "Report data issue" link (stablecoin detail pages, table rows)
        ↓ opens
  FeedbackModal (React / shadcn Dialog)
  - type selector: Bug | Data Correction | Feature Request
  - auto-fills: page path, stablecoinId, current peg value (if applicable)
        ↓ POST /api/feedback
  Cloudflare Worker
  - input validation + length limits
  - honeypot check
  - rate-limit check (D1: feedback_rate_limit table)
  - route by type:
      Bug / Data Correction  →  GitHub Issues REST API
      Feature Request        →  GitHub Discussions GraphQL API
        ↓
  GitHub repo
  - Issues: triaged by you, labeled automatically
  - Discussions: public, users can upvote and comment
```

### GitHub API notes

- **Issues** (bugs, data corrections): standard REST `POST /repos/{owner}/{repo}/issues`
- **Discussions** (feature requests): requires GraphQL `createDiscussion` mutation — REST is read-only for discussions. Two constants must be stored as Worker secrets or env vars:
  - `GITHUB_REPO_NODE_ID` — the repo's GraphQL node ID (fetch once via API)
  - `GITHUB_DISCUSSION_CATEGORY_ID` — the "Ideas" category node ID (create category once in GitHub, then fetch its ID)
- A GitHub PAT with `repo` + `write:discussion` scopes is stored as Worker secret `GITHUB_PAT`

---

## Frontend

### Floating button

- Fixed position, bottom-right corner, all pages
- Small "Feedback" pill (matches Pharos design system)
- Clicking opens FeedbackModal with no pre-selected type

### Inline triggers

Two placement contexts:

1. **Stablecoin detail page** (`/stablecoin/[id]`): a "Report data issue" link near the peg/price section. Opens modal pre-set to Data Correction with stablecoin ID filled.
2. **Main table rows**: a small flag icon appearing on row hover. Opens modal pre-set to Data Correction with that stablecoin's ID filled.

### FeedbackModal

A shadcn `Dialog` with three mode tabs: **Bug Report**, **Data Correction**, **Feature Request**.

**Shared fields (all types):**
- Context banner (read-only): current page path, stablecoin name if applicable
- Description textarea (required, max 2000 chars)
- Honeypot: `<input name="website" style="display:none" />` — if filled, submission is silently dropped

**Bug Report additional fields:**
- Title (required, max 100 chars)

**Data Correction additional fields:**
- "What is wrong?" (required) — pre-populated description prompt: "e.g. USDC shows $0.00 price since yesterday"
- "Expected value / source" (optional) — free text: "e.g. CoinGecko shows $1.0001"

**Feature Request additional fields:**
- Title (required, max 100 chars)

**Submission states:**
- Idle → Loading (spinner, button disabled) → Success ("Thanks — submitted!") | Error ("Something went wrong, try again")
- No page navigation at any point

---

## Backend: `/api/feedback` Worker endpoint

**Method:** `POST`
**Auth:** None (public endpoint)
**Rate limit:** 3 submissions per hashed IP per 10 minutes (enforced via D1)

### Request body

```ts
{
  type: "bug" | "data-correction" | "feature-request";
  title?: string;           // required for bug + feature-request
  description: string;      // required, all types
  expectedValue?: string;   // data-correction only
  stablecoinId?: string;    // auto-filled from page context
  stablecoinName?: string;  // auto-filled from page context
  pageUrl: string;          // auto-filled: window.location.pathname
  pegValue?: string;        // auto-filled if available
  website?: string;         // honeypot — if present, silently drop
}
```

### Validation

- `type` must be one of the three valid values
- `description` required, 10–2000 chars
- `title` required for bug/feature-request, 3–100 chars
- `pageUrl` required, must start with `/`
- Reject if `website` (honeypot) is non-empty

### Rate limiting

D1 table: `feedback_rate_limit (ip_hash TEXT, submitted_at INTEGER)`

On each request:
1. Hash the request IP with a secret salt (SHA-256 via `crypto.subtle`)
2. Count rows with same `ip_hash` where `submitted_at > now - 600`
3. If count ≥ 3: return 429
4. Insert new row
5. Prune rows older than 1 hour (cleanup)

### Issue title format

Structured titles make the GitHub issues list scannable without opening each item:

- Bug Report: `[Bug] {user-provided title}`
- Data Correction: `[Data Correction] {stablecoinName}: {user description summary}`
- Feature Request (fallback Issue): `[Feature Request] {user-provided title}`

This replaces per-stablecoin labels. GitHub search on `[Data Correction] USDC` is equivalent to a label filter with zero pre-setup required.

### GitHub Issue body (bugs and data corrections)

```markdown
**Type:** Bug Report | Data Correction
**Stablecoin:** {name} ({id})           ← omitted if not applicable
**Page:** {pageUrl}
**Current value:** {pegValue}           ← omitted if not applicable
**Expected value:** {expectedValue}     ← data corrections only

**Description:**
{description}

---
*Submitted via Pharos feedback widget*
```

Labels applied automatically:
- `bug` for Bug Reports
- `data-correction` for Data Corrections

### GitHub Discussion body (feature requests)

Same body format as above. Category: "Ideas". Title: `[Feature Request] {user-provided title}`.

**Fallback**: if the GraphQL `createDiscussion` mutation fails (wrong node ID, scope issue, API error), the Worker falls back silently to creating a GitHub Issue with the `feature-request` label. The submission is never lost.

---

## Auto-Verification for Data Corrections

When `type === "data-correction"` and a `stablecoinId` is present, the Worker queries live data sources before creating the GitHub issue. This eliminates the primary manual triage step.

### What is fetched

Using existing Worker API clients (no new dependencies):
- DefiLlama: current price, circulating supply, 24h peg deviation
- CoinGecko (if DefiLlama price is absent): current price

### What is added to the issue body

```markdown
**--- Auto-Verification Snapshot (at time of submission) ---**
**DefiLlama price:** $1.0001
**DefiLlama circulating:** $5,432,100,000
**Peg deviation:** +0.01%
**Verification result:** ⚠️ Confirmed — price deviates >1% from peg
```

Possible verification outcomes:
- `✅ Unconfirmed` — APIs show values within normal range; likely user confusion or lag
- `⚠️ Confirmed` — APIs agree something looks anomalous
- `🔍 Pending` — verification APIs were unavailable at submission time (see below)

### Graceful degradation

If the DefiLlama or CoinGecko call fails (timeout, rate-limit, 5xx), the Worker:
1. Creates the GitHub issue anyway — submission is never blocked
2. Replaces the verification block with: `**Verification:** pending (APIs unavailable at submission time)`
3. Applies label `verified: pending` instead of `verified: confirmed` / `verified: unconfirmed`

The feedback is never lost due to a third-party API failure.

---

## D1 Schema Addition

```sql
CREATE TABLE feedback_rate_limit (
  ip_hash    TEXT    NOT NULL,
  submitted_at INTEGER NOT NULL
);

CREATE INDEX idx_feedback_rate_limit_ip ON feedback_rate_limit(ip_hash, submitted_at);
```

No persistent storage of feedback content in D1 — GitHub is the source of truth.

---

## Spam Prevention

| Layer | Mechanism |
|-------|-----------|
| Client | Honeypot hidden field |
| Worker | IP-based rate limit (3/10min per IP) |
| Worker | Input length limits |
| Worker | Type validation (no freeform type injection) |
| GitHub | PAT is write-only, scoped to this repo |

No CAPTCHA — the target audience (DeFi/analytics users) has high friction tolerance but low patience for CAPTCHAs.

---

## Out of Scope

- User authentication / login before submitting
- Public-facing feedback status page within Pharos
- Duplicate detection across submissions
- AI-assisted triage or labeling
- Feedback analytics dashboard
- Pagination or admin inbox in Pharos (GitHub is the triage UI)

These can be added later once volume and patterns are understood.

---

## Pre-Deploy Setup Checklist

One-time manual steps before the endpoint goes live:

1. **Create GitHub Discussion category** — go to repo → Discussions → Manage categories → add "Ideas"
2. **Fetch `GITHUB_REPO_NODE_ID`** — `gh api repos/{owner}/{repo} --jq .node_id`
3. **Fetch `GITHUB_DISCUSSION_CATEGORY_ID`** — `gh api graphql -f query='{ repository(owner:"{owner}",name:"{repo}") { discussionCategories(first:10) { nodes { id name } } } }'`
4. **Create GitHub labels** — `bug`, `data-correction`, `feature-request`, `verified: confirmed`, `verified: unconfirmed`, `verified: pending`
5. **Add Worker secrets** — `GITHUB_PAT`, `GITHUB_REPO_NODE_ID`, `GITHUB_DISCUSSION_CATEGORY_ID`, `FEEDBACK_IP_SALT`
