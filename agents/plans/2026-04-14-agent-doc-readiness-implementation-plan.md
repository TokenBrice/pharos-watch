# Agent Documentation Readiness Implementation Plan

Date: 2026-04-14

## Goal

Implement the highest-impact, low-overhead changes from the agent documentation readiness audit so future agents can discover the right Pharos docs, source files, and update obligations faster.

## Approved Scope

- Add `docs/agent-task-router.md` as an intent-to-context routing table.
- Add `scripts/generate-agent-code-map.mjs` and generated `docs/agent-code-map.md` as a lightweight repo entrypoint/export map.
- Add short nested agent instruction files in high-risk subtrees: `worker/`, `shared/`, `src/`, `functions/`, and `shared/data/stablecoins/`.
- Add `docs/doc-ownership.json` as an advisory source-glob to doc-update manifest.
- Update `docs/README.md`, `docs/scripts.md`, and `agents/README.md` for discoverability.

## Deferred

- `.devin/wiki.json`: useful only if Devin/DeepWiki becomes an active workflow.
- Repomix/Gitingest profiles: useful mainly for non-local agents or external review packs.
- CI integration for `doc-ownership.json`: defer until the manifest proves useful as advisory documentation.

## Review Loop

Review phase 1 found two Minor issues:

- Generated code map under `/agents/` would conflict with `/agents/` archival semantics.
- `docs/doc-ownership.json` needed a human-facing entrypoint or it would be easy to ignore.

Fixes applied to the plan:

- Place the generated map at `docs/agent-code-map.md`.
- Link the ownership manifest from `docs/agent-task-router.md` and `docs/README.md`.

Review phase 2 returned zero Minor-or-higher issues. Execution may proceed.
