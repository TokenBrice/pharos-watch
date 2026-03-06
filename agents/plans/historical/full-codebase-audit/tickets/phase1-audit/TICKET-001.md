---
title: "Audit documentation accuracy against codebase"
agent: "codex"
reasoning_effort: "high"
done: false
---

## Goal

Audit all documentation files for accuracy against the current codebase. Produce `FINDINGS-DOCS.md` in the worktree root.

## Task

### Scope

All files in `docs/` (75+ markdown files) and `CLAUDE.md`. Check each document against the code it describes.

### What to check

1. **File paths**: Every file path mentioned in docs — verify it exists. Check `docs/architecture.md` file tree against actual `src/`, `worker/`, `shared/` structure.

2. **Counts and numbers**: Any numeric claim ("148 stablecoins", "21 cron jobs", "27 pages", etc.) — verify by counting the actual items.

3. **API endpoints**: Every endpoint listed in `docs/api-reference.md` — verify it exists in `worker/src/router.ts`. Check for endpoints in the router that are NOT documented.

4. **Function/type references**: Any function, type, or constant named in docs — verify it exists in the referenced file.

5. **Configuration values**: Cron schedules in `docs/worker-infrastructure.md` — verify against `worker/wrangler.toml` or `worker/src/lib/cron-schedule.ts`. Thresholds and constants in methodology docs — verify against source.

6. **CLAUDE.md Topic References**: Each entry in the "Topic References" section — verify the doc file exists and the description is accurate.

7. **Cross-references between docs**: Links from one doc to another — verify the target exists.

8. **Prior audit**: Read `docs/documentation-audit-report-2026-03-05.md`. Check whether its findings were addressed. Report any that remain unfixed.

9. **Missing documentation**: Scan for features/modules that have NO corresponding doc. Check:
   - Every cron job in `worker/src/cron/` has a doc or doc section
   - Every major API endpoint group has documentation
   - Every scoring algorithm has methodology documentation
   - Process docs in `docs/process/` cover the workflows mentioned in CLAUDE.md

### Files to examine

- `docs/*.md` (all ~35 topic docs)
- `docs/plans/**/*.md` (plan docs — check for stale references)
- `docs/process/*.md`, `docs/runbooks/*.md`, `docs/research/*.md`
- `CLAUDE.md`
- Cross-reference against: `worker/src/router.ts`, `worker/src/cron/*.ts`, `src/app/**/page.tsx`, `shared/lib/*.ts`

### Output format

Write `FINDINGS-DOCS.md` in the worktree root using this exact structure:

```markdown
# FINDINGS: Documentation

## Summary
- X files examined
- Y findings (A critical, B high, C medium, D low)

#### Critical
(findings or "None")

#### High
(findings)

#### Medium
(findings)

#### Low
(findings)

## Files Examined
(list of all files checked)
```

Each finding format:
```
- [DOC-NNN] **Title** — Description. File: `path/to/doc.md`. Referenced code: `path/to/source.ts`. What's wrong and what the fix should be. `[~effort]`
```

Effort tags: `[~30m]`, `[~1h]`, `[~2h]`, `[~4h]`, `[~1d]`, `[~2-3d]`, `[~1w]`

## Acceptance Criteria

- `FINDINGS-DOCS.md` exists in the worktree root
- File contains all four severity sections (Critical, High, Medium, Low)
- Every finding has a `[DOC-NNN]` ID, a file reference, and an effort tag
- Summary counts match the actual number of findings listed
