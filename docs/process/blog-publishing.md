# Blog Publishing

How to publish a post to [/blog](https://pharos.watch/blog/). The blog is for
product and story updates — **not** a changelog (`/changelog/` owns release
notes; its publishing contract is [below](#changelog)). Keep posts editorial:
what shipped, what's next, and why.

## Architecture

[`BLOG_POSTS` and `BlogPost`](../../src/data/blog/index.ts) own metadata; bodies live in `src/data/blog/posts/<slug>.md`. The registry drives the hub, feed and post metadata. Sitemap dates for post pages derive from the body and the shared renderer only, so a registry-only edit (title, description, cover) does not restamp the sitemap (`scripts/maintenance/generate-sitemap-dates.ts`). Publication dates are authored metadata, not Git modification times or claims of human review.

Post headers credit Pharos and link to `/about/#editorial-ai-policy`. Article bodies use the Georgia editorial register; page chrome stays sans and obeys the One Beam Rule in [DESIGN.md](../../DESIGN.md).

The hub's native cover images declare 1200×630 intrinsic dimensions, lazy loading and async decoding. This reserves their layout without generating eager image hints when another route discovers or prefetches the hub; article/social cover URLs stay unchanged.

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
     `og-blog.png` when absent). Review the cover file and alt text before publishing.
3. **Test** the feed and sitemap inventory:
   ```bash
   npx vitest run src/app/feed src/app/__tests__/sitemap-frozen.test.ts
   ```
4. **Commit** the post + registry.
   History-derived sitemap dates materialize through `npm run bootstrap:generated:history` locally and during release; there is no separate settle step.
5. **Push** via the normal protected-main PR path. Registry dates are metadata,
   not a publication embargo; deploy the entry when it should become public.

## Notes

Cover images are authored, reviewed assets; the optional cover contract is specified in [Publish a post](#publish-a-post). Publishing needs no per-post discovery wiring or forced llms.txt regeneration; change the owning generator if its inventory needs to change.

## Changelog

`/changelog/` is the other half of the boundary above: weekly release notes,
linked from the nav `Resources` menu's `Updates` column (`src/lib/nav-config.ts`).
It shares nothing with the blog contract — separate registry, no post bodies,
no RSS feed.

- **Registry:** one JSON record per entry at `src/data/changelogs/<dateRange.to>.json`,
  statically imported by the generated `src/data/changelogs/index.ts` barrel,
  which re-sorts newest-first. `WeeklyContentSchema` and its inferred TypeScript
  shapes share the runtime-neutral `shared/types/editorial-content.ts` authority;
  renderer imports are type-only. `npm run check:editorial-content` validates
  metadata, source registration and internal references before build.
- **The filename is data.** It must equal `dateRange.to`, and every dated file
  must be registered in the barrel. Both dates must be valid `YYYY-MM-DD` days:
  `shared/types/editorial-content.ts` rejects malformed or impossible dates;
  the barrel sorts lexicographically and the archive manifest groups those dates.
- **One entry per Monday–Sunday week.** `dateRange.from` is a Monday and
  `dateRange.to` the following Sunday (UTC, inclusive). The editorial-content
  check rejects any other span, and the registry test rejects overlapping
  weeks; publish a week only once it is complete (on its Sunday or later).
- **The commit list is capped; the count is not.** `commits` holds at most the
  20 the card renders, while `stats.totalCommits` is the authoritative
  noise-filtered total for the window and may be larger. Git is the archive —
  do not re-expand the array to close the gap.
- **Entry copy limits:** `summary[].href` is an internal absolute path only
  (external or unknown routes fail the editorial-content check), and `fieldNotes` —
  the optional editor's note — is capped at 80 words.
- **Week anchors are public API.** Each full entry retains `id="week-<to>"`
  and its date-only card ID. `/changelog/` keeps both IDs as compact links for
  older releases, while ItemList JSON-LD points to full archive evidence.
- **History is statically partitioned.** `src/lib/changelog-history.ts` derives
  the latest two weeks and complete `/changelog/archive/YYYY-MM/` documents
  from the generated registry. The landing renders only recent full cards,
  month links and older week titles. Month archives include recent weeks too,
  so an archive URL never moves when a newer week arrives. Every month is linked
  from the hub, indexed in the public route inventory/sitemap, and has its own
  canonical and generated Markdown twin. No closed month body ships on the hub.

## Publish a changelog week

1. **Add the JSON entry file** and regenerate its barrel with `node --import tsx scripts/maintenance/generate-changelog-registry.ts`; run `npm run check:editorial-content`.
2. **Refresh the Markdown twins.** The export generator writes the compact
   `/changelog/` index and each registered monthly archive. Focused Markdown
   tests assert archive links, canonical paths and body coverage; generated
   archive assets are written during the static export.
3. **Validate** the editorial content, Markdown export, and sitemap inventory:
   ```bash
   npm run check:editorial-content
   npx vitest run scripts/__tests__/generate-markdown-exports.test.ts src/app/__tests__/sitemap-frozen.test.ts
   ```
4. **Commit and push** as usual. Discovery needs no per-week work:
   `src/app/sitemap.ts` stamps `/changelog/` from the newest `dateRange.to`,
   floored by the route's Git edit date. `public/llms.txt` links the hub, which
   exposes all monthly archives. Registry growth adds roughly one route per
   month rather than one route per week.
