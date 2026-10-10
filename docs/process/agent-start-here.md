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

The machine-readable routing source of truth is [`doc-ownership.json`](../doc-ownership.json). Its `mappings` array is the only authored source-to-document model; the registry loader derives the runtime path-family projection from it. Each mapping declares an id, label, risk, source globs, exact docs, and optional background references, scoped context, rules, checks, `testOwnership`, and hints. A document reference is either a path string or `{ "path": "...", "anchor": "..." }`; long documents use verified heading anchors. Generic Worker/shared routes and sensitive owners carry baseline typing, lint, and generated-artifact obligations. `testOwnership` adds explicit suites for contracts invisible to the import graph, such as closure inventories and capture schemas; consult the live mapping rather than inferring ownership from imports alone.

The `agent:route` alias invokes `scripts/ci/pharos-change-contract.ts`. Its `--file` input accepts repository-relative paths, `./` paths, absolute paths under the repository, and absolute paths under the current linked worktree; separators are normalized before routing. A missing explicit path is routed as a planned new file with a warning; add repeatable `--new-file` to suppress those warnings for the invocation. Selection precedence is `--file` > `--staged` > `--base-ref`/`--head-ref` flags > `PHAROS_CHANGE_CONTRACT_*_REF` environment range > working tree.

Routing rejects unknown options, missing values, invalid hook modes, and failed Git selections instead of reporting an empty successful contract. Git-based selection retains deletions and both sides of renames; commands that require existing files filter those paths only when executing. Ordinary text and JSON output include every required doc, check, and rule; SessionStart remains a bounded hint and explicitly reports unavailable Git evidence.

Single-path `Read first` is capped at six entries; overflow remains in `Also relevant`. Domain mappings for reserves, yield, route contracts, and compliance add ownership and rules without adding broad test trees. The reviewed mapping cap is 29 (DEC-14); maintain the one registry rather than introducing another source inventory. Primary Markdown sections must remain at most 25 KB, measured in UTF-8 bytes from their heading through the next heading of the same or higher level (or the entire file for unanchored references). The registry test retains explicit byte ceilings for legacy oversized sections: these exceptions must shrink, never grow, and must be removed when a section fits the budget or is no longer routed as primary. New domain owners cannot use legacy exceptions.

Every verified document, including process pages and runbooks, must appear in an existing mapping's `docs` or `background` references; the generic `docs/**` fallback alone is not a source owner. Widen the existing source families instead of adding mappings. The live-reserves, DEX-liquidity, Worker-infrastructure, Safety Score, and pricing guides keep their current contracts below 40 KB, with detailed implementation and historical decisions in linked `docs/process/*-appendix.md` pages. Preserve the original content and migrate moved anchors, routing references, and generated-block consumers together; appendices are background detail, not a second behavioral authority.

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

A path with no matching mapping emits a `Missing documentation owner` warning, including planned paths passed with `--new-file`; that flag suppresses only the filesystem-existence warning. A generic runtime match is context, not proof that every domain contract was found. For stale producer output, use the [symptom selector](../README.md#stale-output-diagnosis) and the routed observation background rather than treating scheduling guidance as an incident runbook.

An unmapped production path makes `check:focused` fail with machine-readable `routing-incomplete`, including in plan-only mode. A zero-plan is not verification. A mapped deliberate no-check plan is reported separately as `intentional-no-check`; neither focused result is final readiness proof. Missing declared `testOwnership` tests separately fail PR executable-test validation.

Search by source path or product term:

```bash
rg -n 'source/path|product term' docs docs/doc-ownership.json
rg --files docs | sort
```

Use [`docs/README.md`](../README.md) to choose between public reference, engineering contracts, process guidance, and runbooks. If a recurring source area is not classified correctly, update `doc-ownership.json` and its change-contract tests instead of expanding this page.

## 3. Core Repository Rules

The repository's working rules and hard rules are owned by the root [`CLAUDE.md`](../../CLAUDE.md) and its generated `AGENTS.md` mirror — supply and import contracts, static Tailwind classes, cron hook polling windows, the six-connection trigger budget, and migration ordering. The root rules are authoritative; read them before editing. This page does not repeat them.

## 4. Scratch Work

Create scratch files only when useful; put plans, research, screenshots, reports, captures, and handoffs under ignored `agents/<YYYY-MM-DD>-<slug>/`. Durable product, process, API, methodology, and operating truth belongs in the closest verified page under `docs/`, not in scratch.

Campaign READMEs, ledgers, dispatch packets, and retention records are for substantial work spanning sessions or requiring coordinated agent handoffs. Bounded fixes and reviews need no scratch ledger. Follow the scope and handoff convention in [Agent Artifacts](./agent-artifacts.md#campaign-index-and-handoff). Never infer that an ignored or old artifact is disposable.

## 5. Scope Safety

Treat unrelated working-tree changes as someone else's work. Do not revert, reformat, stage, or fold them into the task. Make the smallest root-cause change within the explicit file allowlist.

Do not create a branch, worktree, or pull request unless requested. Do not expose credentials, copy production Worker secrets into local files, run D1 migrations without the stated rollout authority, or edit generated outputs by hand. Check the documented environment source before reporting a local variable missing, and report only the variable name.

## 6. Verification

Use [Testing: Smallest adequate check per area](../testing.md#smallest-adequate-check-per-area) for authoring feedback, not readiness proof. Preserve nearby formatting because the repository has no canonical formatter, and finish with `git diff --check`.

Before every authorized push, first or replacement, follow the canonical ordered [Pre-push readiness](../testing.md#pre-push-readiness) sequence. Use mise shims reading `.nvmrc`: first enable `mise settings add idiomatic_version_file_enable_tools node`, then `mise install`; `check:pr` enforces exact `.nvmrc` Node and npm 11.x. Refresh the target refs and finish source/integration commits, run full `npm run check:generated-artifacts` convergence, then full plain `npm run check:pr` on the final committed state with no skip/filter/plan-only flags. The proof is a fresh passing `.tmp/pr-check-receipts/<HEAD>.json`; repeat readiness after subsequent edits, commits, or integration. GitHub Actions remains the authoritative release gate.

Opt into `npm run check:pr -- --ci-parity` after a remote failure the local gate did not reproduce, and for lockfile/setup/security-policy changes. If CI fails, collect every failed leaf, reproduce narrowly, fix all causal defects in one revision, rerun full readiness, and push once. Do not treat a focused rerun as replacement-push authorization.

Passing deployment proves activation, not runtime health. Cron, scheduler, ingestion, migration, and other operationally risky changes also require the first relevant production execution or observation before being called operationally complete.

## 7. Handoff and Finish

For bounded fixes and reviews, complete the authorized work, run focused validation, and briefly report changes or findings, checks, and unresolved work. Substantial campaigns also follow the [Agent Artifacts campaign index and closeout contract](./agent-artifacts.md#campaign-index-and-handoff).

## 8. Commit And Release

Group changes into logical commits. Use a descriptive subject and a useful body explaining what changed and why. For substantial campaigns, include the existing scratch plan path and task IDs; bounded changes need neither. Campaign example:

```text
Plan: agents/<YYYY-MM-DD>-<slug>/IMPLEMENTATION-PLAN.md
Tasks: W2.6
```

The pre-commit hook is partial artifact synchronization, never a test gate or proof of full generated convergence. It may regenerate and stage affected registered artifacts marked `autoStage`; inspect that result as part of the same source commit. It skips merge, rebase, cherry-pick, revert, an empty index, or `PHAROS_SKIP_ARTIFACT_HOOK=1`; selection and unsafe-overlap rejection are owned by [Scripts: Operational notes](../scripts.md#operational-notes). No pre-push test hook enforces readiness. Publishing uses the protected-main branch and pull-request path. Never direct-push `main`.

## 9. Methodology Changes

Methodology history is structured under `shared/data/methodology-changelogs/` and rendered by the public `/methodology/*-changelog/` routes. [ADR-3](../architecture.md#adr-3) lists every target a methodology change must update. Do not create a second Markdown timeline. Methodology versions increase numerically: after `v5.9`, use `v5.91` or `v6.0`, not `v5.10`.
