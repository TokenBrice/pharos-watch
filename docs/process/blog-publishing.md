# Blog Publishing

How to publish a post to [/blog](https://pharos.watch/blog/). The blog is for
product and story updates — **not** a changelog (`/changelog/` owns release
notes). Keep posts editorial: what shipped, what's next, and why.

## Architecture

- **Registry:** `src/data/blog/index.ts` — one `BlogPost` per post (the single
  source of truth). Guarded by `src/data/blog/__tests__/blog-registry.test.ts`.
- **Post bodies:** `src/data/blog/posts/<slug>.md` — Markdown, rendered by
  `src/app/blog/[slug]/page.tsx` (react-markdown, same plugin stack as `/docs`).
- **Hub:** `src/app/blog/page.tsx` lists posts newest-first.
- **Feed:** `src/app/feed/blog/route.ts` (+ `blog.xml` re-export) → `/feed/blog.xml`.
- **Homepage banner:** `src/components/home-blog-banner.tsx` advertises the
  latest post for `FRESH_DAYS` (14) after `datePublished`, gated at build time
  (zero client JS — the site's CSP forbids author inline scripts).
- **Typography:** article bodies use the Georgia `font-serif` editorial register
  (the authored-editorial carve-out in `DESIGN.md`; page chrome stays sans). No
  frost-blue anywhere in blog chrome (One Beam Rule).

## Publish a post

1. **Write the body** at `src/data/blog/posts/<slug>.md`.
   - **No H1** — the registry `title` renders as the page's single `<h1>`.
   - Internal links relative with a trailing slash (`/funding/`); external links
     absolute. External links open in a new tab automatically.
2. **Register it** — add a `BlogPost` at the **top** of `BLOG_POSTS` in
   `src/data/blog/index.ts`:
   - `slug`: kebab-case, no date prefix (URL is `/blog/<slug>/`).
   - `title`, `description` (≤160 chars — meta + hub blurb + RSS), `datePublished`
     (`YYYY-MM-DD`, the day it goes live), `source` (the `.md` filename).
3. **Test** the registry, feed, and sitemap:
   ```bash
   npx vitest run src/data/blog src/app/feed src/app/__tests__/sitemap-frozen.test.ts
   ```
4. **Commit** the post + registry (source first — the next step is git-derived).
5. **Regenerate** the git-derived last-modified dates, then commit the artifact:
   ```bash
   npx tsx scripts/maintenance/generate-sitemap-dates.ts
   npm run check:commit-derived-artifacts
   ```
   `src/data/blog/**` is wired into both `GIT_DATE_SCAN_PATHS`
   (`generate-sitemap-dates.ts`) and `SITEMAP_COMMIT_DERIVED_SOURCE_PATHS`
   (`scripts/lib/commit-derived-artifacts.mjs`), so this step is mandatory.
6. **Push** via the normal protected-main PR path. The homepage banner arms
   itself from `datePublished` on the next build — nothing else to touch.

## Notes

- **OG image:** all posts share `public/og-blog.png` (one card, "Blog" kicker).
  Per-post cards are intentionally not generated.
- **llms.txt (optional):** `scripts/maintenance/generate-llms-txt.ts` can list
  the `/blog/` hub and `/feed/blog.xml`; if you add them, regenerate and run
  `npm run check:llms-txt`. Keep it to the hub — do not add per-post entries, so
  publishing never forces an llms.txt regen.
- **Discovery** is wired once and needs no per-post work: nav Reference group,
  footer, command palette, sitemap, RSS `<link>` in `layout.tsx`, and the
  sitemap-tree page all pick posts up from the registry.
