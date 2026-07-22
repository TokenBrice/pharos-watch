# Stablecoin Dashboard (Pharos)

Stablecoin analytics dashboard. Static Next.js 16 export to Cloudflare Pages. API: Cloudflare Worker + D1.

Live: https://pharos.watch
Local dev-server: http://localhost:3000/

This file is mirrored to `AGENTS.md`. Durable process guidance belongs in `/docs/process/` or the nearest verified doc.

## Start Here

- For non-trivial edits, classify the task with `docs/agent-task-router.md`, read only the matched docs, then inspect source entrypoints and local imports.
- Follow scoped `AGENTS.md` files under `src/`, `shared/`, `functions/`, `worker/`, and `shared/data/stablecoins/` when editing there.
- Treat `/docs/` and `README.md` as the verified documentation corpus.
- Use `/agents/` only for ignored scratch notes, research, screenshots, and handoffs.

## Working Rules

- State assumptions for non-trivial work; ask only when ambiguity blocks a safe choice.
- Prefer the smallest root-cause fix. Match existing style and avoid unrelated refactors.
- Pharos intentionally has no canonical formatter. Preserve existing layout, match nearby style, avoid formatting-only churn, and use `git diff --check`; generated artifacts retain generator-owned formatting. Do not add or run an ad hoc formatter without an explicit repository-wide migration decision. See `docs/testing.md#source-formatting-policy`.
- Preserve existing product and design-system patterns unless explicitly asked for a redesign.
- Before reporting a required local credential as missing, check the ignored root `.env.local` and the command's documented environment source. Report presence or absence by variable name only; never print, copy, or log secret values. Production Worker secrets remain Cloudflare/Wrangler-managed and must not be copied into local files.
- Update matching docs for behavior, API, pipeline, methodology, or data-source changes; new data sources also update the about page.
- Methodology changes update `/methodology`, the owning methodology doc, and the structured entry under `shared/data/methodology-changelogs/`. Versions increase numerically: after `v5.9`, use `v5.91` or `v6.0`, not `v5.10`.
- When committing, use a descriptive and informative subject plus a useful body that explains what changed and why. Group pending work into logical/thematic commits; avoid empty, generic, or placeholder commit messages.
- Do not create a branch, worktree, or PR unless explicitly asked. A request to push, publish, release, or take work to production authorizes the required protected-main branch/PR path; never attempt a direct `main` push or stop only to re-ask about that required mechanism.
- Before pushing, run focused checks. GitHub Actions owns the authoritative release gate; the pre-push hook checks commit-derived artifacts when the pushed commit is checked out, allowing unrelated dirty work but rejecting dirty relevant inputs/outputs. The heavy local merge gate runs only with `PHAROS_PRE_PUSH_GATE=main` or `PHAROS_PRE_PUSH_GATE=all`.
- `docs-metadata` and `sitemap-dates` depend on source Git history. Commit their relevant source changes first, regenerate them, then commit or amend the generated output and run the full generated-artifact check from the final clean commit stack.
- For large batches, run `npm run test:merge-gate:discover -- --target=<pr|local-gate|release|maintenance>`, read its final summary and ignored JSON report, then use focused reruns or `--resume` for blocked nodes. Discovery is diagnostic evidence, never a release receipt; use `--target=release` only with the exact `.nvmrc` runtime, a clean production-bound snapshot, and command-scoped production Pages environment rather than globally exported CI lane variables.
- A green deploy proves Worker activation and/or a Pages release marker, not runtime health. For cron, scheduler, memory, migration, or ingestion-risk changes, observe the first relevant production execution before claiming operational success.

## Hard Rules

The _why_ behind these locked decisions lives in the [Architectural Decision Records](docs/architecture.md#architectural-decision-records).

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
