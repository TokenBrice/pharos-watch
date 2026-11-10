# Independent pre-push review of a slim-pass wave (read-only)

Your cwd is the integration worktree for the wave. You review the commits named by the orchestrator (`git show <sha> --stat`, `git show <sha> -- <path>`), each produced by an implementation lane whose report is in the scratch directory. Repo rules: `AGENTS.md`; `docs/testing.md` "Conventions", "Test-lane gate protocol", "Test evidence rules", "Anti-creep". Lane rules: MERGE moves cases intact into an existing file of the same Vitest project with compatible mocks; DELETE/TRIM only tautologies or duplicates; DEPIN replaces a curated literal with a derived invariant; CONVERT moves a text check into an existing guard (ESLint, `scripts/ci/check-*`, doc-sync); never remove the last PR-tier coverage of a protected class (fail-closed gates; R1–R8 in `docs/architecture.md` ADR-28..35; security/auth/origin; SQL safety; public API/persistence contracts; money/supply arithmetic; the only test of a production branch); no production-code change except removing an export used only by a deleted test.

Do not modify files. Verify by reading code, `git show` and read-only probes; if a suite cannot run in your sandbox, say so rather than assuming it passed.

Hunt for real defects only:

1. MERGE fidelity: for each deleted test file, every `it`/`test` title and assertion either reappears in the target (allowing `it.each` folding) or is an intended TRIM/DELETE whose survivor the report names — flag cases silently lost or assertions weakened while moving.
2. Moved cases that now pass vacuously or change meaning: a target's file-level `vi.mock`, fixtures, env or fake timers altering the moved case; missing `beforeEach` resets; derived DEPIN loops over sets that could be empty (no non-empty assertion); `it.skipIf` conditions that are always true.
3. Protected-class coverage lost: name the class, the deleted case, and why no survivor covers it.
4. Registry drift: grep the whole repo (`rg -n '<deleted-file-basename>' -g '!agents/**'`) for every deleted or renamed test path — `scripts/lib/critical-test-files.mts`, `scripts/lib/critical-coverage.mjs`, `scripts/lib/provider-resilience-registry.mjs`, `docs/doc-ownership.json` testOwnership, Vitest project and isolation registries, docs and skills. Historical append-only ledgers may keep old paths; flag them only when something validates them.
5. Vitest project placement: a merge whose project or environment changed (worker vs worker-shared vs node vs src/jsdom) in a way that breaks the moved cases; `worker-shared` files gaining module-level mutable state or env writes the selector misses.
6. CONVERT/guard edits: the new rule fails on a violation, runs at PR time for the files it governs, and does not weaken existing rules; no production edits beyond the allowed export removal.

For each finding: severity (blocker/major/minor), file:line, concrete failure scenario, suggested fix. No style nits. Say explicitly which areas you checked and found fine.

Return markdown ≤ 600 words: "Blockers", "Major", "Minor", "Checked and fine".
