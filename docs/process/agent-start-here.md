# Agent Start Here

Use this page for repository work in omp, Claude Code, Codex, or another compatible harness. Harness-specific conveniences never override repository scope, safety, or verification rules.

## 1. Before Touching Files

Read the root `AGENTS.md` or `CLAUDE.md` first. For non-trivial work, locate a likely file and route every planned path before editing:

```bash
npm run agent:route -- --file <path>
```

For a multi-file change, pass repeatable `--file` options:

```bash
npm run agent:route -- \
  --file worker/src/cron/sync-yield-data.ts \
  --file docs/worker-and-api-limits.md
```

Read only the documents, anchors, and scoped `AGENTS.md` files the route returns, then inspect the source entrypoint and its local imports. Code, schemas, registries, and checked runtime data win when prose disagrees. Author root guidance in `CLAUDE.md`; root `AGENTS.md` is generated and must not be edited by hand.

Use native read, grep, glob, and edit tools first. Use Bash for real commands. If a harness rejects a shell command because a native tool shadows it, switch tools and never retry the same command.

## 2. Route A Task

The machine-readable routing source of truth is [`doc-ownership.json`](../doc-ownership.json). Its `mappings` array is the only authored source-to-document model; the registry loader derives the runtime path-family projection from it. Each mapping declares an id, label, risk, source globs, exact docs, and optional background references, scoped context, rules, and hints. A document reference is either a path string or `{ "path": "...", "anchor": "..." }`; long documents use verified heading anchors. Retained high-risk mappings carry focused checks; generic frontend routes carry short defaults, while low-risk generic routes intentionally rely on the adaptive runner's path-derived checks.

The `agent:route` alias invokes `scripts/ci/pharos-change-contract.ts`. Its `--file` input accepts repository-relative paths, `./` paths, absolute paths under the repository, and absolute paths under the current linked worktree; separators are normalized before routing. A missing explicit path is routed as a planned new file with a warning; add repeatable `--new-file` to suppress those warnings for the invocation. Selection precedence is `--file` > `--staged` > `--base-ref`/`--head-ref` flags > `PHAROS_CHANGE_CONTRACT_*_REF` environment range > working tree.

Use `--staged` when the intended change is staged but not committed. The command reports:

- matched ownership mappings and risk;
- changed source files;
- the smallest useful `Read first` docs set;
- scoped `AGENTS.md` context;
- background docs and hard rules; and
- deploy impact and safe routing warnings.

Then:

1. Read only the reported `path#anchor` sections and scoped context files.
2. Inspect the reported source entrypoints and follow local imports only as needed.
3. Treat code, schemas, registries, and checked runtime data as authoritative when prose disagrees.
4. Update the nearest owning doc only when behavior, API contracts, methodology, operations, or data-source policy changed.

### When Routing Misses

Search by source path or product term:

```bash
rg -n 'source/path|product term' docs docs/doc-ownership.json
rg --files docs | sort
```

Use [`docs/README.md`](../README.md) to choose between public reference, engineering contracts, process guidance, and runbooks. If a recurring source area is not classified correctly, update `doc-ownership.json` and its change-contract tests instead of expanding this page.

## 3. Core Repository Rules

- Prefer the smallest root-cause fix; avoid unrelated refactors.
- Update matching docs for behavior, API, pipeline, methodology, or data-source changes.
- Do not replace DefiLlama list supply with manual/on-chain/CMC/DEX overrides. Supplemental supply admission paths must be explicit, documented, fail-closed, and double-count safe.
- Keep Tailwind classes as static strings.
- Do not edit shadcn primitives in `src/components/ui/` unless explicitly required.
- Use `getCirculatingRaw()` for circulating supply and `@shared/lib/...` / `@shared/types...` for shared imports; avoid relative cross-boundary imports.
- Cron-backed hooks use `staleTime = producer interval` and `refetchInterval = 2x producer interval`.
- Consume Worker response bodies before opening more fetches; Pharos's trigger-wide connection budget is six.
- D1 migrations run before the new Worker is live. Destructive cleanup is a separate coordinated rollout.

## 4. Scratch Work

Put plans, research, screenshots, reports, captures, and handoffs under ignored `agents/<YYYY-MM-DD>-<slug>/`. Durable product, process, API, methodology, and operating truth belongs in the closest verified page under `docs/`, not in scratch.

Every campaign needs a README that records its owner, status, created and last-reviewed dates, source or plan, durable destinations, retention rule, and safe-to-remove condition. Follow the ledger and handoff convention in [Agent Artifacts](./agent-artifacts.md). Never infer that an ignored or old artifact is disposable.

## 5. Scope Safety

Treat unrelated working-tree changes as someone else's work. Do not revert, reformat, stage, or fold them into the task. Make the smallest root-cause change within the explicit file allowlist.

Do not create a branch, worktree, or pull request unless requested. Do not expose credentials, copy production Worker secrets into local files, run D1 migrations without the stated rollout authority, or edit generated outputs by hand. Check the documented environment source before reporting a local variable missing, and report only the variable name.

## 6. Verification

Choose the smallest adequate checks from [Testing: Smallest adequate check per area](../testing.md#smallest-adequate-check-per-area). Preserve nearby formatting because the repository has no canonical formatter, and finish with `git diff --check`. For larger committed batches, use `npm run check:pr -- --base=<ref>`; GitHub Actions remains the authoritative release gate.

Passing deployment proves activation, not runtime health. Cron, scheduler, ingestion, migration, and other operationally risky changes also require the first relevant production execution or observation before being called operationally complete.

## 7. Handoff

The final message must state:

- status: complete, partial, or blocked;
- exact changed files;
- verification commands and outcomes, including known failures;
- blockers and deferred items; and
- the next owner or action.

For a campaign, also update its ledger so every task ID ends as complete, deferred, superseded, or blocked. Record actual changed files and net LOC when the campaign contract requests them.

## 8. Commit And Release

Group changes into logical commits. Use a descriptive subject and a useful body explaining what changed and why. Batch commit bodies must include the stable scratch plan path and task IDs, for example:

```text
Plan: agents/<YYYY-MM-DD>-<slug>/IMPLEMENTATION-PLAN.md
Tasks: W2.6
```

The pre-commit hook may regenerate and stage registered artifacts marked `autoStage`; inspect that result as part of the same source commit. Publishing uses the protected-main branch and pull-request path. Never direct-push `main`.

## 9. Methodology Changes

Methodology history is structured under `shared/data/methodology-changelogs/` and rendered by the public `/methodology/*-changelog/` routes. ADR-3 in [`architecture.md`](../architecture.md#architectural-decision-records) lists every target a methodology change must update. Do not create a second Markdown timeline. Methodology versions increase numerically: after `v5.9`, use `v5.91` or `v6.0`, not `v5.10`.

## 10. Finish

Report the final artifact or plan path, verification and CI/deploy evidence, and any operational acceptance still pending. Name scratch as safe to remove only when its recorded condition is satisfied and its owner confirms closure. The handoff is complete when the next owner can continue without reconstructing scope, state, or evidence.
