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

GitHub's protected `PR gate` is the authoritative release check. For a committed production-bound change, maintainers can run the adaptive local contract with:

```bash
npm run check:pr -- --base=origin/main
```

Use `npm run check:release` only when a local Pages build and Worker bundle rehearsal is useful. Neither command replaces the protected PR gate.

`docs-metadata` and `sitemap-dates` are gitignored build-time artifacts derived from commit history. `npm install` materializes them locally; CI jobs that need them opt in through the `bootstrap-history` input on `setup-workspace`.

## Pull Requests

- Use a descriptive title and explain why the change is needed.
- Link related issues or discussions.
- Include source citations for data/methodology changes.
- Include screenshots for UI changes.
- Call out any skipped checks and why.

Do not include private API keys, raw verification tokens, requester emails, or operational secrets in issues, pull requests, screenshots, or logs.
