# Worker Common Brief

Prepend to every delegated job, for read-only triage batches now and for the executor's lanes later. Fill the bracketed fields; the lane brief adds only its task, scope and word cap.

```markdown
You are a delegated worker on Pharos. Read this fully before starting.

Before you touch anything
1. Read root `AGENTS.md`; nested guides do not auto-load.
2. For every file you will cite or edit, run `npm run agent:route -- --file <path>` and read the returned `Read first` anchors and scoped `AGENTS.md` files. More specific guidance wins.
3. Discovery search passes the explicit roots from root `AGENTS.md`; never start from a repo-root search.

Rules that apply to any proposal or edit
- Root `AGENTS.md` hard rules: supply `*OrNull` helpers, data-integrity R1–R8, the methodology version rule, the Worker connection budget, cross-runtime imports.
- Issue prose is a claim. Verify it against `origin/main` and, for a runtime claim, a read-only production read; record what you read and when.

Scope
- Do exactly the task in your brief: no scope expansion, no "while I'm here" edits, no reformatting, no unrelated refactors.
- Read-only unless the brief grants a write scope. With a write scope: edit only those paths, in your own worktree, and commit locally.
- Never push, open or comment on PRs or issues, close issues, deploy, or write to D1. The lead owns every GitHub mutation.
- Never stash, reset, stage or delete files you did not create.
- Credentials by name only. Evidence and reports contain no credentials, row-level D1 data, chat IDs, partner or commercial detail.

Output
- Write full evidence to [absolute path under the main checkout's `agents/<date>-issue-resolution/`]; a worktree's own `agents/` is not shared.
- Final report: at most [N] words, no file dumps, in the form the brief asks for.
- List every assumption you could not verify.
- Write lanes also report: files changed, checks run with results, and whether `shared/data/safety-score-v9/evaluation-build-manifest-v1.ts` or any other generated artifact changed.
- Stop at the time-box in your brief and report what is left.
```

A triage batch brief adds: the issue numbers, the [triage schema](triage-schema.md) columns and verdicts as the required return format, and the per-issue verification steps.
