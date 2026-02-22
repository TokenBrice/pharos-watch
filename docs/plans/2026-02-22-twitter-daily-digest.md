# Twitter Daily Digest Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** After the daily digest cron generates and stores the AI editorial text, automatically post it to the Pharos Twitter account with cashtags for any mentioned stablecoins.

**Architecture:** A new `worker/src/lib/twitter.ts` module handles OAuth 1.0a signing (using `crypto.subtle`, no external deps) and tweet construction. `generateDailyDigest` receives optional Twitter credentials and calls `postDigestTweet` after storing the digest. Failures are caught and logged — they never abort the digest.

**Tech Stack:** Cloudflare Workers, Twitter API v2 (`POST /2/tweets`), OAuth 1.0a HMAC-SHA1 via `crypto.subtle`.

---

### Task 1: Add Twitter env bindings to `index.ts`

**Files:**
- Modify: `worker/src/index.ts`

**Step 1: Add four optional fields to the `Env` interface**

Find the `interface Env` block (lines 15-28) and add after `CMC_API_KEY`:

```typescript
  TWITTER_API_KEY?: string;
  TWITTER_API_SECRET?: string;
  TWITTER_ACCESS_TOKEN?: string;
  TWITTER_ACCESS_TOKEN_SECRET?: string;
```

**Step 2: Pass credentials to `generateDailyDigest` in the `0 8 * * *` cron case**

Replace (lines 147-149):
```typescript
ctx.waitUntil(logCronRun(db, "daily-digest", () =>
  generateDailyDigest(db, env.ANTHROPIC_API_KEY ?? null)
));
```

With:
```typescript
ctx.waitUntil(logCronRun(db, "daily-digest", () => {
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
}));
```

**Step 3: Type-check**

```bash
cd worker && npx tsc --noEmit
```

Expected: errors about `generateDailyDigest` not accepting a third argument (will be fixed in Task 3). All other errors should be zero.

**Step 4: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat(twitter): add Twitter env bindings to Worker"
```

---

### Task 2: Create `worker/src/lib/twitter.ts`

**Files:**
- Create: `worker/src/lib/twitter.ts`

**Step 1: Write the file**

```typescript
import { TRACKED_STABLECOINS } from "../../../src/lib/stablecoins";

export interface TwitterCreds {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

/** RFC 3986 percent-encode (stricter than encodeURIComponent for OAuth). */
function encode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Build and return an OAuth 1.0a Authorization header for a given request.
 * Uses crypto.subtle (available in Cloudflare Workers) for HMAC-SHA1.
 */
async function buildOAuthHeader(
  method: string,
  url: string,
  creds: TwitterCreds,
): Promise<string> {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };

  // Signature base string: sorted, encoded key=value pairs
  const paramString = Object.keys(oauthParams)
    .sort()
    .map((k) => `${encode(k)}=${encode(oauthParams[k])}`)
    .join("&");

  const baseString = [method.toUpperCase(), encode(url), encode(paramString)].join("&");
  const signingKey = `${encode(creds.apiSecret)}&${encode(creds.accessTokenSecret)}`;

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sigBytes = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(baseString),
  );
  oauthParams.oauth_signature = btoa(
    String.fromCharCode(...new Uint8Array(sigBytes)),
  );

  return (
    "OAuth " +
    Object.keys(oauthParams)
      .sort()
      .map((k) => `${encode(k)}="${encode(oauthParams[k])}"`)
      .join(", ")
  );
}

/** Extract tracked stablecoin symbols mentioned in text, in order of appearance. */
export function extractCashtags(text: string): string[] {
  const symbols = [...new Set(TRACKED_STABLECOINS.map((s) => s.symbol))];
  const found: { sym: string; pos: number }[] = [];

  for (const sym of symbols) {
    // Whole-word, case-insensitive match
    const match = text.match(new RegExp(`\\b${sym}\\b`, "i"));
    if (match?.index != null) {
      found.push({ sym, pos: match.index });
    }
  }

  // Sort by position so cashtags appear in mention order
  return found.sort((a, b) => a.pos - b.pos).map((f) => f.sym);
}

/** Build final tweet text: digest + cashtags if it fits in 280 chars. */
export function buildTweetText(digestText: string): string {
  const MAX = 280;
  const tags = extractCashtags(digestText);
  if (tags.length === 0) return digestText;

  const withTags = `${digestText}\n\n${tags.map((s) => `$${s}`).join(" ")}`;
  return withTags.length <= MAX ? withTags : digestText;
}

/** Post a single tweet using OAuth 1.0a. Throws on API error. */
async function postTweet(text: string, creds: TwitterCreds): Promise<void> {
  const url = "https://api.twitter.com/2/tweets";
  const authHeader = await buildOAuthHeader("POST", url, creds);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Twitter API ${res.status}: ${body.slice(0, 300)}`);
  }
}

/**
 * Build tweet text from digest and post it.
 * The caller is responsible for catching errors.
 */
export async function postDigestTweet(
  digestText: string,
  creds: TwitterCreds,
): Promise<void> {
  const tweetText = buildTweetText(digestText);
  await postTweet(tweetText, creds);
  console.log(`[twitter] Posted digest tweet (${tweetText.length} chars)`);
}
```

**Step 2: Type-check**

```bash
cd worker && npx tsc --noEmit
```

Expected: no errors in `twitter.ts` itself. The `index.ts` error from Task 1 remains until Task 3.

**Step 3: Commit**

```bash
git add worker/src/lib/twitter.ts
git commit -m "feat(twitter): add OAuth 1.0a signing and tweet construction"
```

---

### Task 3: Wire `postDigestTweet` into `daily-digest.ts`

**Files:**
- Modify: `worker/src/cron/daily-digest.ts`

**Step 1: Add the import at the top of the file**

After the existing imports, add:

```typescript
import { postDigestTweet, type TwitterCreds } from "../lib/twitter";
```

**Step 2: Update `generateDailyDigest` signature**

Change:
```typescript
export async function generateDailyDigest(
  db: D1Database,
  anthropicApiKey: string | null,
): Promise<CronResult> {
```

To:
```typescript
export async function generateDailyDigest(
  db: D1Database,
  anthropicApiKey: string | null,
  twitterCreds: TwitterCreds | null = null,
): Promise<CronResult> {
```

**Step 3: Add the tweet call after the D1 insert**

Find the line:
```typescript
console.log(`[daily-digest] Generated and stored digest (${digestText.length} chars)`);
```

Insert immediately before it:
```typescript
  // Post to Twitter if credentials are available
  if (twitterCreds) {
    try {
      await postDigestTweet(digestText, twitterCreds);
    } catch (err) {
      console.error("[daily-digest] Failed to post tweet (non-fatal):", err);
    }
  }
```

**Step 4: Type-check — all errors should now be zero**

```bash
cd worker && npx tsc --noEmit
```

Expected: clean exit.

**Step 5: Commit**

```bash
git add worker/src/cron/daily-digest.ts
git commit -m "feat(twitter): post daily digest to Twitter after generation"
```

---

### Task 4: Final verification and deploy

**Step 1: Full frontend build (ensures no regressions)**

```bash
npm run build
```

Expected: clean exit, 156 static pages generated.

**Step 2: Verify Worker type-check once more**

```bash
cd worker && npx tsc --noEmit
```

Expected: clean.

**Step 3: Push to deploy**

```bash
git push
```

Cloudflare Pages deploys the frontend automatically. The Worker is deployed separately — confirm via `wrangler deploy` or your existing deploy pipeline.

**Step 4: Smoke-test**

To verify end-to-end without waiting for 8 AM UTC, you can temporarily trigger the digest cron manually via the Cloudflare dashboard (Workers → your worker → Triggers → Cron → run now), then check the Worker logs for:

```
[daily-digest] Generated and stored digest (N chars)
[twitter] Posted digest tweet (N chars)
```

If Twitter credentials are wrong the log will show:
```
[daily-digest] Failed to post tweet (non-fatal): Twitter API 401: ...
```
