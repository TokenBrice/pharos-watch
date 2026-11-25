---
name: changelog-collect
description: Generate the weekly changelog entry from git history and stop for review unless a commit was requested. Use for the weekly /changelog update. Not for methodology changelogs or releases.
---

Read `docs/editorial-style.md`; its `release-note` register governs prose. Read [Blog Publishing §Changelog](../../../docs/process/blog-publishing.md#changelog) for where the entry lands and [reference.md](reference.md) for the editorial models.

# Changelog Collection

Every entry covers exactly one ISO week: `from` is a Monday, `to` is the following Sunday (`from + 6` days), both inclusive UTC calendar days. Never write a partial, multi-week, or off-weekday range, and never derive `to` as “today” on a non-Sunday; `check:editorial-content` rejects anything else. Methodology changelogs belong to their methodology owners, and publishing belongs to `pharos-release-runner`.

Accept an optional ISO `week` (any date inside the target week) and `--commit` only when the user authorized a commit. Without `week`, target the most recently completed Monday–Sunday week. A week closes at Sunday 23:59:59 UTC: when asked to write the current week earlier on its Sunday, write it, flag the entry as provisional in the handoff, and name the cut-off time. If the target week already has an entry, revise that file instead of creating a second one. If one or more complete weeks lie between the newest entry and the target, report the gap and write one entry per missing week.

Before writing a new week, re-collect the previous entry's week. If its filtered count or newest-20 manifest changed (commits landed after it was written), refresh that entry first: `stats.totalCommits`, `commits[]`, and the summary when a missed commit changes the story.

## Collect And Curate

1. Treat `from` and `to` as inclusive UTC calendar days (derive today in UTC too). Collect newest-first, non-merge commits with eight-character hashes:

```bash
git log --no-merges --abbrev=8 --since="<from> 00:00:00 +0000" --until="<to> 23:59:59 +0000" --format="%h %s"
```

2. Remove operational noise from both analysis and the manifest using the include/exclude table in reference.md. Scan subject frequencies first so new dominant automation wording is not mistaken for product work. If more than half is filtered, warn the reviewer.
3. Cluster surviving work by story and user impact, normally 6–9 groups: one summary item per methodology lane whose version moved, labelled `<Lane> <version>`, plus the product, coverage, infrastructure and design stories. Check stablecoin-count crossings, methodology versions, reserve/source additions, and security/auth milestones against their source files. A new external source also needs about-page coverage.
4. Write a ≤120-character factual headline; 45–80 words of interpretive `fieldNotes`; and a summary item per cluster with a 2–4 word noun label, allowed tag from `shared/types/editorial-content.ts`, ≤220-character description, and, when one applies, an internal route `href` from `PUBLIC_ROUTE_PATHS`: the methodology changelog or the owning public page.
5. Set `stats.totalCommits` to the full filtered count. Store only the newest `min(totalCommits, 20)` filtered commits, unchanged and newest-first; git history remains the archive.

## Write And Verify

Create `src/data/changelogs/<to>.json` with the `ChangelogEntry` shape. Before writing, confirm the Monday–Sunday range, non-overlap with neighbouring entries, field-note length, summary tags/descriptions, headline length, commit hashes, manifest cap, source-backed numbers, and that every `href` is an existing public route.

Regenerate rather than hand-edit the barrel, then run the editorial, renderer and sitemap checks:

```bash
node --import tsx scripts/maintenance/generate-changelog-registry.ts
npm run check:generated-artifacts -- --only=changelog-registry
npm run check:editorial-content
npm run typecheck
npm test -- scripts/__tests__/generate-changelog-registry.test.ts
npm test -- scripts/__tests__/generate-markdown-exports.test.ts
npm test -- src/app/__tests__/sitemap-frozen.test.ts
```

Run `npm run check:stablecoin-data` only when citing registry counts. Default handoff reports the path, headline, field notes, labels/tags, total commits, filtered count, any refreshed previous entry, and warnings (including a provisional cut-off), then stops for review. If `--commit` was authorized and checks pass, commit only the entry (and a refreshed previous entry) as one changelog change; the barrel is an untracked bootstrap projection, and the fixed Markdown examples do not change for a new authored week. Use `pharos-release-runner` for publication.
