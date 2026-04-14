# Agent Documentation Readiness Audit

Date: 2026-04-14

## Scope

Reviewed Pharos documentation from the perspective of a coding agent entering the repository cold. Local context sampled:

- `AGENTS.md` / `CLAUDE.md`
- `README.md`
- `docs/README.md`
- `docs/architecture.md`
- `docs/testing.md`
- `docs/worker-infrastructure.md`
- `docs/worker-and-api-limits.md`
- `docs/data-flow-map.md`
- `docs/data-pipeline.md`
- `docs/deployment-process.md`
- `docs/scripts.md`
- design docs at a higher level
- existing doc guardrail scripts under `scripts/`
- path existence checks for sampled code references
- headline stablecoin count check from grouped JSON metadata

External sources sampled:

- AGENTS.md standard: https://agents.md/
- Devin AGENTS.md docs: https://docs.devin.ai/onboard-devin/agents-md
- Devin DeepWiki docs: https://docs.devin.ai/work-with-devin/deepwiki
- Root archetype linked from the short URL: https://github.com/0xTwyne/root-archetype
- Paperclip: https://github.com/paperclipai/paperclip
- Aider repo map docs: https://aider.chat/docs/repomap.html
- Serena: https://github.com/oraios/serena
- Repomix: https://github.com/yamadashy/repomix
- Gitingest: https://github.com/coderamp-labs/gitingest
- RepoAgent paper: https://arxiv.org/abs/2402.16667
- CodeWiki paper: https://arxiv.org/abs/2510.24428

No tests, lint, build, or doc-sync scripts were run for this audit.

## Executive assessment

Pharos is already above average for agent-readiness. The useful documentation shape is present: short root instructions, a verified docs index, route/page contracts, methodology update rules, worker limits, a data-flow map, and CI guardrails that keep counts, links, doc sync values, environment contracts, cron schedules, and complexity hotspots from drifting.

The highest-impact improvement is not adopting a heavyweight agent governance framework. It is adding a small, generated agent code map plus task-specific entrypoint maps so agents can jump from user intent to the correct docs, source files, hooks, handlers, tests, and validation commands without reading large files or traversing the repo manually.

## Accuracy observations

- The headline count in `AGENTS.md` / `CLAUDE.md` / `README.md` is current by local metadata: `canonical-order.json` has 191 entries and `shared/lib/shadow-stablecoins.ts` has 2 shadow entries. The grouped JSON data also has 181 unspecified/live rows and 10 `pre-launch` rows.
- The root agent files are concise and current. `AGENTS.md` and `CLAUDE.md` are identical 81-line files, which is good for multi-agent consistency.
- The path-level spot checks for suspicious docs references passed. Sampled references including `worker/src/cron/dex-liquidity/geckoterminal-shared.ts`, `worker/src/lib/dex-api-common.ts`, `worker/src/cron/mint-burn/run-state.ts`, `src/styles/tokens/primitives.css`, `src/styles/tokens/semantic.css`, and methodology section modules exist.
- The docs corpus already has dedicated guardrails for stale hardcoded counts, broken doc links, exact-value doc sync, env contract drift, cron sync, connection budgets, worker import boundaries, shared cycles, unused code, SQL safety, stablecoin data validity, and hotspot ratchets.
- The main practical accuracy risk is not obvious broken links; it is volume and duplication. `docs/api-reference.md` is over 3,000 lines, `docs/worker-infrastructure.md` is over 1,100 lines, `docs/testing.md` is over 800 lines, and `docs/architecture.md` is over 700 lines. Those are valuable but not always efficient for an agent's first pass.

## Sufficiency observations

What is sufficient now:

- Root instructions are short enough for agents to absorb and include the important gotchas.
- `docs/README.md` works as a topic router and clearly distinguishes verified docs from archival `/agents` notes.
- `docs/data-flow-map.md` is especially useful because it maps domain to source, cron, storage, API, hook, and page in one table.
- `docs/scripts.md` makes the validation surface discoverable and avoids making agents infer which scripts matter.
- Methodology docs provide update contracts and timeline rules, which reduces the risk of code-only changes to scoring systems.
- Guardrail scripts already automate many kinds of drift detection.

What is insufficient for agents:

- There is no compact agent-first task router. A user may ask about “yield”, “chain health”, “site data proxy”, “stablecoin metadata”, “pricing source”, “D1 migration”, or “public API auth”, but the agent has to synthesize the correct docs and files from multiple large documents.
- There is no generated symbol or module map equivalent to Aider’s repo map. Agents still need `rg` and multiple reads to discover exports, handler names, hook names, and call relationships.
- There is no per-domain “touch matrix” that says: if you change X, also inspect/update Y docs, Y tests, Y hooks, Y route, and Y methodology page.
- There is no local “do not read these unless needed” hint for very large files and historical archives. `/agents/audits` is large and useful as evidence, but can become context poison if treated as canonical.
- There is no machine-readable DeepWiki steering file. If you ever use DeepWiki/Devin, it may miss important subsystems unless steered toward the worker cron lanes, shared registries, Pages Functions proxies, and methodology contracts.

## External tool assessment

### Root archetype

Useful concepts:

- Engine-neutral agent instructions with engine-specific compatibility files.
- Explicit knowledge lifecycle: notes, progress logs, handoffs, compiled wiki.
- Governance validators and hooks for protected paths, session lifecycle, and audit logs.

Recommendation for Pharos:

- Do not adopt the full root-governance repository. Pharos is a single repo with strong existing docs and CI guardrails; the multi-repo governance shell is overkill.
- Borrow the concept of an agent knowledge lifecycle only in a lightweight way: keep `/agents/` archival, add a short `/agents/README.md` rule that says which subfolders are canonical vs historical, and consider a small “compiled learnings” file for durable lessons.

### Paperclip

Useful concepts:

- Persistent task state, ticketing, budget control, audit trails, scheduled heartbeats, and org-chart style delegation.

Recommendation for Pharos:

- Do not adopt Paperclip for code discovery. It solves multi-agent operations and autonomous task management, not local understanding of this codebase.
- If you eventually run many autonomous agents on Pharos, the useful concept is immutable task/audit trails with budget limits. That is operational governance, not documentation readiness.

### Aider repo map

Useful concepts:

- Concise whole-repo map with key classes/functions/types/signatures.
- Dependency/ranking-based context selection so the map fits a token budget.
- Map helps the agent choose which files to read next.

Recommendation for Pharos:

- This is the most directly useful idea. Implement a cheap generated `agents/maps/code-map.md` or `docs/agent-code-map.md` that lists key exports and entrypoints by domain.
- Keep it generated and CI-checked, not hand-maintained.

### Serena

Useful concepts:

- MCP tool for semantic code retrieval, symbol overview, references, and symbol-level edits using LSP/IDE backends.
- Particularly useful for cross-file renames and reference tracing.

Recommendation for Pharos:

- Consider optional Serena MCP for local agents, especially for TypeScript reference lookups and large refactors. Do not make it required. The repo already supports `rg`-based work, and adding an MCP dependency may create setup friction.
- If adopted, document it in an optional section of `AGENTS.md` or `agents/process/agent-tooling.md`, not in the main setup path.

### Repomix / Gitingest

Useful concepts:

- Pack selected files into AI-friendly formats with token counts and ignore rules.
- Repomix can include specific globs or stdin-selected files and supports compression.

Recommendation for Pharos:

- Useful for out-of-band consulting or web-chat review when the agent lacks filesystem access.
- Less useful in this Codex-style local workspace, because the agent can read files directly and should avoid bulk context dumps.
- If used, configure narrow recipes such as “pricing pipeline context pack” or “worker API context pack”, not whole-repo packing.

### DeepWiki / RepoAgent / CodeWiki

Useful concepts:

- Generated architecture pages, diagrams, and source-linked summaries.
- Steering files can force coverage of large-repo areas that automated clustering might skip.
- Research trend points to hierarchical decomposition plus diagrams/data-flow representations as useful for large codebases, but generated docs still need verification.

Recommendation for Pharos:

- Do not replace verified docs with generated wiki pages.
- If using DeepWiki, add `.devin/wiki.json` steering with explicit pages for architecture overview, worker cron/data pipeline, API routing, Pages Functions/proxy lanes, methodology/scoring systems, stablecoin metadata registry, D1 migrations, frontend route/hook model, and validation scripts.
- Treat generated wiki output as an onboarding aid, not a source of truth.

## Highest-impact changes

1. Add a compact agent task router.

Suggested file: `docs/agent-task-router.md` or `agents/process/task-router.md`.

Shape:

| User intent | Read first | Runtime files | Tests/checks | Docs to update | Gotchas |
|---|---|---|---|---|---|
| Add stablecoin | `agents/process/adding-a-stablecoin.md`, `docs/classification.md` | `shared/data/stablecoins/*`, `shared/lib/stablecoins/*`, `shared/lib/chains.ts` if needed | `npm run check:stablecoin-data`, focused registry tests | about/methodology only if data-source or methodology changes | no supply overrides |
| Pricing source | `docs/pricing-pipeline.md`, `docs/data-pipeline.md` | `worker/src/cron/sync-stablecoins/*`, `worker/src/lib/price-consensus.ts`, provider config files | pricing provider audit, endpoint contract tests | pricing timeline, about page | consume failed fetch bodies |
| API endpoint | `docs/api-reference.md`, `docs/architecture.md` | `shared/lib/api-endpoints/*`, `worker/src/routes/*`, handler file, hook file | handler contract test, smoke path if strict | API reference, page docs | route flags and site-data allowlist |
| D1 migration | `docs/deployment-process.md`, `worker/migrations/MANIFEST.md` | migration file, read/write code | `npm run check:migrations` | worker infra docs if schema-facing | backward-compatible only |

2. Generate a lightweight code map.

Recommended minimal implementation:

- Script: `scripts/generate-agent-code-map.mjs`
- Output: `agents/maps/code-map.md` or `docs/agent-code-map.md`
- Inputs: `rg --files` plus TypeScript AST or simple regex for `export function`, `export const`, `export type`, `class`, route handlers, hooks, cron exports.
- Sections: Frontend routes, hooks, API endpoint registry, worker routes, worker crons, shared scoring modules, stablecoin data registry, Pages Functions, validation scripts.
- CI: either check in the generated file and add a “freshness” check, or generate on demand and document the command.

Do not overbuild the first version. A static map with filenames and top-level exports would already reduce many exploratory reads.

3. Add per-directory nested `AGENTS.md` files only where context differs.

Candidates:

- `worker/AGENTS.md`: Worker runtime constraints, D1 migration ordering, cron connection budget, no module-scope env reads, response body consumption.
- `shared/AGENTS.md`: runtime-neutral ES2017 constraint, `@shared/lib/...` imports, no worker/src imports, stablecoin metadata rules.
- `src/AGENTS.md`: static export, Tailwind static class strings, hook timing rule, shadcn `ui/` primitive constraint, design docs when touching UI.
- `functions/AGENTS.md`: Pages Functions proxy/auth/site-data lane rules.
- `shared/data/stablecoins/AGENTS.md`: metadata schema, canonical order, no manual supply overrides, when to update about/methodology docs.

Keep each under roughly 40 lines. The root file is already good; nested files should remove repeated context, not add ceremony.

4. Add a machine-readable doc ownership manifest.

Suggested file: `docs/doc-ownership.json` or `scripts/lib/doc-ownership.ts`.

Purpose:

- Map source globs to docs that must be considered.
- Example: `worker/src/cron/sync-stablecoins/**` maps to `docs/pricing-pipeline.md`, `docs/data-pipeline.md`, `docs/pricing-pipeline-timeline.md`, `docs/about-page.md`, `docs/api-reference.md` when API shape changes.
- Feed this into `test:merge-gate` as a warning first, not a hard gate.

This would help agents answer “what docs do I update?” without scanning every update rule.

5. Add a `.devin/wiki.json` only if using DeepWiki/Devin.

Suggested pages:

- Architecture Overview
- Frontend Routes and Data Hooks
- Worker API Routing
- Worker Cron and Data Pipeline
- Stablecoin Metadata and Registry
- Scoring and Methodology Systems
- D1 Schema, Migrations, and Deployment Ordering
- Pages Functions and Runtime Host Split
- Validation, Testing, and Merge Gate
- Agent Operating Rules and Gotchas

This is low-cost if Devin/DeepWiki enters the workflow, but unnecessary otherwise.

6. Improve `/agents/` archive discoverability.

Current `/agents/audits` is large. Add or update `agents/README.md` with:

- `/agents/audits` is historical evidence, not verified source of truth.
- Prefer latest dated audit only when investigating a specific previous decision.
- Durable process docs live in `agents/process/`.
- Verified docs remain `README.md` and `/docs/`.

7. Optional: add focused Repomix recipes.

If you need web-chat review or a non-local agent, add `repomix.config.json` profiles or documented commands for focused packs:

- pricing pipeline pack
- worker API pack
- frontend route/hook pack
- stablecoin metadata pack
- deployment/ops pack

Avoid whole-repo packs by default because Pharos is large and the verified docs already provide better summaries.

## Bottom line

Pharos does not need a complex agent orchestration framework to make coding agents effective. It needs a few thin, durable navigation artifacts:

1. task router
2. generated code map
3. nested `AGENTS.md` files for high-risk subtrees
4. doc ownership manifest
5. optional DeepWiki steering if that tool is used

Those changes preserve the repo’s current strengths while reducing agent exploration cost and lowering the chance that a future agent reads the wrong large file, misses a methodology/doc update, or treats archival `/agents` material as canonical.
