# TypeScript 6 / ESLint 10 Upgrade Lane

Date: 2026-04-20

Related finding: `S-07` from `agents/audits/2026-04-20-multi-agent-codebase-audit.md`

## Scope

Track the major toolchain upgrades separately from functional remediation:

- `typescript` 5.9.x -> 6.x
- `eslint` 9.x -> 10.x

## Risks To Validate

- Next.js 16 compatibility with TypeScript 6 and ESLint 10.
- `eslint-config-next` peer support for ESLint 10.
- Existing React Compiler warning overrides in `eslint.config.mjs`.
- Worker and root TypeScript config behavior, especially D1/Workers type isolation.
- Node 25 CI cache behavior for `*.tsbuildinfo`.

## Proposed Validation

- `npm install` with the candidate versions on a dedicated branch.
- `npm run lint`
- `npm run typecheck`
- `cd worker && npx tsc --noEmit`
- `cd worker && npx tsc --noEmit -p tsconfig.scripts.json`
- `npm test`
- `npm run build`
- `npm run test:merge-gate`

## Rollback

Revert `package.json` and `package-lock.json` to the previous known-good versions if peer compatibility, lint rules, or compiler behavior require larger source changes.
