# Review-fix lane (write mode)

Your cwd is a worktree of the slim pass's integration branch. Independent reviewers found defects; their reports are in the scratch directory. Fix exactly the items listed in your lane brief — each fix must close the reviewer's concrete failure scenario, with a regression case or row in the owning suite (no new test files unless the module itself is new).

Keep fail-closed semantics: when unsure, select or run more, never less. Rules: read `AGENTS.md`; route touched files with `npm run agent:route -- --file <path>`; smallest change; no unrelated refactors; update the owning docs where behaviour or wording changes; `git diff --check` clean. Do not commit, push or create branches/worktrees; do not touch `agents/`.

Validate: every touched suite (`npx vitest run …`), the typechecks the touched packages need, `npx eslint <changed files>`, plus the lane-specific checks (`npm run check:critical-coverage-completeness`, `npm run check:unused-code`, `npm run check:doc-sync` when docs changed).

Report (≤ 450 words): per item — fix, file:line, test added; commands with pass/fail; anything you could not fix and why.
