# Stablecoin Dashboard (Pharos)

Stablecoin analytics dashboard. Static Next.js 16 export to Cloudflare Pages. API: Cloudflare Worker + D1.

Live: https://pharos.watch
Local dev-server: http://localhost:3000/

This file is mirrored to `CLAUDE.md`. Durable process guidance belongs in `/docs/process/` or the nearest verified doc.

## Start Here

- For non-trivial edits, classify the task with `docs/agent-task-router.md`, read only the matched docs, then inspect source entrypoints and local imports.
- Follow scoped `AGENTS.md` files under `src/`, `shared/`, `functions/`, `worker/`, and `shared/data/stablecoins/` when editing there.
- Treat `/docs/` and `README.md` as the verified documentation corpus.
- Use `/agents/` only for ignored scratch notes, research, screenshots, and handoffs.

## Working Rules

- State assumptions for non-trivial work; ask only when ambiguity blocks a safe choice.
- Prefer the smallest root-cause fix. Match existing style and avoid unrelated refactors.
- Preserve existing product and design-system patterns unless explicitly asked for a redesign.
- Update matching docs for behavior, API, pipeline, methodology, or data-source changes; new data sources also update the about page.
- Methodology changes update `/methodology` plus the relevant timeline/changelog doc. Versions increase numerically: after `v5.9`, use `v5.91` or `v6.0`, not `v5.10`.
- When committing, use a descriptive and informative subject plus a useful body that explains what changed and why. Group pending work into logical/thematic commits; avoid empty, generic, or placeholder commit messages.
- Do not create a branch, worktree, or PR unless explicitly asked. Before pushing, run focused checks; GitHub Actions owns the authoritative release gate, while the repo pre-push hook only runs the heavy local merge gate when explicitly opted in with `PHAROS_PRE_PUSH_GATE=main` or `PHAROS_PRE_PUSH_GATE=all`.

## Hard Rules

The *why* behind these locked decisions lives in the [Architectural Decision Records](docs/architecture.md#architectural-decision-records).

- Tailwind classes must be static strings.
- Classification labels/colors live in `shared/lib/classification.ts`.
- Use `getCirculatingRaw()` from `shared/lib/supply.ts`; DefiLlama list `circulating` values are already USD-denominated.
- Do not multiply DefiLlama list-endpoint supply values by price.
- Do not add manual/on-chain/CMC/DEX supply overrides.
- Use `@shared/lib/...` and `@shared/types...` for shared runtime imports; avoid relative cross-boundary imports.
- Root TS config excludes `worker/`; runtime-neutral shared logic belongs in `shared/lib/`.
- Cron-backed hooks normally use `staleTime = producer interval` and `refetchInterval = 2x producer interval`.
- Worker cron jobs share Cloudflare's per-trigger 6-connection pool; consume response bodies before opening more fetches.
- D1 migrations run before the new Worker is live; destructive cleanup needs a separate coordinated rollout.
- Docs over ~1,500 lines (notably `docs/api-reference.md`): use the top navigation block, then Grep or offset-read only the matched section — never read wholesale.
