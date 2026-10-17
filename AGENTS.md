# Pharos (stablecoin analytics dashboard)

Static Next.js 16 export on Cloudflare Pages; API on a Cloudflare Worker + D1. Live: https://pharos.watch — local dev: http://localhost:3000/

## Do this first

1. Locate a likely file, then route it: `npm run agent:route -- --file <path>` (repeatable).
2. Read required entry docs/anchors and every returned scoped `AGENTS.md`, then inspect entrypoints and local imports. All returned rules, checks, and warnings still apply; conditional background reading does not make them optional.
3. For onboarding, scratch, handoff, or commit conventions, consult `docs/process/agent-start-here.md` when relevant.

## Tool routing

- Native read/grep/glob/edit tools first; Bash only for commands that need a shell. If the harness rejects a shell command as shadowed by a native tool, switch tools — never retry it.
- Codex/omp: once root `AGENTS.md` is loaded, do not reread `CLAUDE.md`; read all scoped `AGENTS.md` files returned by the router, with more-specific rules taking precedence.

## Working rules

- State assumptions; ask only when ambiguity blocks a safe choice. Smallest root-cause fix; no unrelated refactors; preserve existing product/design patterns. Never revert, reformat, stage, or fold unrelated dirty work into the task.
- Code, schemas, registries, and checked runtime data are authoritative when prose disagrees.
- Use your harness's native delegation for independent, disjoint work; never assume it exists.
- No canonical formatter: match nearby style, no formatting-only churn, `git diff --check` clean (`docs/testing.md#source-formatting-policy`).
- Credentials: check the ignored root `.env.local` and the documented source before reporting one missing; names only, never values. Worker secrets stay Wrangler-managed.
- Runtime: mise shims read `.nvmrc`; first run `mise settings add idiomatic_version_file_enable_tools node`, then `mise install`. `check:pr` requires the exact `.nvmrc` Node and npm 11.x.
- Scratch lives in ignored `agents/`; durable guidance in `docs/` (`docs/process/agent-artifacts.md`).
- Update the owning doc for behavior, API, pipeline, methodology, or data-source changes (new sources also update the about page). Methodology changes update the four targets listed in [ADR-3](docs/architecture.md#adr-3); do not record release targets in ADR-3; versions increase numerically with at most two decimal digits (`v9.46` → `v9.47` or `v10.0`; never `v9.461`, never `v5.10`).

## Hard rules

- Tailwind classes must be static strings. Classification labels/colors live only in `shared/lib/classification.ts`.
- Supply: use `getCirculatingRawOrNull()` / historical `*OrNull` helpers from `shared/lib/supply.ts`; zero-default alternatives are deleted and banned by ESLint. Preserve unavailable values and aggregate completeness; only admitted observed members contribute numeric values, including explicit zero. DefiLlama list `circulating` is already USD — never multiply by price or apply arbitrary manual/on-chain/CMC/DEX overrides. Bounded CoinGecko aggregate gap-fill is a permitted supplemental path under ADR-8: explicit, documented, fail-closed, double-count safe, with ratio bound, hysteresis, coherent buckets, and per-asset provenance; the reviewed chain-dropout repair/quarantine path is the other permitted supplemental path ([ADR-8](docs/architecture.md#adr-8), clause (c)).
- Imports across runtime boundaries: use `@shared/lib/...` / `@shared/types...` (ESLint rejects relative imports into root `shared/` from `src/`, `worker/`, and `functions/`); within production `shared/lib/`, use relative imports (ESLint bans `@shared/*`); root TS config excludes `worker/`, and runtime-neutral logic belongs in `shared/lib/`.
- Cron-backed hooks: derive `staleTime = producer interval` and `refetchInterval = 2x producer interval` with `getPollingWindow()` / `createApiPollingQueryOptions()`.
- Worker fetches: Cloudflare caps six simultaneous requests waiting on response headers per invocation; Pharos statically budgets a stricter trigger-wide six-connection model (`npm run check:cron-connections`; not runtime admission control) — consume bodies before opening more fetches (`docs/worker-and-api-limits.md#connection-budget-operating-assumption`).
- D1 migrations run before the new Worker is live; destructive cleanup is a separate coordinated rollout (`npm run check:migrations`).
- Data-integrity rules R1-R8 (unavailable is not zero; a failed read never becomes a positive claim; a freshness verdict names its budget and generation; non-`ok` names a machine-readable reason; one authority per cadence/threshold/vocabulary; provenance names what was read this run; never publish a display-capped or clamped value as a statistic; quarantine the bad asset and publish the rest) are ADR-28 to ADR-35 in `docs/architecture.md`.
- Long docs (notably `docs/api-reference.md`): use the top navigation block, then read only the matched section.

## Verify and ship

- Focused checks are authoring feedback, never readiness proof (`docs/testing.md#smallest-adequate-check-per-area`); an unmapped production path's zero-plan is a routing failure.
- Run `npm run check:pr` for focused authoring feedback before pushing; hosted CI is the readiness authority ([Pre-push readiness](docs/testing.md#pre-push-readiness)). Local receipts are optional diagnostics, not a push prerequisite.
- CI failures: collect every failed leaf, fix all causal defects in one revision, rerun focused checks, then push once ([workflow incidents](docs/runbooks/workflow-incidents.md)). `check:release` is only an explicit production rehearsal; GitHub Actions owns the release gate.
- Commit thematically with a descriptive subject and a why-focused body. The pre-commit hook is partial artifact sync, never a test gate or full convergence: eligible `autoStage` outputs only; it skips merge/rebase/cherry-pick/revert, an empty index, or `PHAROS_SKIP_ARTIFACT_HOOK=1` (`docs/scripts.md#operational-notes`). No pre-push test hook.
- Do not create a branch, worktree, or PR unless asked. A request to push/publish/release authorizes the protected-main PR path; never push `main` directly. Merge release PRs with `gh pr merge --merge`; never squash or rebase them.
- A green deploy is not runtime health: for cron, scheduler, memory, migration, or ingestion changes, observe the first production execution before claiming success.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
