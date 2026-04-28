# Node 24 Compatibility Blockers - 2026-04-22

Owner: Codex
Source plan: `agents/plans/2026-04-22-full-audit-remediation-implementation-plan.md`
Status: Closed by Phase 10 of `agents/plans/2026-04-28-audit-remediation-implementation-plan.md`.

## Closed blockers

| Blocker | Scope | Current impact | Closure trigger |
| --- | --- | --- | --- |
| `check-shared-cycles` uses `npx --yes madge ...` | `scripts/check-shared-cycles.mjs`, former Node 24 proof lane | Resolved. Node 24 is now the primary baseline; `validate:lts` was removed as duplicate coverage, and `npm run test:merge-gate` passed under Node 24. | Closed in `570a279dd` after the shared validate path ran successfully on Node 24. |

## Notes

- Root and worker `package.json` now declare `>=24 <25`, `.nvmrc` is `24`, and GitHub Actions validate/deploy jobs install Node 24.
- `scripts/run-node-lts-validation.mjs` and `npm run validate:lts` were removed because the LTS lane no longer proves a distinct contract.
- The validated replacement is the standard Node 24 merge/deploy path: `npm run validate:prebuild`, Pages build/SEO, noncritical tests, critical coverage, worker runtime typecheck, and worker script typecheck all passed through `npm run test:merge-gate`.
