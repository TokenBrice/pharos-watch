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
- Scratch lives in ignored `agents/`; durable guidance in `docs/` (`docs/process/agent-artifacts.md`).
- Update the owning doc for behavior, API, pipeline, methodology, or data-source changes (new sources also update the about page). Methodology changes update every ADR-3 target in `docs/architecture.md`; versions increase numerically (`v5.9` → `v5.91` or `v6.0`, never `v5.10`).

## Hard rules

- Tailwind classes must be static strings. Classification labels/colors live only in `shared/lib/classification.ts`.
- Supply: `getCirculatingRaw()` from `shared/lib/supply.ts`; DefiLlama list `circulating` is already USD — never multiply by price, never replace it with manual/on-chain/CMC/DEX values (supplemental paths: explicit, documented, fail-closed, double-count safe).
- Imports: `@shared/lib/...` / `@shared/types...`, no relative cross-boundary imports. Root TS config excludes `worker/`; runtime-neutral logic belongs in `shared/lib/`.
- Cron-backed hooks: `staleTime = producer interval`, `refetchInterval = 2x producer interval` (checked by `npm run check:hook-polling-window`).
- Worker fetches: Cloudflare caps six simultaneous requests waiting on response headers; Pharos enforces a stricter trigger-wide six-connection budget (`npm run check:cron-connections`) — consume bodies before opening more fetches (`docs/worker-and-api-limits.md#connection-budget-operating-assumption`).
- D1 migrations run before the new Worker is live; destructive cleanup is a separate coordinated rollout (`npm run check:migrations`).
- Long docs (notably `docs/api-reference.md`): use the top navigation block, then read only the matched section.

## Verify and ship

- Run the smallest adequate checks for the touched area: `docs/testing.md#smallest-adequate-check-per-area`. Larger committed batches: `npm run check:pr -- --base=<ref>`; `npm run check:release` only for an explicit production-build rehearsal. GitHub Actions owns the release gate.
- Commit thematically with a descriptive subject and a why-focused body. The pre-commit hook regenerates and stages affected registered artifacts.
- Do not create a branch, worktree, or PR unless asked. A request to push/publish/release authorizes the protected-main PR path; never push `main` directly.
- A green deploy is not runtime health: for cron, scheduler, memory, migration, or ingestion changes, observe the first production execution before claiming success.

## Generated context

`AGENTS.md` regenerates from this file (`npm run check:generated-artifacts -- --only=agents-doc`). `next dev` may rewrite the managed block below in `AGENTS.md`; copy it back here and regenerate before committing.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
