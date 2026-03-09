# Retrospective: Codebase Quality Audit (2026-03-09)

## Stats
- Research runs: 8 total, 3 first-pass success (R1/R2/R6), 5 needed model upgrade (R3/R4/R5/R7/R8 hit gpt-5.3-codex context limit → re-run with gpt-5.1-codex-max)
- Implementation tickets: 13 total, 10 first-pass success, 3 needed orchestrator fixes
- Models used: gpt-5.3-codex (7 tickets), gpt-5.1-codex-max (4 tickets + 5 research re-runs), gpt-5.3-codex-spark (1 ticket, 1 failed research attempt)
- Phases: 3 (Phase 0: research, Phase A: safe cleanup + security, Phase B: data integrity + design polish)
- Tests: 1378 → 1386 (+8 added by agents)
- LOC impact: -408 net (Phase A: -508, Phase B: +100)
- Findings triaged: ~90 across 8 dimensions, ~55 addressed, ~35 deferred

## What worked
- **8-way parallel research was highly effective** — all 8 research dimensions ran in parallel worktrees. Wall-clock time for the entire research phase was ~15 min (one agent's runtime), not 8× sequential. Output quality was high: each report had concrete file paths, line numbers, and severity ratings.
- **Synthesis phase caught cross-report duplication** — 3 findings appeared in multiple reports (e.g., font-mono missing flagged by both R3-UI/UX and R6-Design System). Dedup during synthesis prevented duplicate tickets.
- **Two-stage review (spec then quality) caught real issues** — TICKET-001 spec review found 3 additional JSON-LD files needing `safeJsonLd`. TICKET-006 spec review found `.env.example` was gitignored. TICKET-011 spec review found 2 missed N/A instances. These would have shipped broken without the review stage.
- **Merge-smallest-first strategy minimized conflicts** — merging 6 Phase B branches smallest-to-largest resulted in only 1 conflict (hero-card.tsx, between TICKET-009 nullable guards and TICKET-011 em-dash convention). 12 of 13 total merges were clean.
- **Orchestrator direct-fix for trivial issues** — 3 orchestrator fixes (2 missed em-dash instances in TICKET-011, 1 hero-card.tsx merge resolution) saved 3 full cmcs round-trips. Good use of the "trivial one-liner" exception in the workflow.
- **Phase gating caught test regressions early** — running `npm run build && cd worker && npx tsc --noEmit && npm test` after each phase merge provided confidence before proceeding. Test count went up (1378 → 1386), confirming new tests were added, not just existing ones passing.

## What didn't
- **5/8 research runs failed on gpt-5.3-codex** — context window limit hit when the codebase was too large for that model. Required re-running on gpt-5.1-codex-max. Lost ~20 min on the failed runs + re-dispatch. Should have started all research on gpt-5.1-codex-max from the beginning given the full-codebase scope.
- **TICKET-002 (fe-dead-code) hit max_output_tokens on gpt-5.3-codex-spark** — 33 files was too large for spark. All changes happened to be applied before the token limit hit, but this was luck. Should have used codex (not spark) for any ticket touching 10+ files.
- **cmcs changes not auto-committed in worktrees** — after cmcs runs completed, all changes were uncommitted (HEAD same as main). Required manual `git add -A && git commit` in each worktree. This is a cmcs behavior gap — agents apply changes but don't commit.
- **Context compaction during Phase B execution** — the orchestrator conversation hit context limits mid-Phase B, requiring a session restart. Lost some in-flight state. The PROGRESS.md file served as recovery point, but the re-orientation cost ~5 min.
- **hero-card.tsx merge conflict was predictable but not prevented** — TICKET-009 (nullable supply guards) and TICKET-011 (N/A→em-dash) both touched hero-card.tsx. This overlap was visible during ticket writing but not flagged. Should have either sequenced these tickets or documented the expected conflict.

## Lessons for next time
- **Use gpt-5.1-codex-max for all full-codebase research tickets** — gpt-5.3-codex's context window cannot hold the entire codebase. Don't try smaller models for research that needs to scan all of `src/` and `worker/`.
- **Never use spark for tickets touching 10+ files** — spark hits max_output_tokens. The threshold is roughly 15 files or 500 LOC of changes. Use codex for anything above that.
- **Pre-commit in worktrees after cmcs run** — add `git add -A && git commit -m "cmcs: apply ticket changes"` as a post-run step. Don't rely on cmcs to commit.
- **Flag file-scope overlaps between parallel tickets explicitly** — during ticket writing, cross-reference `## Files Modified` sections. If two tickets touch the same file, either: (a) sequence them in the same worktree, or (b) document the expected merge conflict in PROGRESS.md so the orchestrator is prepared.
- **Keep PROGRESS.md updated in real-time** — it was the single most valuable artifact for session recovery after context compaction. The incident log was especially useful for understanding what had already been fixed.
- **Research → synthesis → implementation is a strong pattern for audits** — the 3-phase structure (parallel research → dedup/prioritize → phased implementation) scaled well. 8 research dimensions covered the codebase thoroughly without overlap in implementation. Would use this pattern again for future audits.
- **Batch spec reviews in parallel** — dispatching all 6 spec reviewers in parallel (one per ticket) saved significant wall-clock time vs sequential review. Same for code quality reviews. The two-stage gate still catches issues because fix tickets re-enter the review loop.
