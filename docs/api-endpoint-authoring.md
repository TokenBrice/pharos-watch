# API Endpoint Authoring

Use this checklist when adding or changing a Worker API endpoint. The route registry is intentionally centralized; do not hand-roll endpoint metadata in local components or scripts. Treat `docs/api-reference.md` as exhaustive contract output: read and edit the affected endpoint section instead of loading or rewriting the whole file when the change is narrow.

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
| Frontend API query descriptors | `src/lib/api-query-descriptors.ts` is the single declaration table for public-frontend paths, query keys, polling/freshness policy, response mode, and cached lazy schema loaders; admin surfaces use the twin table `src/lib/admin-api-query-descriptors.ts`, which carries no `responseMode` and polls on the generic one-minute ops budget. Runtime hooks and homepage bootstrap consumers import that table directly. `src/hooks/api-hooks.ts` derives plain-versus-meta execution from each descriptor's `responseMode`; homepage bootstrap generation resolves the same lazy schema source. |
| Public contract | `docs/api-reference.md` affected endpoint section |
| Public OpenAPI/Postman artifact metadata | `scripts/lib/public-api-artifact-catalog.ts` |

The root `RegimeBar` is a deliberate global-shell exception: `useStabilityIndexLight()` imports the stability domain descriptor directly and validates only the PSI fields it renders with a small pass-through contract. This keeps the classic Zod stability schema out of the all-route client graph while preserving the full payload in the shared TanStack cache. The `/stability-index/` detail query retains the full lazy schema.

## Implementation Checklist

1. Add or update a path helper in `shared/lib/api-endpoints/paths.ts`.
2. Add an endpoint definition in `shared/lib/api-endpoints/definitions.ts` with the correct base metadata: method set, `adminRequired`, `mutatingAdmin`, `cacheBypass`, probe metadata, dependency hints, and status-page action metadata. Factory defaults differ by surface: public `GET` routes are public-API protected and website-data allowed; public `POST` routes are public-API exempt, website-data denied, and cache-bypassed; admin routes are public-API exempt and website-data denied. Set `publicApiAccess` or `siteDataAccess` only when the endpoint deliberately overrides its factory default.
3. Bind the endpoint key to a handler in the appropriate `worker/src/routes/*-routes.ts` file, or add a dynamic route only when the path family cannot be represented as a static endpoint.
4. Keep handler code under `worker/src/api/` and return through shared response helpers (`jsonResponse`, `errorResponse`, cache helpers) so status codes, CORS, and freshness behavior remain consistent.
5. If the endpoint reads cache data, decide whether it should emit `_meta`, `X-Data-Age`, and `Warning` through `createCacheHandler()` or route-specific freshness injection.
6. If the public frontend consumes the endpoint, add one typed entry to `FRONTEND_API_QUERY_DESCRIPTORS` and retain a narrow public hook when call-site ergonomics require one. Admin/ops surfaces instead get one entry in `ADMIN_API_QUERY_DESCRIPTORS` (`src/lib/admin-api-query-descriptors.ts`), bound by a one-line `useRegisteredAdminQuery()` hook; that table has no `responseMode`, keeps schemas eager, and polls on the generic one-minute ops budget. Choose `responseMode` (`plain`, `meta`, or `static`) in the frontend descriptor; the hook/query-option wrappers derive transport behavior from it. Keep response schemas behind `createLazySchema()` except for deliberately small global-shell validators. For cron-backed data, default to `staleTime = producer interval` and `refetchInterval = 2x producer interval`; document intentional exceptions such as health/status probes or faster UI polling over slow snapshots.
7. Update `docs/api-reference.md` with methods, auth lane, parameters, cache profile, response shape, and error bodies.
8. If the endpoint is an integration-facing public `GET` route, add or update `scripts/lib/public-api-artifact-catalog.ts` so OpenAPI and Postman exports stay aligned with the runtime route metadata.
9. Add or update handler tests in `worker/src/api/__tests__/`. For critical endpoints, include the relevant suite in `npm run test:critical-contracts` only when it belongs on the critical path. Declare a frontend-critical route by setting `strictContract: true` on its definition in `shared/lib/api-endpoints/definitions.ts`; that enrolls the path in the broad router sweep in `worker/src/api/__tests__/router-contract.test.ts`, which asserts every strict path still resolves to a route and returns neither 404 nor 500. The sweep guards registration and routability only: it does not check payload shape, auth lane, or freshness, and cache-backed snapshot paths listed in that suite's `REGISTRATION_ONLY_PATHS` are asserted to stay statically registered without being invoked, because their handlers have dedicated tests.

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
npm run check:generated-artifacts
npm run test:critical-contracts
```

For worker behavior changes, also run:

```bash
npm run typecheck:worker
```

Before pushing deploy-impacting endpoint changes, run:

```bash
npm run check:pr -- --base=origin/main
```
