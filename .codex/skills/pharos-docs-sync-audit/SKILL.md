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
- Start with `docs/process/agent-start-here.md` and read only the docs for the matched task family.
- Use `docs/doc-ownership.json` to decide which docs may need updates.
- Keep `/docs/` and `README.md` as the verified documentation corpus. Do not create committed planning archives.
- Do not re-verify what CI already guards: file-path citations (`check:doc-source-paths`), internal doc links (`check:verified-doc-links`), methodology/doc sync (`check:doc-sync`), the generated `AGENTS.md` mirror (`check:generated-artifacts -- --only=agents-doc`), and generated API artifacts (`check:generated-artifacts -- --only=api-reference,openapi,postman`). The rest of the API reference is hand-written and remains in semantic-audit scope.
- `docs/api-reference.md` is far over the wholesale-read threshold. Navigate it via its top navigation block plus Grep or offset reads only.
- Author durable top-level guidance in `CLAUDE.md`, or move it into `docs/process/*` and reference it from `CLAUDE.md`. Regenerate `AGENTS.md` with `node --import tsx scripts/maintenance/generate-agents-doc.ts`; never edit the generated mirror by hand.
- If pricing pipeline, PSI, PegScore/DEWS, LiquidityScore, Report Cards, blacklist tracker, mint/burn flow, yield intelligence, Chain Health, or other methodology behavior changes, update `/methodology`, the owning methodology doc, and the structured entry under `shared/data/methodology-changelogs/`.
- Methodology versions increase numerically: after `v5.9`, use `v5.91` or `v6.0`, not `v5.10`.

## Read First

1. `docs/process/agent-start-here.md`
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
node scripts/ci/pharos-change-contract.ts
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
- `README.md` and `CLAUDE.md` only when top-level guidance actually changes; regenerate `AGENTS.md` after editing `CLAUDE.md`

### 4. Validate

Run the relevant doc checks:

```bash
npm run check:doc-source-paths
npm run check:verified-doc-links
npm run check:doc-sync
npm run check:generated-artifacts -- --only=agents-doc
```

For generated docs/API artifacts:

```bash
npm run check:generated-artifacts
npm run check:generated-artifacts -- --only=api-reference,openapi,postman
```

For broad docs work, prefer the specific failing check first, then `npm run check:pr -- --base=<ref>` after commit if the user asked for PR readiness.

### 5. Broad Audit With Reviewers

When the user authorizes delegation, use `references/subagents.md` to split a broad audit by documentation family. Prefer read-only reviewers; grant a writer only a narrow, disjoint docs set. Capability mappings are in `docs/process/agent-artifacts.md#harness-configuration`.

The parent agent owns final edits, de-duplication, and validation.

### 6. Scalable audit mode

For a whole-corpus pass, enumerate `getVerifiedDocFiles(repoRoot)` from `scripts/lib/doc-files.mts`, the canonical verified corpus collector. Then attach category/source-glob hints from `docs/doc-ownership.json`, resolving object references through `path`. Unmapped documents remain in scope. Targeted requests still use only their requested subset. Reject missing selected paths and do not invent a second filename roster. Keep the inventory in memory or ignored scratch space; do not commit a manifest.

When delegation is available and authorized, partition the inventory into N disjoint doc sets and fan out read-only verifiers. Otherwise perform the same bounded verification and skeptical reopening sequentially, explicitly reporting that review was not independent. Each verifier audits only its assigned files, using `light` depth for timeline archives, `targeted` navigation/offset reads for `docs/api-reference.md`, and `deep` reads elsewhere; record every skipped row with its reason in coverage; never silently omit it. If an expected row count is supplied, fail when the loaded inventory is shorter. It must report concrete semantic discrepancies only; CI-owned path/link/generated checks stay out of scope. For every non-empty result, an independent skeptic reopens the doc and cited source, defaults to `REJECTED`, and returns only `CONFIRMED` or `REVISED` findings when code clearly contradicts the prose. Deterministically deduplicate and split adjudicated findings into auto-fixable versus needs-decision.

Remediation requires authorization; an earlier explicit instruction to repair this cohort already supplies it, so do not ask again for the same scope. Give one writer a narrow per-document scope; it must re-find the claim, reopen the evidence, skip stale findings, apply the smallest doc-only edit, and return applied/skipped entries. The parent owns synthesis, approval, edits, and the final checks. See `references/subagents.md` for the inventory, verifier, skeptic, and remediation contracts.

## Completion Report

Report:

- docs updated
- source files used as truth
- doc checks run and outcome
- unresolved docs questions, if any
- any intentionally skipped broader validation
