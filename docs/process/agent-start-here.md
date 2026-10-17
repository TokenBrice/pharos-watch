# Agent Start Here

Use this page for routing and handoff; root [`AGENTS.md`](../../AGENTS.md) owns repository rules in every harness.

## 1. Before Touching Files

Follow root [Do this first](../../AGENTS.md#do-this-first). For multiple paths, repeat `--file`: `npm run agent:route -- --file <source> --file <doc>`. Author root guidance directly in `AGENTS.md`; `CLAUDE.md` imports it.

## 2. Route A Task

[`doc-ownership.json`](../doc-ownership.json) `mappings` is the only authored source-to-document model. It declares source globs, owner docs, background references, scoped context, rules, exceptional checks and `testOwnership` for contracts invisible to the import graph. References are paths or `{ "path": "...", "anchor": "..." }`. Focused plans synthesize baseline checks through the shared PR selector (`selectPrBaselineChecks`), then add mapping-specific checks; do not duplicate baseline inventories in mappings.

`agent:route` invokes `scripts/ci/pharos-change-contract.ts`. Selection precedence: `--file` > `--staged` > range flags > `PHAROS_CHANGE_CONTRACT_*_REF` environment range > working tree. Both it and `check:focused` accept `--base`/`--base-ref` and `--head`/`--head-ref`. Explicit paths may be repository-relative, `./`-relative, or absolute under the repo/current linked worktree; separators normalize. Missing paths route as planned files with a warning; repeatable `--new-file` suppresses only existence warnings.

Read exact `Read first` anchors and every scoped `AGENTS.md`; follow source entrypoints/local imports. Single-path `Read first` caps at six entries; overflow goes to conditional `Also relevant`, not discarded obligations. All returned checks, rules and warnings apply. Text/JSON output retains them; SessionStart is only a bounded hint and reports unavailable Git evidence. Unknown options, missing values, invalid hook modes and failed Git selections fail instead of yielding empty success. Git selection retains deletions and both rename sides; existing-file requirements filter only at execution.

Primary Markdown sections (heading through next same/higher heading, or whole unanchored file) must fit 25 KB UTF-8. Registry-test legacy ceilings only shrink; remove exceptions once sections fit or cease being primary. Every verified doc needs an existing mapping's `docs`/`background` owner, not just `docs/**`. Widen existing source families rather than add mappings. Live-reserves, DEX-liquidity, Worker-infrastructure, Safety Score and pricing guides keep current contracts below 40 KB; linked process appendices hold implementation/history, never a second live authority. Move anchors, routing references and generated-block consumers together.

### When Routing Misses

`Missing documentation owner` also applies to planned files. Generic-only runtime/docs matches do not establish domain ownership: inspect source and find its contract, then fix the existing mapping and change-contract tests. Any unmapped path makes `check:focused` fail with `routing-incomplete`, even plan-only. A mapped `intentional-no-check` differs from a zero-plan; neither proves readiness. Missing declared `testOwnership` suites fail PR executable-test validation. Use the [documentation index](../README.md) for discovery and [stale-output selector](../README.md#stale-output-diagnosis) for producer incidents, not scheduling guidance as remediation.

## 3. Core Repository Rules

See root [Working rules](../../AGENTS.md#working-rules) and [Hard rules](../../AGENTS.md#hard-rules).

## 4. Scratch Work

Use ignored `agents/<YYYY-MM-DD>-<slug>/` only when useful. [Artifact placement](./agent-artifacts.md#source-of-truth) separates scratch evidence from durable docs; [campaign handoff](./agent-artifacts.md#campaign-index-and-handoff) requires outcomes/retention, not boilerplate ledgers for bounded work. Ignored or old does not mean disposable.

## 5. Scope Safety

See root [Working rules](../../AGENTS.md#working-rules) and [Verify and ship](../../AGENTS.md#verify-and-ship) for concurrent-tree, credential and release authority.

## 6. Verification

[Testing](../testing.md#smallest-adequate-check-per-area) owns check selection; [Pre-push readiness](../testing.md#pre-push-readiness) owns authoring feedback versus hosted readiness. [Workflow incidents](../runbooks/workflow-incidents.md) owns failed-leaf diagnosis and replacement-push evidence.

## 7. Handoff and Finish

Report changed files/findings, exercised checks, unresolved work and operational acceptance when applicable. For cross-session/coordinated campaigns, reconcile task outcomes and retain evidence under the [campaign closeout contract](./agent-artifacts.md#campaign-index-and-handoff).

## 8. Commit And Release

Root [Verify and ship](../../AGENTS.md#verify-and-ship) owns commit and protected-main policy; [Scripts: Operational notes](../scripts.md#operational-notes) owns workspace automation. For substantial campaigns only, include the existing scratch plan path and task IDs in the commit body; bounded changes need neither.

## 9. Methodology Changes

[ADR-3](../architecture.md#adr-3) owns required co-updates and version policy. Structured history under `shared/data/methodology-changelogs/` renders public changelog routes; do not create a second Markdown timeline.
