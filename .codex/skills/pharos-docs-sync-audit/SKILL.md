---
name: pharos-docs-sync-audit
description: Audit and repair Pharos documentation against the codebase. Use for documentation update passes, verified-doc drift, source-path/doc-sync failures, methodology/doc routing updates, or requests to verify docs without trusting existing prose.
user_invocable: true
---

# Pharos Docs Sync Audit

## Trigger And Exclusions

Use for source-backed docs verification/repair and agent guidance/skill routing, not prose polish without evidence. Code and checked runtime data are truth; existing docs are hypotheses. Semantic auditors do not repeat CI-owned mechanical checks.

## Classify The Operation

Select targeted failing doc check, code-change documentation update, broad semantic audit, methodology/version/timeline work, or agent/skill maintenance. Route likely source paths through `docs/doc-ownership.json`; inspect the matched source/local imports. Use `node scripts/ci/pharos-change-contract.ts` (`--staged` for staged changes) when assessing a change contract.

## Mandatory Core

- [Route A Task](../../../docs/process/agent-start-here.md#2-route-a-task), `docs/doc-ownership.json`, and [Documentation Rules](../../../docs/README.md#documentation-rules); read only the selected family/anchors, not all background docs.
- [Source Of Truth](../../../docs/process/agent-artifacts.md#source-of-truth): `/docs/` and `README.md` are the verified corpus, not committed planning archives. Durable process guidance belongs in existing verified docs.
- Make source-backed, smallest-scope corrections; remove stale claims, not caveats around false prose. Preserve generated marker blocks; edit the owning source/generator, never literal generated values.
- Docs at or above 400 lines or 50 KB need a top `> **Agent navigation**` block. Use matched section/offset reads, especially for `docs/api-reference.md`.
- CI owns source-path citations, internal links, methodology/doc sync, the generated agent mirror and generated API artifacts. Hand-written API prose remains in semantic scope. Structural proof is not semantic truth.

## Branch Reads And Actions

- **Targeted check failure:** read the failing command in [Testing commands](../../../docs/testing.md#commands), [script validation index](../../../docs/scripts.md#validation-command-index), its implementation and affected owner sections. For generated failures, read [failure playbook](../../../docs/testing.md#generated-artifact-failure-playbook) and registry entries.
- **Code-change docs:** read routed owner anchors and sources for each claim: routes/pages (`src/app/**`, `src/components/**`, `src/lib/page-metadata.ts`); API (`shared/lib/api-endpoints/**`, `worker/src/routes/**`, `worker/src/api/**`); cron (`shared/lib/cron-jobs.ts`, `shared/lib/scheduled-runner-registry.ts`, `worker/src/cron/**`); stablecoins (`shared/data/stablecoins/coins/*.json`, `shared/lib/stablecoins/schema.ts`); scripts/CI (`package.json`, `scripts/**`, `.github/workflows/**`); scoring (`shared/lib/**`, methodology changelogs and route sections). Use existing feature/process owners; update architecture only for structural changes and top-level guidance only when its contract changes.
- **Methodology/version:** read [ADR-3](../../../docs/architecture.md#architectural-decision-records) and all owning targets, including runtime version and `shared/data/methodology-changelogs/`. Actual behavior changes update every target; prose correction of unchanged behavior needs no bump/changelog. Numeric versions have at most two decimal digits: `v5.9` → `v5.91` or `v6.0`, never `v5.10` or `v5.911`.
- **Agent/skill maintenance:** read [Agent Skills](../../../docs/process/agent-artifacts.md#agent-skills); edit only canonical bodies and preserve symlink facades. Author root guidance in `CLAUDE.md` or linked `docs/process/*`, regenerate with `node --import tsx scripts/maintenance/generate-agents-doc.ts`, never hand-edit `AGENTS.md`.
- **Broad audit/delegated review:** read [reviewer and scalable-corpus contracts](references/subagents.md) and [Harness Configuration](../../../docs/process/agent-artifacts.md#harness-configuration). Enumerate `getVerifiedDocFiles(repoRoot)` in `scripts/lib/doc-files.mts`, attach registry hints via reference `path`, and keep unmapped docs in scope. Reject missing selected paths and short expected inventories; no second filename roster or committed manifest. Partition disjoint coverage; record every skipped row/reason. Independent skeptics reopen non-empty findings and default to `REJECTED`; confirmed/revised source-backed findings alone enter synthesis. Without delegation, perform bounded discovery/skeptical reopening sequentially and disclose non-independent review. Remediation needs authorization (existing cohort approval remains valid), narrow writer scope and reopened evidence; parent owns de-duplication, final edits and validation.

## Checks Owned By The Verifier

The assigned verifier runs relevant gates after writers finish; semantic reviewers return source evidence, not mechanical CI findings.

- Docs: `npm run check:doc-source-paths`, `npm run check:verified-doc-links`, `npm run check:doc-sync`.
- Root guidance: `npm run check:generated-artifacts -- --only=agents-doc`; skills: `npm run check:agent-skills`.
- Generated API: `npm run check:generated-artifacts -- --only=api-reference,openapi,postman`; broader generated work uses the registry-owned checks.
- Start with the failing gate. If PR readiness is requested, follow [Pre-push readiness](../../../docs/testing.md#pre-push-readiness), never a focused check/base override as readiness proof.

## Completion Evidence

Report docs changed, source files used as truth, actual verifier checks/outcomes or assigned checks, coverage/skips and independence for broad audits, unresolved questions, and intentionally omitted broader validation. Keep evidence in ignored scratch, not a new product-doc archive.
