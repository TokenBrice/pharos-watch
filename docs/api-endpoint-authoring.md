# API Endpoint Authoring

Use this checklist when adding or changing a Worker API endpoint. The route registry is intentionally centralized; do not hand-roll endpoint metadata in local components or scripts.

## Source Of Truth

| Concern | Source |
| --- | --- |
| Path builders | `shared/lib/api-endpoints/paths.ts` |
| Endpoint metadata, methods, auth/cache/site-data flags | `shared/lib/api-endpoints/definitions.ts` |
| Method validation helpers | `shared/lib/api-endpoints/validation.ts` |
| Worker route registry | `worker/src/routes/registry.ts` |
| Public route bindings | `worker/src/routes/public-routes.ts` |
| Admin route bindings | `worker/src/routes/admin-routes.ts` |
| Messaging and ops route bindings | `worker/src/routes/messaging-routes.ts`, `worker/src/routes/ops-routes.ts` |
| Dynamic route bindings | `worker/src/routes/dynamic-routes.ts` |
| Frontend API helpers | `src/hooks/api-hooks.ts`, `src/hooks/use-api-query.ts`, `src/lib/api.ts` |
| Public contract | `docs/api-reference.md` |

## Implementation Checklist

1. Add or update a path helper in `shared/lib/api-endpoints/paths.ts`.
2. Add an endpoint definition in `shared/lib/api-endpoints/definitions.ts` with the correct base metadata: method set, `adminRequired`, `mutatingAdmin`, `cacheBypass`, probe metadata, dependency hints, and status-page action metadata. `publicApiAccess` and `siteDataAccess` default from that base metadata: non-admin routes are public-API protected, admin routes are public-API exempt, and non-admin `GET` routes are allowed on the website-data lane. Set `publicApiAccess` or `siteDataAccess` on the endpoint definition only when an endpoint needs to override those defaults.
3. Bind the endpoint key to a handler in the appropriate `worker/src/routes/*-routes.ts` file, or add a dynamic route only when the path family cannot be represented as a static endpoint.
4. Keep handler code under `worker/src/api/` and return through shared response helpers (`jsonResponse`, `errorResponse`, cache helpers) so status codes, CORS, and freshness behavior remain consistent.
5. If the endpoint reads cache data, decide whether it should emit `_meta`, `X-Data-Age`, and `Warning` through `createCacheHandler()` or route-specific freshness injection.
6. If the frontend consumes the endpoint, add a typed hook and schema validation where nested response data is accessed. For cron-backed data, default to `staleTime = producer interval` and `refetchInterval = 2x producer interval`; document intentional exceptions such as health/status probes or faster UI polling over slow snapshots.
7. Update `docs/api-reference.md` with methods, auth lane, parameters, cache profile, response shape, and error bodies.
8. Add or update handler tests in `worker/src/api/__tests__/`. For critical endpoints, include the relevant suite in `npm run test:critical-contracts` only when it belongs on the critical path.

## Auth And Lanes

- External integrations call `https://api.pharos.watch` and need `X-API-Key` unless the endpoint is explicitly exempt.
- Website browser reads should go through same-origin `/_site-data/*`, backed by `site-api.pharos.watch` and `X-Pharos-Site-Proxy-Secret`.
- Admin routes live on `ops-api.pharos.watch` or the same-origin `ops.pharos.watch/api/admin/*` Pages proxy after Cloudflare Access authentication.
- Mutating admin handlers must require `X-Pharos-Admin: 1`; idempotent mutations should use the existing idempotency wrappers.

## Validation Commands

Run the focused checks for route metadata changes:

```bash
npm run check:doc-sync
npm run check:doc-source-paths
npm run check:verified-doc-links
npm run test:critical-contracts
```

For worker behavior changes, also run:

```bash
cd worker && npx tsc --noEmit
```

Before pushing deploy-impacting endpoint changes, run:

```bash
npm run test:merge-gate
```
