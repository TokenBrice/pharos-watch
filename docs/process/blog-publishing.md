# Blog Publishing

How to publish a post to [/blog](https://pharos.watch/blog/). The blog is for
product and story updates — **not** a changelog (`/changelog/` owns release
notes; its publishing contract is [below](#changelog)). Keep posts editorial:
what shipped, what's next, and why.

## Architecture

- **Registry:** `src/data/blog/index.ts` — one `BlogPost` per post (the single
  source of truth). Guarded by `src/data/blog/__tests__/blog-registry.test.ts`.
- **Post bodies:** `src/data/blog/posts/<slug>.md` — Markdown, rendered by
  `src/app/blog/[slug]/page.tsx` (react-markdown, `remarkGfm` + `rehypeSlug` — no
  heading autolinks, unlike `/docs`).
- **Hub:** `src/app/blog/page.tsx` lists posts newest-first.
- **Feed:** `src/app/feed/blog.xml/route.ts` → `/feed/blog.xml` (the legacy
  extensionless `/feed/blog` path is a `_redirects` 301).
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
   - `title`, `description` (≤160 chars — meta + hub blurb + RSS), and
     `datePublished` (`YYYY-MM-DD`, the day it goes live). The post body lives at
     `src/data/blog/posts/<slug>.md`.
   - **Cover image (optional):** drop the file in `public/blog/` and set
     `coverImage: "/blog/<slug>-cover.png"` + `coverAlt`. Author it **1200×630**
     — it renders atop the post and the hub card in a `1200/630` frame and
     doubles as the post's social/OG card (falling back to the shared
     `og-blog.png` when absent). The registry test verifies the file exists.
3. **Test** the registry, feed, and sitemap:
   ```bash
   npx vitest run src/data/blog src/app/feed src/app/__tests__/sitemap-frozen.test.ts
   ```
4. **Commit** the post + registry.
   `src/data/blog/**` is wired into `GIT_DATE_SCAN_PATHS`
   (`generate-sitemap-dates.ts`), so the gitignored `sitemap-dates` projection
   picks the new post up automatically — locally on the next
   `npm run bootstrap:generated:history`, and in production during the release
   build. There is no separate settle step.
5. **Push** via the normal protected-main PR path. The homepage banner arms
   itself from `datePublished` on the next build — nothing else to touch.

## Notes

- **Social image:** a post with `coverImage` uses that asset for Open Graph and
  Twitter metadata as well as the article and hub card. A post without one
  falls back to the shared `public/og-blog.png` card with the "Blog" kicker.
  Cover images are authored assets; Pharos does not generate per-post cards.
- **llms.txt:** `public/llms.txt` currently omits the `/blog/` hub and
  `/feed/blog.xml`; adding them would require a change to
  `scripts/maintenance/generate-llms-txt.ts` first. Publishing never forces an
  llms.txt regeneration.
- **Discovery** is wired once and needs no per-post work: the sitemap, the
  sitemap-tree page, and the RSS feed enumerate posts straight from the
  registry; the nav `More` menu's `Updates` column, footer, command palette,
  and the feed `<link>` in `layout.tsx` are static links to the `/blog/` hub
  and `/feed/blog.xml`.

## Changelog

`/changelog/` is the other half of the boundary above: one entry per week,
linked from the nav `More` menu's `Updates` column (`src/lib/nav-config.ts`).
It shares nothing with the blog contract — separate registry, no post bodies,
no RSS feed.

- **Registry:** one file per week at `src/data/changelogs/<dateRange.to>.ts`
  exporting `entry`, imported into the `src/data/changelogs/index.ts` barrel,
  which re-sorts newest-first. Shape and per-field rules live in
  `src/data/changelogs/types.ts`; the guard is
  `src/data/changelogs/__tests__/index.test.ts`.
- **The filename is data.** It must equal `dateRange.to`, and every dated file
  must be registered in the barrel. Both dates must be `YYYY-MM-DD` — the
  barrel sort and the page's year dividers compare them lexicographically, so
  any other format sorts wrong rather than failing loudly.
- **The commit list is capped; the count is not.** `commits` holds at most the
  20 the card renders, while `stats.totalCommits` is the authoritative
  noise-filtered total for the window and may be larger. Git is the archive —
  do not re-expand the array to close the gap.
- **Entry copy limits:** `summary[].href` is an internal absolute path only
  (external URLs are rejected by the type and the test), and `fieldNotes` — the
  optional editor's note — is capped at 80 words.
- **Week anchors are public API.** Each entry renders with `id="week-<to>"`,
  and the page's `ItemList` JSON-LD publishes that same fragment as every
  week's `url` and `mainEntityOfPage`. Changing the id format breaks the
  structured data, not just inbound links.

## Publish a changelog week

1. **Add the entry file** and its barrel import.
2. **Refresh the Markdown twin.** `/changelog/` serves a generated `.md`
   variant, and its *whole index* is snapshot-tested against
   `scripts/__tests__/fixtures/markdown/changelog-index.md`. Every new week —
   and any copy or renderer change — fails that snapshot until you run
   `npm run refresh:markdown-fixtures` and commit the fixture in the same
   change.
3. **Test** the registry, page, Markdown export, and sitemap:
   ```bash
   npx vitest run src/data/changelogs src/app/changelog scripts/__tests__/generate-markdown-exports.test.ts src/app/__tests__/sitemap-frozen.test.ts
   ```
4. **Commit and push** as usual. Discovery needs no per-week work:
   `src/app/sitemap.ts` stamps `/changelog/` from the newest `dateRange.to`,
   floored by the route's Git edit date, and `public/llms.txt` links the hub
   only. A week is a fragment on one page, so nothing paginates as the registry
   grows.
