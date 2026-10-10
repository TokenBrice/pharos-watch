# API Endpoint Authoring

Use this checklist when adding or changing a Worker API endpoint. The route registry is centralized; do not hand-roll endpoint metadata. Read the affected `docs/api-reference.md` section; its `public-endpoints` block is generated, not hand-authored.

For the public `/api/` access and `/about/api/` reference shells, see [API Access And Reference Pages](./api-page.md).

## Source Of Truth

| Concern | Source |
| --- | --- |
| Path builders | `shared/lib/api-endpoints/paths.ts` |
| Endpoint metadata, methods, auth/cache/site-data flags | `shared/lib/api-endpoints/definitions.ts` |
| Dynamic path families, methods and auth/site-data flags | `shared/lib/api-endpoints/dynamic.ts` |
| Method validation helpers | `shared/lib/api-endpoints/validation.ts` |
| Worker route registry | `worker/src/routes/registry.ts` |
| Public route bindings | `worker/src/routes/public-routes.ts` |
| Admin route bindings | `worker/src/routes/admin-routes.ts` |
| Messaging and ops route bindings | `worker/src/routes/messaging-routes.ts`, `worker/src/routes/ops-routes.ts` |
| Dynamic route bindings | `worker/src/routes/dynamic-routes.ts` |
| Frontend API helpers | `src/hooks/api-hooks.ts`, `src/hooks/use-api-query.ts`, `src/lib/api.ts` |
| Frontend API query descriptors | `src/lib/api-query-descriptors.ts` is the single declaration table for public-frontend paths, query keys, polling/freshness policy, response mode, and cached lazy schema loaders; admin surfaces use the twin table `src/lib/admin-api-query-descriptors.ts`, which carries no `responseMode` and polls on the generic one-minute ops budget. `src/hooks/api-hooks.ts` derives plain-versus-meta execution from each descriptor's `responseMode`. |
| Public contract | `docs/api-reference.md` affected endpoint section |
| Public OpenAPI/Postman artifact metadata | `scripts/lib/public-api-artifact-catalog.ts` |
| Public response wire schemas | `scripts/lib/public-api-response-schemas.ts` composes body contracts with typed freshness from `shared/types/api-meta.ts`; map responses reserve `_meta` separately from asset values. Frontend schemas validate after metadata extraction in `src/lib/api.ts`. |

Use the shared definitions and dynamic descriptors for endpoint inventories, path builders for construction, and Worker bindings for dispatch. The [Worker appendix](./process/worker-infrastructure-appendix.md#http-request-handling) retains CORS, auth, maintenance and action-lifecycle semantics, not a second endpoint inventory.

The root `RegimeBar` uses the registered `useStabilityIndex()` query, whose descriptor points to the small stability-domain contract that validates only the PSI fields it renders. This keeps the classic Zod stability schema out of the all-route client graph while preserving the full payload in the shared TanStack cache. The `/stability-index/` detail query retains the full lazy schema.

## Implementation Checklist

1. Add or update a path helper in `shared/lib/api-endpoints/paths.ts`.
2. Add an endpoint definition in `shared/lib/api-endpoints/definitions.ts` with the correct base metadata: method set, `adminRequired`, `mutatingAdmin`, `cacheBypass`, probe metadata, dependency hints, and status-page action metadata. Factory defaults differ by surface: public `GET` routes are public-API protected and website-data allowed; public `POST` routes are public-API exempt, website-data denied, and cache-bypassed; admin routes are public-API exempt and website-data denied. Set `publicApiAccess` or `siteDataAccess` only when the endpoint deliberately overrides its factory default.
3. Bind the endpoint key to a handler in the appropriate `worker/src/routes/*-routes.ts` file, or add a dynamic route only when the path family cannot be represented as a static endpoint.
4. Keep handler code under `worker/src/api/` and return through shared response helpers (`jsonResponse`, `errorResponse`, cache helpers) so status codes, CORS, and freshness behavior remain consistent.
5. If the endpoint reads cache data, decide whether it should emit `_meta`, `X-Data-Age`, and `Warning` through `createCacheHandler()` or route-specific freshness injection.
6. If the public frontend consumes the endpoint, add one typed entry to `FRONTEND_API_QUERY_DESCRIPTORS` and retain a narrow public hook when call-site ergonomics require one. Admin/ops surfaces instead get one entry in `ADMIN_API_QUERY_DESCRIPTORS` (`src/lib/admin-api-query-descriptors.ts`), bound by a one-line `useRegisteredAdminQuery()` hook; that table has no `responseMode`, keeps schemas eager, and polls on the generic one-minute ops budget. Choose `responseMode` (`plain`, `meta`, or `static`) in the frontend descriptor; the hook/query-option wrappers derive transport behavior from it. Keep response schemas behind `createLazySchema()` except for deliberately small global-shell validators. For cron-backed data, default to `staleTime = producer interval` and `refetchInterval = 2x producer interval`; document intentional exceptions such as health/status probes or faster UI polling over slow snapshots.
7. For public integration endpoints, update `scripts/maintenance/generate-api-reference.ts` route/order metadata and the artifact catalogue below, then regenerate the `public-endpoints` block; never edit it by hand. Edit only applicable hand-authored contract sections in `docs/api-reference.md`. Internal site-only transports belong in `docs/worker-infrastructure.md`; admin contracts belong in `docs/api-reference-admin.md`.
8. For integration-facing public `GET` routes, update `scripts/lib/public-api-artifact-catalog.ts` with a canonical `responseSchema` from `scripts/lib/public-api-response-schemas.ts`; new entries without one fail closed. Keep the generator's operation order and OpenAPI/Postman outputs aligned with runtime metadata.
9. Add or update handler tests in `worker/src/api/__tests__/`. Include critical suites in `npm run test:critical-contracts` only when they belong on the critical path. Set `strictContract: true` in `shared/lib/api-endpoints/definitions.ts` for frontend-critical routes: `worker/src/api/__tests__/router-contract.test.ts` checks every strict path with `getRouteMatch()` without executing handlers. Its registry/method sweep uses sentinel public handlers and unauthenticated admin requests; dedicated tests must prove payload shape, authenticated behavior, freshness and handler failures.

## Auth And Lanes

- External integrations call `https://api.pharos.watch` and need `X-API-Key` unless the endpoint is explicitly exempt.
- Website browser reads should go through same-origin `/_site-data/*`, backed by `site-api.pharos.watch` and `X-Pharos-Site-Proxy-Secret`.
- Internal site-only GET transports set `publicApiAccess: "site-only"` and retain `siteDataAccess: "allowed"`; the public host returns `404` even with an API key. Use the existing credentialed site/preview gates, omit public/admin/manual probe metadata, and do not enroll these routes in public OpenAPI/Postman artifacts. See [Internal Detail Snapshot Inputs](process/worker-infrastructure-appendix.md#internal-detail-snapshot-inputs).
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

Before pushing endpoint changes, follow [Pre-push readiness](./testing.md#pre-push-readiness) on the final committed state and require its fresh passing receipt:

```bash
npm run check:pr
```
