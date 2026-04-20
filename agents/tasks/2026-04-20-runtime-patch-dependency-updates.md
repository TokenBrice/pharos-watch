# Runtime Patch Dependency Update Lane

Date: 2026-04-20

Related finding: `S-07` from `agents/audits/2026-04-20-multi-agent-codebase-audit.md`

## Scope

Patch/minor drift observed during the audit should be handled separately from TypeScript/Eslint major upgrades:

- `@cloudflare/workers-types`
- `@tanstack/react-query`
- `@tanstack/react-virtual`
- `viem`

## Proposed Validation

- `npm outdated --json || true` before and after update, with output reviewed.
- `npm install` for selected patch/minor versions.
- `npm run validate:prebuild`
- `npm test`
- `npm run coverage:critical`
- `cd worker && npx tsc --noEmit`
- `cd worker && npx tsc --noEmit -p tsconfig.scripts.json`
- `npm run build`
- `npm run seo:check`
- `npm run test:merge-gate`

## Notes

Do not combine these updates with TypeScript 6 or ESLint 10. Runtime package updates should stay small enough to bisect cleanly if a hook, Worker type, or EVM client behavior changes.
