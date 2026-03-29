# 2026-03-29 Worker Preview Release Plan

## Goal

Prevent a bad Worker build from reaching `api.pharos.watch` before API smoke runs.

## Approach

1. Keep the existing validate gate and backward-compatible D1 migration step.
2. Replace the direct production `wrangler deploy` step with:
   - `wrangler versions upload` for the candidate Worker version
   - API smoke against the returned preview URL
   - `wrangler versions deploy <version-id>@100`
   - `wrangler triggers deploy` after promotion
3. Preserve post-promotion smoke as a rollback guard for production.
4. Update deployment and testing docs so the repo documents the new release contract.

## Constraints

- Use the exact uploaded Worker version for promotion; do not rebuild a second artifact between preview smoke and production cutover.
- Keep D1 migration ordering explicit. The repo already requires backward-compatible migrations because schema changes can land before traffic moves.
- Avoid adding a separate Worker environment that would require duplicated secrets and config drift management.

## Validation

- Check workflow YAML for syntax-valid structure.
- Verify local helper scripts used by CI.
- Run targeted repo checks for docs/workflow/script changes where feasible.
