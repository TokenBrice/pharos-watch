# Pharos (stablecoin analytics dashboard)

Static Next.js 16 export on Cloudflare Pages; API on a Cloudflare Worker + D1. Live: https://pharos.watch — local dev: http://localhost:3000/

`CLAUDE.md` is the authored source; `AGENTS.md` is its generated, byte-identical mirror (never hand-edit `AGENTS.md`).

## Do this first

1. Locate a likely file, then route it: `npm run agent:route -- --file <path>` (repeatable).
2. Read only the docs, anchors, and scoped `AGENTS.md` it returns; inspect the reported entrypoints and local imports.
3. Onboarding, scratch, handoff, and commit conventions: `docs/process/agent-start-here.md`.

## Tool routing

- Native read/grep/glob/edit tools first; Bash only for commands that need a shell. If the harness rejects a shell command as shadowed by a native tool, switch tools — never retry it.
- Codex/omp: once root `AGENTS.md` is loaded, do not reread `CLAUDE.md`; read only the nearest scoped `AGENTS.md`.

## Working rules

- State assumptions; ask only when ambiguity blocks a safe choice. Smallest root-cause fix; no unrelated refactors; preserve existing product/design patterns and unrelated dirty work.
- Use your harness's native delegation for independent, disjoint work; never assume it exists.
- No canonical formatter: match nearby style, no formatting-only churn, `git diff --check` clean (`docs/testing.md#source-formatting-policy`).
- Credentials: check the ignored root `.env.local` and the documented source before reporting one missing; names only, never values. Worker secrets stay Wrangler-managed.
- Runtime: mise shims read `.nvmrc`; first run `mise settings add idiomatic_version_file_enable_tools node`, then `mise install`. `check:pr` requires the exact `.nvmrc` Node and npm 11.x.
- Scratch lives in ignored `agents/`; durable guidance in `docs/` (`docs/process/agent-artifacts.md`).
- Update the owning doc for behavior, API, pipeline, methodology, or data-source changes (new sources also update the about page). Methodology changes update every ADR-3 target in `docs/architecture.md`; versions increase numerically with at most two decimal digits (`v9.46` → `v9.47` or `v10.0`; never `v9.461`, never `v5.10`).

## Hard rules

- Tailwind classes must be static strings. Classification labels/colors live only in `shared/lib/classification.ts`.
- Supply: use `getCirculatingRawOrNull()` / historical `*OrNull` helpers from `shared/lib/supply.ts` at absence-sensitive boundaries; raw helpers require explicit availability proof. DefiLlama list `circulating` is already USD — never multiply by price or apply arbitrary manual/on-chain/CMC/DEX overrides. Bounded CoinGecko aggregate gap-fill is a permitted supplemental path under ADR-8: explicit, documented, fail-closed, double-count safe, with ratio bound, hysteresis, coherent buckets, and per-asset provenance.
- Imports: `@shared/lib/...` / `@shared/types...`, no relative cross-boundary imports. Root TS config excludes `worker/`; runtime-neutral logic belongs in `shared/lib/`.
- Cron-backed hooks: `staleTime = producer interval`, `refetchInterval = 2x producer interval` (checked by `npm run check:hook-polling-window`).
- Worker fetches: Cloudflare caps six simultaneous requests waiting on response headers; Pharos enforces a stricter trigger-wide six-connection budget (`npm run check:cron-connections`) — consume bodies before opening more fetches (`docs/worker-and-api-limits.md#connection-budget-operating-assumption`).
- D1 migrations run before the new Worker is live; destructive cleanup is a separate coordinated rollout (`npm run check:migrations`).
- Data-integrity rules R1-R8 (unavailable is not zero; a failed read never becomes a positive claim; a freshness verdict names its budget and generation; non-`ok` names a machine-readable reason; one authority per cadence/threshold/vocabulary; provenance names what was read this run; never publish a display-capped or clamped value as a statistic; quarantine the bad asset and publish the rest) are ADR-28 to ADR-35 in `docs/architecture.md`.
- Long docs (notably `docs/api-reference.md`): use the top navigation block, then read only the matched section.

## Verify and ship

- Focused checks are authoring feedback, never readiness proof (`docs/testing.md#smallest-adequate-check-per-area`); an unmapped production path's zero-plan is a routing failure.
- Before every first or replacement push: follow [Pre-push readiness](docs/testing.md#pre-push-readiness), converge all generated artifacts after final source/integration history, then run full plain `npm run check:pr` on the final committed state, with no skip/filter/plan-only flags. Require a fresh passing `.tmp/pr-check-receipts/<HEAD>.json`; any subsequent edit/integration invalidates that proof.
- `npm run check:pr -- --ci-parity` is opt-in after a remote failure not reproduced locally, and for lockfile/setup/security-policy changes. Collect every failed CI leaf, fix all causal defects in one revision, rerun full readiness, then push once. `check:release` is only an explicit production rehearsal; GitHub Actions owns the release gate.
- Commit thematically with a descriptive subject and a why-focused body. The pre-commit hook is partial artifact sync, never a test gate or full convergence: eligible `autoStage` outputs only; it skips merge/rebase/cherry-pick/revert, an empty index, or `PHAROS_SKIP_ARTIFACT_HOOK=1` (`docs/scripts.md#operational-notes`). No pre-push test hook.
- Do not create a branch, worktree, or PR unless asked. A request to push/publish/release authorizes the protected-main PR path; never push `main` directly. Merge release PRs with `gh pr merge --merge`; never squash or rebase them.
- A green deploy is not runtime health: for cron, scheduler, memory, migration, or ingestion changes, observe the first production execution before claiming success.

## Generated context

`AGENTS.md` regenerates from this file (`npm run check:generated-artifacts -- --only=agents-doc`). `next dev` may rewrite the managed block below in `AGENTS.md`; copy it back here and regenerate before committing.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
