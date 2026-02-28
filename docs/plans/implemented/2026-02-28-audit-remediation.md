# Audit Remediation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all verified issues from the 2026-02-28 institutional-grade audit, excluding cookie consent and i18n.

**Architecture:** Changes span three layers: (1) Worker security headers and CORS hardening, (2) Cloudflare Pages CSP/headers tightening, (3) Frontend config improvements and CI pipeline hardening. All changes are backward-compatible with no data model changes except one new D1 migration for an `onchain_supply` index.

**Tech Stack:** Cloudflare Workers, Cloudflare Pages `_headers`, Next.js config, GitHub Actions, npm

---

## Audit False Positives (verified, no action needed)

These were flagged in the audit but confirmed NOT to be issues:

- **Missing DB indexes** — `depeg_events(stablecoin_id)`, `depeg_events(started_at)`, `supply_history(snapshot_date)`, `dex_liquidity_history(stablecoin_id, snapshot_date)`, `cron_runs(job, started_at)` all exist in migrations 0006, 0008, 0010, 0014, 0015.
- **Admin auth on /api/status** — `requireAdmin()` is called at `status.ts:60` and checked at line 61. Auth IS enforced.
- **Alt text on images** — All 8 `alt=""` instances are correctly decorative (logos paired with text labels). No screen reader information is lost.
- **Homepage heading hierarchy** — `HomepageClient` uses `<h2>` for section titles ("Key Stablecoin Data", "Stablecoin Distribution"). Since this is SSG, headings are in the static HTML.
- **Missing SearchAction in JSON-LD** — Already present in `layout.tsx:123-127`.

---

## Task 1: Harden Worker API Security Headers

The Worker only sets `X-Content-Type-Options: nosniff` on API responses. The frontend (`public/_headers`) has full security headers but the API subdomain (`api.pharos.watch`) is missing HSTS, Referrer-Policy, and a restrictive CSP.

**Files:**
- Modify: `worker/src/index.ts:41-49`

**Step 1: Update corsHeaders function**

Replace the `corsHeaders` function (lines 41-49) with:

```typescript
function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
    "Access-Control-Max-Age": "86400",
    "X-Content-Type-Options": "nosniff",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  };
}
```

**Step 2: Verify worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: Clean pass (0 errors)

**Step 3: Commit**

```bash
git add worker/src/index.ts
git commit -m "fix(worker): add HSTS, Referrer-Policy, CSP to API responses"
```

---

## Task 2: Harden Frontend CSP and Permissions-Policy

The frontend CSP is missing `base-uri`, `form-action`, and explicit `object-src 'none'`. The Permissions-Policy only restricts 3 features. Also, the CSP allows `static.cloudflareinsights.com` (script) and `cloudflareinsights.com` (connect) but the Cloudflare Web Analytics script is not actually loaded — these should be removed to keep CSP tight.

**Files:**
- Modify: `public/_headers`

**Step 1: Update the `_headers` file**

Replace line 7 (the CSP line) with:

```
  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' https://www.googletagmanager.com; style-src 'self' 'unsafe-inline'; img-src 'self' https://coin-images.coingecko.com https://*.google-analytics.com data:; connect-src 'self' https://api.pharos.watch https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

Changes vs. current:
- Removed `https://static.cloudflareinsights.com` from script-src (not loaded)
- Removed `https://cloudflareinsights.com` from connect-src (not loaded)
- Added `object-src 'none'`
- Added `base-uri 'self'`
- Added `form-action 'self'`

Replace line 5 (Permissions-Policy) with:

```
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()
```

**Step 2: Verify build**

Run: `npm run build`
Expected: Clean build, 180 static pages

**Step 3: Commit**

```bash
git add public/_headers
git commit -m "fix(headers): tighten CSP (remove unused CF Analytics, add object/base/form directives) and expand Permissions-Policy"
```

---

## Task 3: Add Twitter Metadata

The Twitter card meta tags are missing `site` and `creator` attributes, reducing attribution when shared on X/Twitter.

**Files:**
- Modify: `src/app/layout.tsx:62-64`

**Step 1: Update twitter metadata**

Replace the twitter object (line 62-64):

```typescript
  twitter: {
    card: "summary_large_image",
  },
```

With:

```typescript
  twitter: {
    card: "summary_large_image",
    site: "@PharosWatch",
    creator: "@TokenBrice",
  },
```

**Step 2: Verify build**

Run: `npm run build`
Expected: Clean build

**Step 3: Commit**

```bash
git add src/app/layout.tsx
git commit -m "feat(seo): add twitter:site and twitter:creator meta tags"
```

---

## Task 4: Reconcile Privacy Policy (Cloudflare Analytics Reference)

The privacy policy mentions Cloudflare Web Analytics but the script is not loaded. Remove the reference to avoid user confusion.

**Files:**
- Modify: `src/app/privacy/page.tsx` (find and remove Cloudflare Web Analytics mentions)

**Step 1: Read the privacy page and remove CF Analytics references**

Read `src/app/privacy/page.tsx` and remove any paragraphs or list items mentioning Cloudflare Web Analytics / Cloudflare Insights. Keep the Google Analytics sections.

**Step 2: Verify build**

Run: `npm run build`
Expected: Clean build

**Step 3: Commit**

```bash
git add src/app/privacy/page.tsx
git commit -m "docs(privacy): remove Cloudflare Web Analytics reference (script not loaded)"
```

---

## Task 5: Add onchain_supply Index

The `onchain_supply` table has no index on `updated_at`. The `/api/status` endpoint runs `COUNT(DISTINCT stablecoin_id) ... WHERE updated_at < ?` and `GROUP BY stablecoin_id ... WHERE updated_at > ?` — both full table scans without this index.

**Files:**
- Create: `worker/migrations/0030_onchain_supply_index.sql`

**Step 1: Create migration**

```sql
CREATE INDEX IF NOT EXISTS idx_onchain_supply_updated
  ON onchain_supply(updated_at);
```

Note: Only an `updated_at` index is needed. The `(stablecoin_id, chain)` composite primary key already covers GROUP BY stablecoin_id queries.

**Step 2: Verify migration applies locally**

Run: `cd worker && npx wrangler d1 migrations apply stablecoin-db --local`
Expected: Migration 0030 applied

**Step 3: Commit**

```bash
git add worker/migrations/0030_onchain_supply_index.sql
git commit -m "perf(db): add index on onchain_supply.updated_at for status queries"
```

---

## Task 6: Improve Next.js Config

The Next.js config is minimal. Add `reactStrictMode` (catches accidental side effects) and `optimizePackageImports` (reduces bundle size for barrel-exported packages like recharts and lucide-react).

**Files:**
- Modify: `next.config.ts`

**Step 1: Update config**

Replace the full file with:

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  experimental: {
    optimizePackageImports: ["recharts", "lucide-react"],
  },
};

export default nextConfig;
```

**Step 2: Verify build**

Run: `npm run build`
Expected: Clean build. Watch for any new strict mode warnings in dev (`npm run dev`).

**Step 3: Commit**

```bash
git add next.config.ts
git commit -m "perf(next): enable reactStrictMode and optimizePackageImports for recharts/lucide"
```

---

## Task 7: Add Linting to CI and engines Field

ESLint is not run in CI — code quality is not enforced on push. Also missing an `engines` field to lock the Node version range.

**Files:**
- Modify: `.github/workflows/deploy-cloudflare.yml`
- Modify: `package.json`

**Step 1: Add engines field to package.json**

Add after the `"private": true,` line:

```json
  "engines": {
    "node": ">=20.0.0"
  },
```

**Step 2: Add lint step to deploy-pages job**

In `.github/workflows/deploy-cloudflare.yml`, add a lint step after `npm ci` (after line 43) and before the digest sync:

```yaml
      - run: npm run lint
```

Also add worker lint step after worker type-check (after line 20):

```yaml
      - run: cd worker && npx tsc --noEmit
      # (new line below)
      - run: npx eslint src/
```

Wait — the eslint config is in the frontend. The worker has no eslint config. So just add frontend lint.

The deploy-pages job should look like:

```yaml
  deploy-pages:
    needs: deploy-worker
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npx tsx scripts/sync-digests.ts
      - run: npm run build
        env:
          NEXT_PUBLIC_API_BASE: ${{ vars.API_BASE_URL }}
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: pages deploy out --project-name=stablecoin-dashboard --commit-dirty=true --commit-message="${{ github.sha }}"
```

**Step 3: Verify lint passes locally**

Run: `npm run lint`
Expected: No errors (warnings OK)

**Step 4: Commit**

```bash
git add package.json .github/workflows/deploy-cloudflare.yml
git commit -m "ci: add ESLint to deploy pipeline and engines field to package.json"
```

---

## Task 8: Clean Dependency Issues

Two maintenance items: (1) dev dependency vulnerabilities fixable via `npm audit fix`, and (2) extraneous React packages accidentally installed in the worker directory.

**Files:**
- Run commands only (no file edits)

**Step 1: Fix frontend vulnerabilities**

Run: `npm audit fix`
Expected: minimatch and ajv vulnerabilities resolved

**Step 2: Clean worker node_modules**

Run: `cd worker && rm -rf node_modules package-lock.json && npm install`
Verify: `cd worker && npm ls --depth=0` should show only wrangler, @cloudflare/workers-types, typescript

**Step 3: Verify both builds**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: Both pass

**Step 4: Commit**

```bash
git add package-lock.json worker/package-lock.json
git commit -m "chore(deps): fix audit vulnerabilities and clean extraneous worker packages"
```

---

## Task 9: Set Up Test Framework (Vitest)

Zero test files exist across 250 TypeScript files. This is the largest gap for institutional readiness. Set up Vitest and write initial tests for the most critical calculation logic.

**Files:**
- Create: `vitest.config.ts`
- Create: `src/lib/__tests__/classification.test.ts`
- Create: `src/lib/__tests__/supply.test.ts`
- Create: `src/lib/__tests__/formatters.test.ts`
- Modify: `package.json` (add vitest devDep + test script)

**Step 1: Install Vitest**

Run: `npm install --save-dev vitest`

**Step 2: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
```

**Step 3: Add test script to package.json**

Add to the `"scripts"` section:

```json
"test": "vitest run",
"test:watch": "vitest"
```

**Step 4: Write initial test files**

Write tests for the most safety-critical modules:

1. `src/lib/__tests__/classification.test.ts` — Test peg type classification, label resolution, color mapping
2. `src/lib/__tests__/supply.test.ts` — Test `getCirculatingRaw()`, `getCirculatingUSD()`, edge cases (null, zero, negative)
3. `src/lib/__tests__/formatters.test.ts` — Test number formatting, currency formatting, percentage formatting

Read each source file first to understand the API, then write 5-10 focused assertions per file.

**Step 5: Run tests**

Run: `npm test`
Expected: All tests pass

**Step 6: Add test step to CI**

In `.github/workflows/deploy-cloudflare.yml`, add after the lint step in deploy-pages:

```yaml
      - run: npm test
```

**Step 7: Commit**

```bash
git add vitest.config.ts src/lib/__tests__/ package.json package-lock.json .github/workflows/deploy-cloudflare.yml
git commit -m "test: set up Vitest with initial tests for classification, supply, and formatters"
```

---

## Summary

| Task | Severity | Effort | Scope |
|------|----------|--------|-------|
| 1. Worker API security headers | Critical | 5 min | worker/src/index.ts |
| 2. Frontend CSP + Permissions-Policy | High | 5 min | public/_headers |
| 3. Twitter metadata | Low | 2 min | src/app/layout.tsx |
| 4. Privacy policy CF Analytics cleanup | Low | 5 min | src/app/privacy/page.tsx |
| 5. onchain_supply index | High | 5 min | worker/migrations/ |
| 6. Next.js config improvements | Medium | 5 min | next.config.ts |
| 7. CI linting + engines field | Medium | 10 min | CI workflow + package.json |
| 8. Dependency cleanup | High | 10 min | package-lock.json + worker/ |
| 9. Test framework setup | High | 1-2 hr | New files + package.json + CI |

**Total estimated effort:** ~2-3 hours

**Verification after all tasks:** Run `npm run build && npm test && cd worker && npx tsc --noEmit` to confirm everything is clean.
