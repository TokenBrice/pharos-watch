# Local Temp Cleanup Audit - 2026-04-20

## Scope

Assumptions:

- Tracked files, local env files, registered worktrees, and local tool state are not cleanup targets.
- Ignored files are not automatically safe; this repo intentionally ignores secrets, local databases, and tool settings.
- The current `npm run dev` / `next dev` process is user-owned and should not be disrupted.

Success criteria:

- Identify broad ignored/untracked temp candidates.
- Delete only allowlisted artifacts that are generated, stale, or explicitly one-time local artifacts.
- Preserve local config, secrets, worktrees, and stateful tool directories.
- Verify the source tree still passes relevant lint/typecheck/test checks.

## Deleted

| Path | Size before cleanup | Reason |
| --- | ---: | --- |
| `.cache/` | 872K | ESLint cache. Recreated by lint when cache mode is used. |
| `coverage/` | 34M | Vitest/V8 coverage output. Recreated by coverage commands. |
| `out/` | 157M | Next static export output. Recreated by `npm run build`. |
| `output/playwright/` plus empty `output/` | 3.2M | Old Playwright research screenshots/logs; no production references found. |
| `.playwright-cli/` | 5.9M | Playwright CLI logs, YAML snapshots, screenshots. |
| `.playwright-mcp/` | 1.1M | Playwright MCP logs and snapshots. |
| `worker/.wrangler/tmp/` | 15M | Stale Wrangler temp bundles. Preserved `worker/.wrangler/state/`. |
| `tsconfig.tsbuildinfo` | 496K | TypeScript incremental cache. |
| `tsconfig.typecheck.tsbuildinfo` | 328K | TypeScript incremental cache. Recreated during validation, then removed again. |
| `worker/tsconfig.tsbuildinfo` | 392K | Worker TypeScript incremental cache. Recreated during validation, then removed again. |
| `worker/tsconfig.scripts.tsbuildinfo` | 464K | Worker scripts TypeScript incremental cache. |
| `worker/tsconfig.worker-scripts.tmp.600148.tsbuildinfo` | 456K | Orphan temporary TypeScript build info file; no references found. |
| `worker/d1-backup-pre-migration.sql` | 938M | Old one-time local D1 SQL export from the March migration window, ignored by `worker/d1-backup-*.sql` and not referenced by runtime code. Tradeoff: this removes the exact local March 6 pre-migration export. |

Approximate removed disk usage: 1.16G excluding directory block overhead.

## Preserved

| Path | Reason |
| --- | --- |
| `.next/` | Disposable but currently active: `npm run dev` / `next dev` has been running since 2026-04-20 09:53 and is using `.next/dev`. Safe candidate after that process is stopped. |
| `node_modules/`, `worker/node_modules/` | Reinstallable, but removing would immediately break local commands until `npm ci`; not treated as temp cleanup. |
| `.env.local`, `worker/.dev.vars` | Local env/secrets. |
| `.worktrees/` | Registered Git worktrees: `cf-compat-date` and `cf-waf-rule`. |
| `.claude/settings.local.json` | Local tool permissions/settings. |
| `.cmcs/`, `.codex`, `.codex-autorunner/`, `.superpowers/` | Local tool state/config/databases; not repo build output. |
| `worker/.wrangler/state/` | Miniflare/Wrangler local cache and D1 state; not safe for broad cleanup. |
| `src/generated/docs-metadata.json`, `src/generated/sitemap-dates.json` | Ignored generated JSON, but imported by current app code and needed for dev/build unless regenerated. Tiny files, so no cleanup value. |
| `next-env.d.ts` | Next-generated, but included by TypeScript configs; deleting can break typecheck until Next regenerates it. |
| `agents/research/2026-04-20-usdsui-live-reserve-path.md` | Untracked but not ignored; appears to be hand-authored agent research, not temp output. |

## Verification

Read/checked:

- `.gitignore`
- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/testing.md`
- `docs/worker-and-api-limits.md`
- package scripts and TypeScript configs
- references to generated files, Playwright output, `out/`, coverage, tsbuildinfo files, and the D1 backup
- `git worktree list --porcelain`
- active processes for Next/Wrangler/Playwright/Vitest/TypeScript

Commands run after cleanup:

```bash
npx tsc --noEmit --incremental false -p tsconfig.typecheck.json
npx tsc --noEmit --incremental false
npx tsc --noEmit --incremental false -p tsconfig.scripts.json
npm test -- --run
npx eslint . --max-warnings=0
```

Results:

- Root typecheck passed.
- Worker typecheck passed.
- Worker scripts typecheck passed.
- Vitest passed: 564 files, 5540 tests.
- ESLint passed.

Note: `npm run lint -- --no-cache` was attempted first, but ESLint rejected the combination because the npm script also supplies cache-specific flags. Direct `npx eslint . --max-warnings=0` was used for the no-cache lint validation.

