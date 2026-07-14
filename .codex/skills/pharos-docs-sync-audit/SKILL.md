---
name: pharos-docs-sync-audit
description: Audit and repair Pharos documentation against the codebase. Use for documentation update passes, verified-doc drift, source-path/doc-sync failures, methodology/doc routing updates, or requests to verify docs without trusting existing prose.
user_invocable: true
---

# Pharos Docs Sync Audit

Use this skill from the Pharos repository root when the user asks to:

- verify docs against code
- update docs after behavior/API/pipeline/methodology changes
- fix `check:doc-source-paths`, `check:doc-sync`, or `check:verified-doc-links`
- run a documentation update pass
- reconcile agent guidance or skill routing

## Core Rules

- Code and checked runtime data are the source of truth. Do not trust existing docs without verifying.
- Start with `docs/agent-task-router.md` and read only the docs for the matched task family.
- Use `docs/doc-ownership.json` to decide which docs may need updates.
- Keep `/docs/` and `README.md` as the verified documentation corpus. Do not create committed planning archives.
- Mirror durable top-level guidance between `AGENTS.md` and `CLAUDE.md`, or move it into `docs/process/*` and reference it from both.
- If pricing pipeline, PSI, PegScore/DEWS, LiquidityScore, Report Cards, blacklist tracker, mint/burn flow, yield intelligence, Chain Health, or other methodology behavior changes, update `/methodology`, the owning methodology doc, and the structured entry under `shared/data/methodology-changelogs/`.
- Methodology versions increase numerically: after `v5.9`, use `v5.91` or `v6.0`, not `v5.10`.

## Read First

1. `docs/agent-task-router.md`
2. `docs/process/agent-artifacts.md`
3. `docs/doc-ownership.json`
4. `docs/testing.md`
5. The task-family docs selected by the router

For skill changes, also read the "Agent Skills" section of `docs/process/agent-artifacts.md`.

## Workflow

### 1. Scope The Audit

Classify the docs request:

- targeted doc failure
- docs update required by code change
- broad docs-vs-code audit
- methodology/version/timeline update
- agent guidance or skill maintenance

Use:

```bash
node scripts/ci/pharos-change-contract.mjs
```

or `--staged` when auditing staged changes.

### 2. Verify Against Source

For each doc claim, inspect the source that owns the behavior:

- routes/pages: `src/app/**`, `src/components/**`, `src/lib/page-metadata.ts`
- API: `shared/lib/api-endpoints/**`, `worker/src/routes/**`, `worker/src/api/**`
- cron/pipeline: `shared/lib/cron-jobs.ts`, `shared/lib/scheduled-runner-registry.ts`, `worker/src/cron/**`
- stablecoin data: `shared/data/stablecoins/coins/*.json`, `shared/lib/stablecoins/schema.ts`
- scripts/CI: `package.json`, `scripts/**`, `.github/workflows/**`
- methodology/scoring: `shared/lib/**`, `shared/data/methodology-changelogs/**`, and route methodology sections

Prefer source-backed corrections over prose polish.

### 3. Edit Docs Surgically

Update the smallest set of verified docs. Remove stale claims rather than adding caveats around false text.

Common doc destinations:

- route-specific docs linked from `docs/README.md`
- `docs/architecture.md` for structural routing/runtime model changes
- `docs/testing.md`, `docs/deployment-process.md`, `docs/scripts.md` for CI/release behavior
- `docs/process/*` for durable agent/operator process
- methodology docs plus structured changelog entries for scoring behavior
- `README.md`, `AGENTS.md`, and `CLAUDE.md` only when top-level guidance actually changes

### 4. Validate

Run the relevant doc checks:

```bash
npm run check:doc-source-paths
npm run check:verified-doc-links
npm run check:doc-sync
npm run check:agent-doc-sync
npm run check:agent-skill-symlinks
```

For generated docs/API artifacts:

```bash
npm run check:generated-artifacts
npm run check:docs-api-reference
npm run check:openapi
npm run check:postman
```

For broad docs work, prefer the specific failing check first, then `npm run validate:prebuild` if the user asked for production readiness.

### 5. Broad Audit With Subagents

For a broad docs-vs-code audit in Claude Code, use `.claude/workflows/docs-maintenance.mjs`. Its default mode verifies and adjudicates the corpus; pass `mode: "remediate"` to apply grouped, adjudicated fixes.

In Codex, or for a narrower family-scoped pass, use `references/subagents.md` to split the audit by docs family. Subagents should be read-only unless assigned a narrow doc write set.

The parent agent owns final edits, de-duplication, and validation.

## Completion Report

Report:

- docs updated
- source files used as truth
- doc checks run and outcome
- unresolved docs questions, if any
- any intentionally skipped broader validation
