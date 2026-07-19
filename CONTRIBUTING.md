# Contributing To Pharos

Thanks for helping improve Pharos. This repo is public, but it is also a production data dashboard, so small, well-sourced changes are much easier to review and ship than broad rewrites.

## Good Contribution Lanes

- Data corrections with source links, affected stablecoin IDs, and the date you checked the source.
- Stablecoin metadata additions or coverage improvements that follow the existing registry schema.
- Documentation fixes, API examples, and methodology clarity improvements.
- Bug reports with the affected URL, expected behavior, actual behavior, and screenshots or response snippets when useful.
- Accessibility, performance, and UI quality fixes that preserve the current Pharos design language.

Feature ideas should usually start in [GitHub Discussions](https://github.com/TokenBrice/pharos-watch/discussions) so the methodology and maintenance cost can be settled before code is written.

## Before Editing

1. Read [docs/agent-task-router.md](./docs/agent-task-router.md) and follow the task family that matches your change.
2. Read any scoped `AGENTS.md` file under the directory you edit.
3. Keep the change narrow. Avoid unrelated refactors, generated churn, or formatting sweeps.
4. Update the matching docs when behavior, API contracts, methodology, data sources, or pipeline ownership changes.

Important project rules:

- Tailwind classes must be static strings.
- Runtime-shared imports should use `@shared/lib/...` and `@shared/types...`.
- Use `getCirculatingRaw()` from `shared/lib/supply.ts`.
- DefiLlama list-endpoint supply values are already USD-denominated; do not multiply them by price.
- Do not add manual, on-chain, CoinMarketCap, or DEX supply overrides.
- D1 migrations must be backward-compatible with the currently live Worker.

## Local Setup

```bash
nvm use
npm ci
npm run dev
```

Worker/API changes require Cloudflare Worker bindings and provider credentials. See [docs/worker-infrastructure.md](./docs/worker-infrastructure.md) and [.env.example](./.env.example).

## Checks

For narrow changes, run the focused check for the area you touched. Common commands:

```bash
npm run lint
npm run typecheck
npm run test
npm run check:generated-artifacts
```

GitHub's protected `PR gate` is the authoritative release check. For a large production-bound change, maintainers can collect local diagnostic evidence with:

```bash
MERGE_GATE_PRODUCTION_ENV=1 npm run test:merge-gate:discover -- --target=release
```

That target requires the exact `.nvmrc` runtime, a clean committed snapshot, and the intended Pages environment scoped to the rehearsal. It is intentionally broad, can be slow, and never replaces the protected PR gate. Use focused checks first when iterating; `npm run test:merge-gate` is an optional explicit local rehearsal.

`docs-metadata` and `sitemap-dates` calculate timestamps from committed source history. Commit relevant source changes first, regenerate those artifacts, then commit or amend their output. `npm run check:commit-derived-artifacts` verifies that settled state before the full generated-artifact check.

## Pull Requests

- Use a descriptive title and explain why the change is needed.
- Link related issues or discussions.
- Include source citations for data/methodology changes.
- Include screenshots for UI changes.
- Call out any skipped checks and why.

Do not include private API keys, raw verification tokens, requester emails, or operational secrets in issues, pull requests, screenshots, or logs.
