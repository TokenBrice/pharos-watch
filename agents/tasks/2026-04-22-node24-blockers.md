# Node 24 Compatibility Blockers - 2026-04-22

Owner: Codex
Source plan: `agents/plans/2026-04-22-full-audit-remediation-implementation-plan.md`

## Open blockers

| Blocker | Scope | Current impact | Closure trigger |
| --- | --- | --- | --- |
| `check-shared-cycles` uses `npx --yes madge ...` | `scripts/check-shared-cycles.mjs`, Node 24 CI lane | `npm run validate:lts` must skip `validate:prebuild` because npm 11 on Node 24 rejects this invocation with `EUSAGE` | replace the `npx --yes` shell-out with a Node 24-compatible invocation strategy and re-enable the skipped step in `validate:lts` |

## Notes

- The Node 24 proof lane is otherwise green for: root `lint`, root `typecheck`, full `build`, full `test`, `coverage:critical`, worker runtime `tsc`, worker script `tsc`, and worker migrations.
- The package engine floor remains `>=25 <26` until the blocker above is removed or explicitly superseded by a different validated runtime strategy.
