# WS-8 / PR-15 Env-Contract Centralization

## Scope

- `.env.example`
- `worker/src/lib/env.ts`
- `functions/lib/ops-env.ts`
- `functions/lib/site-api-env.ts`
- `scripts/check-env-contract.mjs`
- shared runtime-neutral env manifest module(s)
- env-contract-specific docs snippets/views only when manifest-derived
- env-contract-specific tests/checks only

## Success Criteria

- One shared typed manifest is the source of truth for env binding keys.
- Worker and Pages runtime key groups are derived from that manifest.
- `.env.example` is mechanically derived from the manifest or the check fails on drift.
- Env-focused docs snippets/views touched in this slice are mechanically derived from the manifest or the check fails on drift.
- Runtime validation behavior and error messages stay stable.

## Implementation Plan

1. Add a shared runtime-neutral env manifest with per-binding runtime status and docs/example metadata.
2. Refactor worker and Pages env modules to derive required/optional/reserved/active views from the shared manifest.
3. Update the env-contract check to compare `.env.example` and selected env-doc blocks against manifest-generated output.
4. Update targeted env tests and run focused validation (`check:env-contract`, env tests, lint/typecheck on touched files if needed).
