---
title: "Audit API correctness and consistency"
agent: "codex"
reasoning_effort: "high"
done: false
---

## Goal

Audit all API endpoints for correctness, consistency, and documentation alignment. Produce `FINDINGS-API.md` in the worktree root.

## Task

### Scope

All API handlers in `worker/src/api/`, the router at `worker/src/router.ts`, and documentation at `docs/api-reference.md`.

### What to check

1. **Router coverage**: Read `worker/src/router.ts` and list every registered route. Cross-reference with `docs/api-reference.md`. Flag:
   - Endpoints in the router but NOT in the docs (undocumented)
   - Endpoints in the docs but NOT in the router (phantom docs)

2. **Response shape consistency**: For each API handler, check:
   - Does it always return JSON with `Content-Type: application/json`?
   - Does it return consistent shapes for success vs error? (e.g., `{ data: ... }` vs `{ error: ... }`)
   - Does the actual response shape match what `docs/api-reference.md` describes?

3. **Error handling**: For each handler:
   - Does it catch errors and return appropriate HTTP status codes (400, 404, 500)?
   - Does it handle missing/invalid query parameters gracefully?
   - Does it handle missing database data (empty result sets)?
   - Are error responses structured consistently (e.g., `{ error: "message" }`)?

4. **Input validation**: For handlers that accept query parameters or path params:
   - Are parameters validated (type, range, format)?
   - What happens with unexpected parameters?
   - What happens with very large values (e.g., `?limit=999999`)?

5. **Cache headers**: Check which endpoints set cache headers (`Cache-Control`, `CDN-Cache-Control`). Flag:
   - Endpoints serving stale-tolerant data without cache headers
   - Endpoints serving real-time data with overly aggressive caching
   - Inconsistent cache durations for similar endpoint types

6. **CORS handling**: Check `worker/src/router.ts` for CORS configuration. Verify:
   - Allowed origins are appropriate (not `*` in production unless intentional)
   - Preflight (OPTIONS) requests are handled
   - Credentials handling is correct

7. **Admin/backfill endpoints**: Check all `/api/backfill-*` and admin-only endpoints:
   - Are they properly guarded with auth (`worker/src/lib/auth.ts`)?
   - Could they be accessed without authentication?

8. **Live probes** (attempt these):
   ```bash
   # Basic endpoint check
   curl -s -o /dev/null -w '%{http_code}' https://api.pharos.watch/api/stablecoins
   curl -s -o /dev/null -w '%{http_code}' https://api.pharos.watch/api/peg-summary
   curl -s -o /dev/null -w '%{http_code}' https://api.pharos.watch/api/stablecoin/usdt-tether
   curl -s -o /dev/null -w '%{http_code}' https://api.pharos.watch/api/nonexistent

   # Check error shape
   curl -s https://api.pharos.watch/api/stablecoin/nonexistent-coin-xyz

   # Check cache headers
   curl -sI https://api.pharos.watch/api/stablecoins | grep -i cache

   # Check CORS
   curl -sI -H "Origin: https://pharos.watch" https://api.pharos.watch/api/stablecoins | grep -i 'access-control'
   ```
   If curl is unavailable, note "Live probes not executed" and continue with code-level findings.

### Files to examine

- `worker/src/router.ts` (all route definitions)
- `worker/src/api/*.ts` (all ~45 handlers, excluding `__tests__/`)
- `worker/src/api/stablecoin-detail/*.ts` (detail sub-handlers)
- `worker/src/lib/auth.ts` (auth middleware)
- `worker/src/lib/api-utils.ts` (shared utilities)
- `docs/api-reference.md` (documented contract)

### Output format

Write `FINDINGS-API.md` in the worktree root:

```markdown
# FINDINGS: API Correctness

## Summary
- X endpoints examined
- Y findings (A critical, B high, C medium, D low)
- Live probes: executed / not executed

## Endpoint Inventory
(table of all routes from router with: method, path, handler file, documented Y/N)

#### Critical
(findings or "None")

#### High
(findings)

#### Medium
(findings)

#### Low
(findings)

## Live Probe Results
(output or "Not executed")

## Files Examined
(list)
```

Each finding:
```
- [API-NNN] **Title** — Description. Endpoint: `METHOD /api/path`. File: `path:line`. Issue and fix. `[~effort]`
```

## Acceptance Criteria

- `FINDINGS-API.md` exists in the worktree root
- File contains the endpoint inventory table
- File contains all four severity sections
- Every finding has an `[API-NNN]` ID, endpoint reference, and effort tag
- Summary counts match actual findings
