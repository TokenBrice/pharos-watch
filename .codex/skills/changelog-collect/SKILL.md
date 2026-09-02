---
name: changelog-collect
description: Generate a weekly changelog entry from git history, filtering operational noise and producing editorial summary, field notes, statistics, and a bounded commit manifest. Stops for review unless commit was explicitly requested.
user_invocable: true
---

Read `docs/editorial-style.md`; its `release-note` register governs prose. Read [Blog Publishing §Changelog](../../../docs/process/blog-publishing.md#changelog) and [reference.md](reference.md) for the output context and editorial models.

# Changelog Collection

Accept optional ISO `from`/`to`, `--force` for an intentional overlap, and `--commit` only when the user authorized a commit. Otherwise derive `from` as the day after the newest entry’s `dateRange.to` and `to` as today. Refuse any range overlapping an existing entry unless forced.

## Collect And Curate

1. Collect newest-first, non-merge commits with eight-character hashes:

```bash
git log --no-merges --abbrev=8 --since="<from>" --until="<to> 23:59:59" --format="%h %s"
```

2. Remove generated-refresh, ratchet/baseline, dependency-bump, `[skip ci]`, documentation-cleanup, and revert-of-revert noise from both analysis and the manifest. Scan subject frequencies first so new dominant automation wording is not mistaken for product work. If more than half is filtered, warn the reviewer.
3. Cluster surviving work by story and user impact, normally 5–8 groups. Check stablecoin-count crossings, methodology versions, reserve/source additions, and security/auth milestones against their source files. A new external source also needs about-page coverage.
4. Write a ≤120-character factual headline; 45–80 words of interpretive `fieldNotes`; and a summary item per cluster with a 2–4 word noun label, allowed tag from `src/data/changelogs/types.ts`, ≤220-character description, and methodology `href` when applicable.
5. Set `stats.totalCommits` to the full filtered count. Store only the newest `min(totalCommits, 20)` filtered commits, unchanged and newest-first; git history remains the archive.

## Write And Verify

Create `src/data/changelogs/<to>.ts` as `ChangelogEntry`. Before writing, confirm range ordering/non-overlap, field-note length, summary tags/descriptions, headline length, commit hashes, manifest cap, source-backed numbers, and existing methodology routes.

Regenerate rather than hand-edit the barrel and refresh the Markdown fixture:

```bash
npm run prebuild -- --only=changelog-registry
npm run check:generated-artifacts -- --only=changelog-registry
npm run refresh:markdown-fixtures
npm run typecheck
npm test -- src/data/changelogs/
npm test -- scripts/__tests__/generate-markdown-exports.test.ts
```

Run `npm run check:stablecoin-data` only when citing registry counts. Default handoff reports the path, headline, field notes, labels/tags, total commits, filtered count, and warnings, then stops for review. If `--commit` was authorized and checks pass, commit only the entry, generated barrel, and refreshed fixture as one changelog change; use `pharos-release-runner` for publication.
