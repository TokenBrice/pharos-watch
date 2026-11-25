# Independent pre-push review of a slim-pass wave, and its fix lane

## Review (read-only)

Your cwd is the integration worktree for the wave. You review the commits named by the orchestrator (`git show <sha> --stat`, `git show <sha> -- <path>`), each produced by an implementation lane whose report is in the scratch directory. Rules the lanes worked under: `AGENTS.md`; `docs/testing.md` "Conventions", "Test-lane gate protocol", "Test evidence rules", "Anti-creep"; and the [rubric](rubric.md).

Do not modify files. Verify by reading code, `git show` and read-only probes; if a suite cannot run in your sandbox, say so rather than assuming it passed.

Hunt for real defects only:

1. MERGE fidelity: for each deleted test file, every `it`/`test` title and assertion either reappears in the target (allowing `it.each` folding) or is an intended TRIM/DELETE whose survivor the report names — flag cases silently lost.
2. Weakened assertions, in moved cases and in in-place TRIM/SPEEDUP/DEPIN diffs alike: `toEqual` narrowed to `toMatchObject` or a subset, distinct fixture values collapsed into one, a branch check dropped while its case title survives.
3. Moved cases that now pass vacuously or change meaning: a target's file-level `vi.mock`, fixtures, env or fake timers altering the moved case; missing `beforeEach` resets; derived DEPIN loops over sets that could be empty (no non-empty assertion); `it.skipIf` conditions that are always true.
4. Protected-class coverage lost: name the class, the deleted case, and why no survivor covers it.
5. Registry drift: search the whole repo (`rg -n '<deleted-file-basename>' -g '!agents/**'`) for every deleted, renamed or demoted test path and check each registry in `RETIREMENT_REGISTRIES`, plus docs and skills. Historical append-only ledgers may keep old paths; flag them only when something validates them.
6. Tier and project placement: a demotion without its header or PR-tier guard, or inside the safety net; a merge whose project or environment changed in a way that breaks the moved cases; `worker-shared` files gaining module-level mutable state or env writes the selector misses.
7. CONVERT/guard edits: the new rule fails on a violation, runs at PR time for the files it governs, and does not weaken existing rules; no production edits beyond the allowed export removal.

For each finding: severity (blocker/major/minor), file:line, concrete failure scenario, suggested fix. No style nits. Say explicitly which areas you checked and found fine.

Return markdown ≤ 600 words: "Blockers", "Major", "Minor", "Checked and fine".

## Fix Lane (write mode)

Fix exactly the reviewer items the orchestrator assigns, under the rubric's lane hygiene. Each fix closes the reviewer's concrete failure scenario with a regression case or row in the owning suite (no new test files unless the module itself is new), and updates the owning docs where behaviour or wording changes. Keep fail-closed semantics: when unsure, select or run more, never less.

Validate as an area lane does ([lane brief](lane-brief.md)), plus `npm run check:doc-sync` when docs changed.

Report (≤ 450 words): per item — fix, file:line, test added; commands with pass/fail; anything you could not fix and why.
