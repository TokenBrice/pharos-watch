---
title: "Audit frontend SEO and meta tags"
agent: "codex"
reasoning_effort: "high"
done: false
---

## Goal

Audit all frontend pages for SEO best practices and meta tag completeness. Produce `FINDINGS-SEO.md` in the worktree root.

## Task

### Scope

All 27 pages in `src/app/`, the root layout (`src/app/layout.tsx`), metadata helpers (`src/lib/page-metadata.ts`), and public assets. Also attempt live probes against `https://pharos.watch`.

### What to check

1. **Page metadata** (check `src/lib/page-metadata.ts` and each page's `generateMetadata` or `metadata` export):
   - Every page exports metadata or uses `generateMetadata`
   - Every page has a unique, descriptive `<title>` (not just "Pharos" or empty)
   - Every page has a `description` meta tag (not empty, not generic)
   - Dynamic pages (`[id]`, `[peg]`, `[date]`) generate meaningful titles/descriptions from params

2. **Open Graph tags**:
   - Every page has `og:title`, `og:description`, `og:image`
   - `og:image` points to an existing file in `public/` (check that the referenced OG image file exists)
   - `og:url` uses canonical URL format
   - `og:type` is set (default "website" is fine for most pages)

3. **Twitter card tags**:
   - `twitter:card` is set (should be "summary_large_image" for pages with OG images)
   - `twitter:title`, `twitter:description` are present

4. **Canonical URLs**:
   - Pages with multiple URL patterns (e.g., filters, query params) should have `<link rel="canonical">`
   - No duplicate content issues between similar routes

5. **Structured data (JSON-LD)**:
   - Check if any pages include structured data (`<script type="application/ld+json">`)
   - At minimum, the homepage should have Organization or WebSite schema
   - Stablecoin detail pages could benefit from FinancialProduct or similar schema (report as Low if missing)

6. **Sitemap**:
   - Check if `public/sitemap.xml` exists or if there's a dynamic sitemap generator (`src/app/sitemap.ts`)
   - If a sitemap exists, verify it lists all public pages
   - Check that dynamic routes (stablecoin detail pages) are included

7. **robots.txt**:
   - Check if `public/robots.txt` exists or if there's a dynamic one (`src/app/robots.ts`)
   - Verify it allows crawling of public pages and blocks admin/API routes appropriately

8. **Semantic HTML**:
   - Pages use semantic elements (`<main>`, `<article>`, `<section>`, `<nav>`, `<header>`, `<footer>`)
   - Content is structured with proper heading hierarchy (also covered in accessibility audit — just note obvious SEO-relevant gaps here)

9. **Live probes** (attempt these, but findings are valid even without them):
   ```bash
   curl -s https://pharos.watch | grep -i '<title'
   curl -s https://pharos.watch | grep -i 'og:'
   curl -s https://pharos.watch/stablecoin/usdt-tether | grep -i '<title'
   curl -s https://pharos.watch/sitemap.xml | head -20
   curl -s https://pharos.watch/robots.txt
   ```
   If curl is unavailable, note "Live probes not executed — orchestrator will run manually" and continue with code-level findings.

### Files to examine

- `src/app/layout.tsx`
- `src/app/**/page.tsx` (all 27 pages)
- `src/lib/page-metadata.ts`
- `src/app/sitemap.ts` (if exists)
- `src/app/robots.ts` (if exists)
- `public/sitemap.xml` (if exists)
- `public/robots.txt` (if exists)
- `public/og-*.png` (verify OG images exist)

### Output format

Write `FINDINGS-SEO.md` in the worktree root:

```markdown
# FINDINGS: SEO & Meta

## Summary
- X pages examined
- Y findings (A critical, B high, C medium, D low)
- Live probes: executed / not executed

#### Critical
(findings or "None")

#### High
(findings)

#### Medium
(findings)

#### Low
(findings)

## Live Probe Results
(curl output or "Not executed — orchestrator will run manually")

## Files Examined
(list)
```

Each finding:
```
- [SEO-NNN] **Title** — Description. File: `path:line` or URL. What's missing/wrong. `[~effort]`
```

## Acceptance Criteria

- `FINDINGS-SEO.md` exists in the worktree root
- File contains all four severity sections
- Every finding has a `[SEO-NNN]` ID, reference, and effort tag
- Live probe section exists (either with results or with "not executed" note)
- Summary counts match actual findings
