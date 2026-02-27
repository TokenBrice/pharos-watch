# Feedback Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an in-app feedback collection pipeline to Pharos: floating button + inline triggers open a modal, submissions POST to a new Worker endpoint that validates, rate-limits, auto-verifies data corrections against D1 cache, and routes to GitHub Issues (bugs/data corrections) or GitHub Discussions (feature requests).

**Architecture:** Static Next.js frontend sends `POST /api/feedback` to the Cloudflare Worker; the Worker validates input, enforces IP-based rate limiting via a new D1 table, runs auto-verification for data corrections using the existing `stablecoins` D1 cache, then creates a GitHub Issue (via REST) or Discussion (via GraphQL, with Issue fallback) using a PAT stored as a Worker secret.

**Tech Stack:** Cloudflare Worker (TypeScript), D1 (SQLite), GitHub REST + GraphQL APIs, Next.js 16, React 19, shadcn/ui Dialog, Tailwind CSS v4, lucide-react.

---

## Pre-flight: GitHub one-time setup

Do this before writing any code. You need three values that will become Worker secrets.

**Step 1: Enable Discussions on the repo**
Go to `https://github.com/TokenBrice/stablecoin-dashboard` → Settings → Features → check "Discussions". Then go to the Discussions tab → click the gear icon → add a category named **"Ideas"** (type: Open-ended discussion).

**Step 2: Fetch the repo node ID**
```bash
gh api repos/TokenBrice/stablecoin-dashboard --jq .node_id
```
Save this value — it becomes `GITHUB_REPO_NODE_ID`.

**Step 3: Fetch the Ideas category node ID**
```bash
gh api graphql -f query='{ repository(owner:"TokenBrice",name:"stablecoin-dashboard") { discussionCategories(first:10) { nodes { id name } } } }'
```
Find the `id` for the "Ideas" entry — it becomes `GITHUB_DISCUSSION_CATEGORY_ID`.

**Step 4: Create a GitHub PAT**
Go to GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token.
Scopes needed: `repo` (full) — this covers `write:discussion` implicitly for a repo you own.
Save this value — it becomes `GITHUB_PAT`.

**Step 5: Create the labels**
```bash
gh label create "data-correction" --color "0075ca" --description "User-reported data issue" -R TokenBrice/stablecoin-dashboard
gh label create "feature-request" --color "a2eeef" --description "User feature suggestion" -R TokenBrice/stablecoin-dashboard
gh label create "verified: confirmed" --color "d93f0b" --description "Auto-verification: issue confirmed against live data" -R TokenBrice/stablecoin-dashboard
gh label create "verified: unconfirmed" --color "e4e669" --description "Auto-verification: data looks normal, possibly user confusion" -R TokenBrice/stablecoin-dashboard
gh label create "verified: pending" --color "cccccc" --description "Auto-verification: APIs were unavailable at submission time" -R TokenBrice/stablecoin-dashboard
```
(The `bug` label already exists by default on GitHub repos.)

---

## Task 1: D1 migration — feedback_rate_limit table

**Files:**
- Create: `worker/migrations/0029_feedback_rate_limit.sql`

**Step 1: Create the migration file**

```sql
-- Rate limiting for /api/feedback endpoint
-- Stores hashed IPs with timestamps; pruned hourly by the feedback handler.
CREATE TABLE IF NOT EXISTS feedback_rate_limit (
  ip_hash      TEXT    NOT NULL,
  submitted_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_rate_limit_ip
  ON feedback_rate_limit(ip_hash, submitted_at);
```

**Step 2: Apply to remote D1**
```bash
cd worker
npx wrangler d1 execute stablecoin-db --remote --file=migrations/0029_feedback_rate_limit.sql
```
Expected output: `✅ Executed 2 commands`

**Step 3: Commit**
```bash
git add worker/migrations/0029_feedback_rate_limit.sql
git commit -m "feat(db): add feedback_rate_limit migration"
```

---

## Task 2: Worker — feedback.ts handler

**Files:**
- Create: `worker/src/api/feedback.ts`

This file contains all logic: validation, rate limiting, auto-verification, GitHub routing.

**Step 1: Create the file**

```typescript
// worker/src/api/feedback.ts

import { getCache } from "../lib/db";

// ── Types ──────────────────────────────────────────────────────────────────

interface FeedbackBody {
  type: "bug" | "data-correction" | "feature-request";
  title?: string;
  description: string;
  expectedValue?: string;
  stablecoinId?: string;
  stablecoinName?: string;
  pageUrl: string;
  pegValue?: string;
  website?: string; // honeypot
}

export interface FeedbackEnv {
  GITHUB_PAT?: string;
  GITHUB_REPO_NODE_ID?: string;
  GITHUB_DISCUSSION_CATEGORY_ID?: string;
  FEEDBACK_IP_SALT?: string;
}

const GITHUB_OWNER = "TokenBrice";
const GITHUB_REPO = "stablecoin-dashboard";

// ── Rate limiting ─────────────────────────────────────────────────────────

async function checkRateLimit(
  db: D1Database,
  ip: string,
  salt: string
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const data = encoder.encode(ip + salt);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const ipHash = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);

  const row = await db
    .prepare("SELECT COUNT(*) as cnt FROM feedback_rate_limit WHERE ip_hash = ? AND submitted_at > ?")
    .bind(ipHash, now - 600)
    .first<{ cnt: number }>();

  if ((row?.cnt ?? 0) >= 3) return false;

  await db
    .prepare("INSERT INTO feedback_rate_limit (ip_hash, submitted_at) VALUES (?, ?)")
    .bind(ipHash, now)
    .run();

  // Prune rows older than 1 hour (non-blocking, best-effort)
  db.prepare("DELETE FROM feedback_rate_limit WHERE submitted_at < ?")
    .bind(now - 3600)
    .run()
    .catch(() => {});

  return true;
}

// ── Auto-verification ─────────────────────────────────────────────────────

interface VerificationResult {
  block: string;
  verifiedLabel: "verified: confirmed" | "verified: unconfirmed" | "verified: pending";
}

async function verifyDataCorrection(
  db: D1Database,
  stablecoinId: string
): Promise<VerificationResult> {
  try {
    const cached = await getCache(db, "stablecoins");
    if (!cached) throw new Error("stablecoins cache empty");

    const parsed = JSON.parse(cached.value) as {
      peggedAssets?: Array<{ id: string; price?: number | null; circulating?: Record<string, number> }>;
    };
    const assets = parsed.peggedAssets ?? [];
    const coin = assets.find((a) => a.id === stablecoinId);

    if (!coin) throw new Error(`coin ${stablecoinId} not found in cache`);

    const price = coin.price ?? null;
    const totalUSD = coin.circulating
      ? Object.values(coin.circulating).reduce((s, v) => s + (v ?? 0), 0)
      : 0;

    const cacheAgeSec = Math.floor(Date.now() / 1000) - cached.updatedAt;
    const pegRef = 1.0; // USD peg; sufficient for anomaly detection

    let deviationStr = "N/A";
    let verifiedLabel: VerificationResult["verifiedLabel"] = "verified: unconfirmed";

    if (price != null && price > 0) {
      const dev = ((price - pegRef) / pegRef) * 100;
      deviationStr = `${dev >= 0 ? "+" : ""}${dev.toFixed(3)}%`;
      if (Math.abs(dev) > 1) verifiedLabel = "verified: confirmed";
    }

    const mcapStr =
      totalUSD > 1e9
        ? `$${(totalUSD / 1e9).toFixed(2)}B`
        : totalUSD > 1e6
          ? `$${(totalUSD / 1e6).toFixed(0)}M`
          : `$${totalUSD.toFixed(0)}`;

    const resultEmoji =
      verifiedLabel === "verified: confirmed"
        ? "⚠️ Confirmed"
        : "✅ Unconfirmed";

    const block = [
      "**--- Auto-Verification Snapshot (at time of submission) ---**",
      price != null ? `**Cached price:** $${price.toFixed(6)}` : "**Cached price:** N/A",
      totalUSD > 0 ? `**Circulating supply:** ${mcapStr}` : "",
      `**Peg deviation:** ${deviationStr}`,
      `**Cache age:** ${cacheAgeSec}s`,
      `**Verification result:** ${resultEmoji}`,
    ]
      .filter(Boolean)
      .join("\n");

    return { block, verifiedLabel };
  } catch (err) {
    console.warn("[feedback] Auto-verification failed:", err);
    return {
      block: "**Verification:** pending (cache unavailable at submission time)",
      verifiedLabel: "verified: pending",
    };
  }
}

// ── GitHub helpers ────────────────────────────────────────────────────────

const GH_HEADERS = (pat: string) => ({
  Authorization: `Bearer ${pat}`,
  "Content-Type": "application/json",
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "pharos-feedback-widget/1.0",
});

async function createGitHubIssue(
  pat: string,
  title: string,
  body: string,
  labels: string[]
): Promise<void> {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues`,
    {
      method: "POST",
      headers: GH_HEADERS(pat),
      body: JSON.stringify({ title, body, labels }),
      signal: AbortSignal.timeout(10_000),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub Issues API ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function createGitHubDiscussion(
  pat: string,
  repositoryId: string,
  categoryId: string,
  title: string,
  body: string
): Promise<boolean> {
  const mutation = `
    mutation CreateDiscussion($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
      createDiscussion(input: {
        repositoryId: $repositoryId,
        categoryId: $categoryId,
        title: $title,
        body: $body
      }) {
        discussion { id }
      }
    }
  `;
  try {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: GH_HEADERS(pat),
      body: JSON.stringify({
        query: mutation,
        variables: { repositoryId, categoryId, title, body },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { errors?: unknown[] };
    if (data.errors?.length) {
      console.warn("[feedback] GraphQL errors:", JSON.stringify(data.errors));
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[feedback] GraphQL Discussion creation failed:", err);
    return false;
  }
}

// ── Issue body formatting ─────────────────────────────────────────────────

function formatBody(fb: FeedbackBody, verificationBlock?: string): string {
  const lines: string[] = [];

  lines.push(
    `**Type:** ${fb.type === "bug" ? "Bug Report" : fb.type === "data-correction" ? "Data Correction" : "Feature Request"}`
  );

  if (fb.stablecoinName || fb.stablecoinId) {
    const name = fb.stablecoinName ?? "";
    const id = fb.stablecoinId ? ` (${fb.stablecoinId})` : "";
    lines.push(`**Stablecoin:** ${name}${id}`);
  }

  lines.push(`**Page:** ${fb.pageUrl}`);

  if (fb.pegValue) lines.push(`**Current value:** ${fb.pegValue}`);
  if (fb.expectedValue) lines.push(`**Expected value / source:** ${fb.expectedValue}`);

  lines.push("", "**Description:**", fb.description);

  if (verificationBlock) lines.push("", verificationBlock);

  lines.push("", "---", "*Submitted via Pharos feedback widget*");

  return lines.join("\n");
}

// ── Main handler ──────────────────────────────────────────────────────────

export async function handleFeedback(
  db: D1Database,
  request: Request,
  env: FeedbackEnv
): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  // Parse JSON body
  let fb: FeedbackBody;
  try {
    fb = (await request.json()) as FeedbackBody;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  // Honeypot: silently accept but do nothing
  if (fb.website) return json({ ok: true });

  // Validate type
  if (!["bug", "data-correction", "feature-request"].includes(fb.type)) {
    return json({ error: "Invalid feedback type" }, 400);
  }

  // Validate description
  const desc = fb.description?.trim() ?? "";
  if (desc.length < 10 || desc.length > 2000) {
    return json({ error: "Description must be 10–2000 characters" }, 400);
  }

  // Validate title (required for bug + feature-request)
  if (fb.type === "bug" || fb.type === "feature-request") {
    const title = fb.title?.trim() ?? "";
    if (title.length < 3 || title.length > 100) {
      return json({ error: "Title must be 3–100 characters" }, 400);
    }
  }

  // Validate pageUrl
  if (!fb.pageUrl?.startsWith("/")) {
    return json({ error: "Invalid pageUrl" }, 400);
  }

  // Rate limiting
  const ip =
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For") ??
    "unknown";
  const salt = env.FEEDBACK_IP_SALT ?? "pharos-default-salt";
  const allowed = await checkRateLimit(db, ip, salt);
  if (!allowed) {
    return json({ error: "Too many submissions. Please wait a few minutes." }, 429);
  }

  // Require PAT
  const pat = env.GITHUB_PAT;
  if (!pat) {
    console.error("[feedback] GITHUB_PAT secret not configured");
    return json({ error: "Feedback service temporarily unavailable" }, 503);
  }

  try {
    if (fb.type === "feature-request") {
      const title = `[Feature Request] ${fb.title!.trim()}`;
      const body = formatBody(fb);

      const repoNodeId = env.GITHUB_REPO_NODE_ID;
      const categoryId = env.GITHUB_DISCUSSION_CATEGORY_ID;

      let created = false;
      if (repoNodeId && categoryId) {
        created = await createGitHubDiscussion(pat, repoNodeId, categoryId, title, body);
      }
      // Fallback: create Issue if Discussion creation failed or env vars not set
      if (!created) {
        await createGitHubIssue(pat, title, body, ["feature-request"]);
      }
    } else {
      // Bug or Data Correction
      let verificationBlock: string | undefined;
      let verifiedLabel: string = "verified: pending";

      if (fb.type === "data-correction" && fb.stablecoinId) {
        const result = await verifyDataCorrection(db, fb.stablecoinId);
        verificationBlock = result.block;
        verifiedLabel = result.verifiedLabel;
      }

      const stablecoinPart = fb.stablecoinName ? `${fb.stablecoinName}: ` : "";
      const shortDesc = fb.description.trim().slice(0, 60);
      const ellipsis = fb.description.trim().length > 60 ? "…" : "";

      const title =
        fb.type === "bug"
          ? `[Bug] ${fb.title!.trim()}`
          : `[Data Correction] ${stablecoinPart}${shortDesc}${ellipsis}`;

      const labels =
        fb.type === "bug" ? ["bug"] : ["data-correction", verifiedLabel];

      const body = formatBody(fb, verificationBlock);
      await createGitHubIssue(pat, title, body, labels);
    }

    return json({ ok: true });
  } catch (err) {
    console.error("[feedback] GitHub API error:", err);
    return json({ error: "Failed to submit feedback. Please try again." }, 500);
  }
}
```

**Step 2: Type-check the worker**
```bash
cd worker && npx tsc --noEmit
```
Expected: no errors

**Step 3: Commit**
```bash
git add worker/src/api/feedback.ts
git commit -m "feat(worker): add feedback handler with rate limiting and auto-verification"
```

---

## Task 3: Wire feedback into Worker index.ts and router.ts

**Files:**
- Modify: `worker/src/index.ts`
- Modify: `worker/src/router.ts`

### 3a: Update the Env interface and CORS in index.ts

The Worker currently rejects all non-GET requests before routing. We need to allow POST specifically for `/api/feedback`, add the new env vars, and update CORS headers to include POST.

**Step 1: Add to the `Env` interface** (around line 22 in index.ts, after `COINGECKO_API_KEY`)

Find this block:
```typescript
  COINGECKO_API_KEY?: string;
  TWITTER_API_KEY?: string;
```

Add after `COINGECKO_API_KEY`:
```typescript
  GITHUB_PAT?: string;
  GITHUB_REPO_NODE_ID?: string;
  GITHUB_DISCUSSION_CATEGORY_ID?: string;
  FEEDBACK_IP_SALT?: string;
```

**Step 2: Add POST to CORS headers**

Find:
```typescript
    "Access-Control-Allow-Methods": "GET, OPTIONS",
```
Replace with:
```typescript
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
```

**Step 3: Add POST /api/feedback handler before the GET-only guard**

Find the block that rejects non-GET:
```typescript
    if (request.method !== "GET") {
      return addCorsHeaders(
        new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405,
          headers: { "Content-Type": "application/json" },
        }),
        origin
      );
    }
```

Insert BEFORE that block:
```typescript
    // POST /api/feedback — feedback submission (public, no cache)
    if (request.method === "POST" && url.pathname === "/api/feedback") {
      const { handleFeedback } = await import("./api/feedback");
      const feedbackEnv = {
        GITHUB_PAT: env.GITHUB_PAT,
        GITHUB_REPO_NODE_ID: env.GITHUB_REPO_NODE_ID,
        GITHUB_DISCUSSION_CATEGORY_ID: env.GITHUB_DISCUSSION_CATEGORY_ID,
        FEEDBACK_IP_SALT: env.FEEDBACK_IP_SALT,
      };
      return addCorsHeaders(
        await handleFeedback(env.DB, request, feedbackEnv),
        origin
      );
    }
```

### 3b: No router.ts change needed

The feedback endpoint is handled inline in index.ts before routing (like `trigger-digest`). The router only handles GET paths.

**Step 4: Type-check**
```bash
cd worker && npx tsc --noEmit
```
Expected: no errors

**Step 5: Commit**
```bash
git add worker/src/index.ts
git commit -m "feat(worker): wire POST /api/feedback into index.ts, add env vars and CORS"
```

---

## Task 4: Frontend — FeedbackModal component

**Files:**
- Create: `src/components/feedback-modal.tsx`

This is a "use client" Dialog with three tabs, context auto-fill, honeypot, and submission state management.

**Step 1: Create the component**

```tsx
// src/components/feedback-modal.tsx
"use client";

import { useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type FeedbackType = "bug" | "data-correction" | "feature-request";

export interface FeedbackModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-select a feedback type (e.g. "data-correction" from inline triggers) */
  defaultType?: FeedbackType;
  /** Pre-fill stablecoin context (from detail page or table row) */
  stablecoinId?: string;
  stablecoinName?: string;
  pegValue?: string;
}

const TYPE_LABELS: Record<FeedbackType, string> = {
  bug: "Bug Report",
  "data-correction": "Data Correction",
  "feature-request": "Feature Request",
};

const DESCRIPTION_HINTS: Record<FeedbackType, string> = {
  bug: "Describe what happened and what you expected instead.",
  "data-correction":
    "e.g. USDC shows $0.00 price since yesterday. CoinGecko shows $1.0001.",
  "feature-request": "Describe the feature and why it would be useful.",
};

export function FeedbackModal({
  open,
  onOpenChange,
  defaultType = "bug",
  stablecoinId,
  stablecoinName,
  pegValue,
}: FeedbackModalProps) {
  const [type, setType] = useState<FeedbackType>(defaultType);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [expectedValue, setExpectedValue] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const reset = useCallback(() => {
    setType(defaultType);
    setTitle("");
    setDescription("");
    setExpectedValue("");
    setStatus("idle");
    setErrorMsg("");
  }, [defaultType]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) reset();
      onOpenChange(next);
    },
    [onOpenChange, reset]
  );

  const handleSubmit = useCallback(async () => {
    setStatus("loading");
    setErrorMsg("");

    const pageUrl = typeof window !== "undefined" ? window.location.pathname : "/";

    const body = {
      type,
      ...(title.trim() ? { title: title.trim() } : {}),
      description: description.trim(),
      ...(expectedValue.trim() ? { expectedValue: expectedValue.trim() } : {}),
      ...(stablecoinId ? { stablecoinId } : {}),
      ...(stablecoinName ? { stablecoinName } : {}),
      ...(pegValue ? { pegValue } : {}),
      pageUrl,
      website: "", // honeypot — always empty from legit submissions
    };

    try {
      const res = await fetch("https://api.pharos.watch/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setErrorMsg(data.error ?? "Something went wrong. Please try again.");
        setStatus("error");
      } else {
        setStatus("success");
      }
    } catch {
      setErrorMsg("Network error. Please try again.");
      setStatus("error");
    }
  }, [type, title, description, expectedValue, stablecoinId, stablecoinName, pegValue]);

  const needsTitle = type === "bug" || type === "feature-request";
  const isValid =
    description.trim().length >= 10 &&
    description.trim().length <= 2000 &&
    (!needsTitle || (title.trim().length >= 3 && title.trim().length <= 100));

  const pageUrl = typeof window !== "undefined" ? window.location.pathname : "";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Send Feedback</DialogTitle>
        </DialogHeader>

        {status === "success" ? (
          <div className="py-8 text-center space-y-2">
            <p className="text-lg font-medium">Thanks — submitted!</p>
            <p className="text-sm text-muted-foreground">
              We review all submissions and prioritize data corrections.
            </p>
            <Button variant="outline" className="mt-4" onClick={() => handleOpenChange(false)}>
              Close
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Type selector */}
            <div className="flex gap-1 rounded-lg bg-muted p-1">
              {(["bug", "data-correction", "feature-request"] as FeedbackType[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setType(t)}
                  className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                    type === t
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {TYPE_LABELS[t]}
                </button>
              ))}
            </div>

            {/* Context banner */}
            {(stablecoinName || pageUrl) && (
              <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground space-y-0.5">
                {stablecoinName && <div><span className="font-medium">Stablecoin:</span> {stablecoinName}</div>}
                {pegValue && <div><span className="font-medium">Current value:</span> {pegValue}</div>}
                <div><span className="font-medium">Page:</span> {pageUrl}</div>
              </div>
            )}

            {/* Title field (bug + feature-request) */}
            {needsTitle && (
              <div className="space-y-1.5">
                <Label htmlFor="fb-title">Title</Label>
                <Input
                  id="fb-title"
                  placeholder={type === "bug" ? "e.g. Sidebar breaks on mobile" : "e.g. Add EUR peg heatmap"}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={100}
                  disabled={status === "loading"}
                />
              </div>
            )}

            {/* Description */}
            <div className="space-y-1.5">
              <Label htmlFor="fb-desc">
                {type === "data-correction" ? "What is wrong?" : "Description"}
              </Label>
              <Textarea
                id="fb-desc"
                placeholder={DESCRIPTION_HINTS[type]}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                maxLength={2000}
                disabled={status === "loading"}
                className="resize-none"
              />
              <p className="text-xs text-muted-foreground text-right">
                {description.length}/2000
              </p>
            </div>

            {/* Expected value (data-correction only) */}
            {type === "data-correction" && (
              <div className="space-y-1.5">
                <Label htmlFor="fb-expected">Expected value / source <span className="text-muted-foreground">(optional)</span></Label>
                <Input
                  id="fb-expected"
                  placeholder="e.g. CoinGecko shows $1.0001"
                  value={expectedValue}
                  onChange={(e) => setExpectedValue(e.target.value)}
                  maxLength={200}
                  disabled={status === "loading"}
                />
              </div>
            )}

            {/* Honeypot (hidden from real users) */}
            <input
              type="text"
              name="website"
              tabIndex={-1}
              aria-hidden="true"
              style={{ position: "absolute", left: "-9999px", opacity: 0, pointerEvents: "none" }}
              readOnly
              value=""
            />

            {/* Error */}
            {status === "error" && errorMsg && (
              <p className="text-sm text-destructive">{errorMsg}</p>
            )}

            {/* Submit */}
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={status === "loading"}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={!isValid || status === "loading"}
              >
                {status === "loading" ? "Submitting…" : "Submit"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

**Step 2: Check that shadcn Textarea and Input exist** (they should, but verify)
```bash
ls src/components/ui/ | grep -E "textarea|input|dialog|label"
```
If any are missing, add them:
```bash
npx shadcn@latest add textarea input dialog label
```

**Step 3: Build check**
```bash
npm run build 2>&1 | tail -20
```
Expected: no errors related to feedback-modal.tsx

**Step 4: Commit**
```bash
git add src/components/feedback-modal.tsx
git commit -m "feat(frontend): add FeedbackModal component"
```

---

## Task 5: Frontend — FeedbackButton (floating)

**Files:**
- Create: `src/components/feedback-button.tsx`

**Step 1: Create the component**

```tsx
// src/components/feedback-button.tsx
"use client";

import { useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { FeedbackModal } from "@/components/feedback-modal";

export function FeedbackButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Send feedback"
        className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-lg transition-all hover:bg-primary/90 hover:shadow-xl active:scale-95"
      >
        <MessageSquarePlus className="h-4 w-4 shrink-0" />
        <span>Feedback</span>
      </button>
      <FeedbackModal open={open} onOpenChange={setOpen} />
    </>
  );
}
```

**Step 2: Build check**
```bash
npm run build 2>&1 | tail -10
```

**Step 3: Commit**
```bash
git add src/components/feedback-button.tsx
git commit -m "feat(frontend): add floating FeedbackButton component"
```

---

## Task 6: Wire FeedbackButton into the root layout

**Files:**
- Modify: `src/app/layout.tsx`

**Step 1: Add import** (near the top of layout.tsx with other component imports)
```typescript
import { FeedbackButton } from "@/components/feedback-button";
```

**Step 2: Add component** inside the `<Providers>` block, after `<ScrollToTop />`

Find:
```tsx
          <ScrollToTop />
        </Providers>
```

Replace with:
```tsx
          <ScrollToTop />
          <FeedbackButton />
        </Providers>
```

**Step 3: Build check**
```bash
npm run build 2>&1 | tail -10
```
Expected: clean build

**Step 4: Commit**
```bash
git add src/app/layout.tsx
git commit -m "feat(frontend): add FeedbackButton to root layout"
```

---

## Task 7: Inline trigger on stablecoin detail page

**Files:**
- Modify: `src/app/stablecoin/[id]/client.tsx`

The goal is a small "Report data issue" link/button that appears near the peg/price section, opening the FeedbackModal pre-set to "data-correction" with the coin's context.

**Step 1: Add imports to client.tsx**

Find the import block at the top. Add:
```typescript
import { useState } from "react";
import { Flag } from "lucide-react";
import { FeedbackModal } from "@/components/feedback-modal";
```

Note: `useState` may already be imported — if so, don't duplicate it.

**Step 2: Add modal state** inside the `StablecoinDetailClient` component function, near the other `useState` calls at the top of the component:
```typescript
const [feedbackOpen, setFeedbackOpen] = useState(false);
```

**Step 3: Add the trigger and modal** near the peg gauge section

In the JSX, find the price/peg section — it's around the `<PegGauge .../>` usage (around line 225–240). After the peg gauge block, add:
```tsx
                  <button
                    onClick={() => setFeedbackOpen(true)}
                    className="mt-2 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Flag className="h-3 w-3" />
                    Report data issue
                  </button>
```

**Step 4: Add the modal** just before the closing of the component's JSX return (before the final `</>`):
```tsx
      <FeedbackModal
        open={feedbackOpen}
        onOpenChange={setFeedbackOpen}
        defaultType="data-correction"
        stablecoinId={coin.id}
        stablecoinName={coin.name}
        pegValue={coinData.price != null ? `$${coinData.price.toFixed(6)}` : undefined}
      />
```

**Step 5: Build check**
```bash
npm run build 2>&1 | tail -10
```

**Step 6: Commit**
```bash
git add src/app/stablecoin/[id]/client.tsx
git commit -m "feat(frontend): add inline data correction trigger on stablecoin detail page"
```

---

## Task 8: Inline trigger on main table rows

**Files:**
- Modify: `src/components/stablecoin-table.tsx`

Add a small flag icon that appears on row hover, opening FeedbackModal pre-set to data-correction for that row's coin.

**Step 1: Add imports to stablecoin-table.tsx**
```typescript
import { useState } from "react";
import { Flag } from "lucide-react";
import { FeedbackModal } from "@/components/feedback-modal";
```

Note: `useState` may already be imported.

**Step 2: Add state** inside the `StablecoinTable` component (alongside other state):
```typescript
const [feedbackCoin, setFeedbackCoin] = useState<{ id: string; name: string } | null>(null);
```

**Step 3: Add the modal** at the bottom of the `StablecoinTable` return, before the last closing tag:
```tsx
      {feedbackCoin && (
        <FeedbackModal
          open={!!feedbackCoin}
          onOpenChange={(open) => { if (!open) setFeedbackCoin(null); }}
          defaultType="data-correction"
          stablecoinId={feedbackCoin.id}
          stablecoinName={feedbackCoin.name}
        />
      )}
```

**Step 4: Add flag icon to table rows**

Find where table row cells are rendered. Look for the `<TableRow` or `<tr` that iterates over sorted coins. You need to add a flag icon in one of the last columns. Find the row render (look for `coin.id` or `row.id` in the row JSX).

Add a new cell at the end of each row (before `</TableRow>`):
```tsx
                <TableCell className="w-8 p-1 text-center">
                  <button
                    onClick={(e) => { e.stopPropagation(); setFeedbackCoin({ id: coin.id, name: coin.name }); }}
                    className="opacity-0 group-hover:opacity-100 rounded p-1 text-muted-foreground hover:text-foreground transition-all"
                    aria-label={`Report data issue for ${coin.name}`}
                    title="Report data issue"
                  >
                    <Flag className="h-3 w-3" />
                  </button>
                </TableCell>
```

Also add `group` class to the `<TableRow>` element (if not already present):
```tsx
<TableRow className="group ...existing-classes...">
```

And add a corresponding empty header cell:
```tsx
<TableHead className="w-8" />
```

**Note:** The stablecoin-table.tsx is complex. Read its full JSX carefully to find the right insertion points for the header cell and data cell. The header cells are in a `<TableHeader>` row and the data cells are in the mapped `sorted.map((coin) => <TableRow>` block. Add the empty `<TableHead className="w-8" />` at the end of the header row, and the flag `<TableCell>` at the end of each data row.

**Step 5: Build check**
```bash
npm run build 2>&1 | tail -10
```

**Step 6: Commit**
```bash
git add src/components/stablecoin-table.tsx
git commit -m "feat(frontend): add per-row data correction trigger on main table"
```

---

## Task 9: Add Worker secrets

**Step 1: Add the four secrets**
```bash
cd worker
npx wrangler secret put GITHUB_PAT
# paste the PAT when prompted

npx wrangler secret put GITHUB_REPO_NODE_ID
# paste the repo node ID from Pre-flight Step 2

npx wrangler secret put GITHUB_DISCUSSION_CATEGORY_ID
# paste the category node ID from Pre-flight Step 3

npx wrangler secret put FEEDBACK_IP_SALT
# type any random string, e.g.: pharos-feedback-$(openssl rand -hex 16)
```

**Step 2: Verify secrets are registered**
```bash
npx wrangler secret list
```
Expected: list includes `GITHUB_PAT`, `GITHUB_REPO_NODE_ID`, `GITHUB_DISCUSSION_CATEGORY_ID`, `FEEDBACK_IP_SALT`

---

## Task 10: Full build verification before deploy

**Step 1: Type-check the Worker**
```bash
cd worker && npx tsc --noEmit
```
Expected: 0 errors

**Step 2: Build the frontend**
```bash
cd .. && npm run build
```
Expected: clean build, no TypeScript errors, no missing module errors

**Step 3: Lint**
```bash
npm run lint
```
Expected: no errors (warnings OK)

---

## Task 11: Deploy Worker

**Step 1: Deploy**
```bash
cd worker && npx wrangler deploy
```
Expected output includes: `✅ Deployed stablecoin-api`

**Step 2: Smoke test the endpoint**
```bash
curl -X POST https://api.pharos.watch/api/feedback \
  -H "Content-Type: application/json" \
  -d '{"type":"bug","title":"Test","description":"This is a test submission from deploy verification.","pageUrl":"/"}' \
  -w "\nHTTP %{http_code}\n"
```
Expected: `{"ok":true}` with HTTP 200

Check GitHub: a new issue `[Bug] Test` should appear at `https://github.com/TokenBrice/stablecoin-dashboard/issues`

**Step 3: Test rate limiting**
Run the same curl 3 more times quickly.
Expected 4th attempt: HTTP 429 with `{"error":"Too many submissions..."}`

**Step 4: Test honeypot**
```bash
curl -X POST https://api.pharos.watch/api/feedback \
  -H "Content-Type: application/json" \
  -d '{"type":"bug","title":"Bot","description":"Automated test.","pageUrl":"/","website":"filled-by-bot"}' \
  -w "\nHTTP %{http_code}\n"
```
Expected: HTTP 200 with `{"ok":true}` — silently dropped, no GitHub issue created

---

## Task 12: Deploy frontend

**Step 1: Push to main (triggers Cloudflare Pages deploy)**
```bash
git push origin main
```

**Step 2: Monitor the deploy**
```bash
npx wrangler pages deployment list --project-name stablecoin-dashboard 2>/dev/null || \
  gh run list --limit 5
```
Wait for the deploy to complete (typically 1–3 minutes).

**Step 3: Verify the floating button appears**
Open `https://pharos.watch` in a browser or use agent-browser to take a screenshot.
Expected: "Feedback" pill button visible in the bottom-right corner.

**Step 4: Verify inline trigger on detail page**
Navigate to `https://pharos.watch/stablecoin/USDC` (or any valid coin ID).
Expected: "Report data issue" link visible near the peg/price section.

---

## Task 13: Production smoke test

**Step 1: Submit a real data correction from the live site**
Use agent-browser to:
1. Open `https://pharos.watch`
2. Click the "Feedback" button
3. Select "Data Correction" tab
4. Fill in a test description (≥ 10 chars)
5. Click Submit
6. Verify success message appears

**Step 2: Check GitHub**
```bash
gh issue list --repo TokenBrice/stablecoin-dashboard --limit 5 --label "data-correction"
```
Expected: the test issue appears with auto-verification snapshot in the body.

**Step 3: Test feature request → Discussion**
Submit a feature request from the site.
```bash
gh api repos/TokenBrice/stablecoin-dashboard/discussions --jq '.[0].title'
```
Expected: `[Feature Request] ...` appears in Discussions.

**Step 4: Close/delete the test issues and discussions** to keep the repo clean.

---

## Rollback plan

If the Worker deploy breaks existing endpoints:
```bash
cd worker && npx wrangler rollback
```

If the frontend deploy has issues, revert the layout.tsx commit and push:
```bash
git revert HEAD~1 --no-edit && git push origin main
```
