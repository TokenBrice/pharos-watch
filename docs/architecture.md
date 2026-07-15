# Architecture — Curated File Tree & Routing Model

## API Endpoints

Curated architecture-significant routes. Start with the [Documentation Index](./README.md) for the full docs map, or go straight to the [API Reference](./api-reference.md) for the exhaustive HTTP contract.

## Route Definition Model

Static route metadata is declared once in the folderized `shared/lib/api-endpoints/` module surface (`@shared/lib/api-endpoints`). That shared descriptor list carries path, method, admin/cache/probe/status-action metadata, shared dynamic-admin path matching, plus the worker dependency-hydration hints needed for static routes. Worker route primitives now live in `worker/src/routes/shared.ts`, domain route arrays are split under `worker/src/routes/`, and `worker/src/routes/registry.ts` composes them into the dispatch map that `worker/src/router.ts` consumes for method validation and generic dispatch. Dependency hydration lives in `worker/src/routes/dependency-hydrators.ts` and stays exhaustive/keyed by `EndpointDependency`, so adding a new dependency without wiring hydration still fails at compile time instead of silently defaulting.

Cron trigger metadata follows the same single-source pattern. `shared/lib/cron-jobs.ts` remains the schedule authority, while `shared/lib/scheduled-runner-registry.ts` binds each cron expression to a symbolic scheduled-runner key that both the worker scheduler and `scripts/ci/check-cron-schedule-sync.ts` consume. That keeps `worker/wrangler.toml`, shared cron metadata, and scheduled-runner dispatch in lockstep.

The architecture doc no longer carries a hand-maintained endpoint inventory. Use the generated OpenAPI artifact (`public/openapi.json`), the generated quick-reference block in [API Reference](./api-reference.md), and the source route registries (`shared/lib/api-endpoints/` plus `worker/src/routes/`) for current route membership. The architecture contract is the routing model above, not the full route list.

## Telegram Subsystem Tables

| Table                             | Description                                                                 |
| --------------------------------- | --------------------------------------------------------------------------- |
| `telegram_subscribers`            | Bot subscriber preferences (`chat_id`, alert type flags)                    |
| `telegram_subscriptions`          | Per-user coin subscriptions (`chat_id`, `stablecoin_id`)                    |
| `telegram_pending_disambiguation` | Ephemeral mid-conversation state for ticker disambiguation                  |
| `telegram_pending_alerts`         | Overflow subscriber-alert delivery queue drained by the 5-minute alert cron |

The Telegram subscriber, disambiguation, and overflow-queue tables are part of the squashed worker baseline in `worker/migrations/0000_baseline.sql`; see [`worker/migrations/MANIFEST.md`](../worker/migrations/MANIFEST.md) for the pre-squash lineage and current post-baseline files. For the full bot flow, see [PharosWatchBot and Telegram Alerts](./telegram-alerts.md).

## Telegram Alert Cron Job

| Job                        | Description                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dispatch-telegram-alerts` | Detects DEWS/depeg/safety/launch/reserve/freeze changes and fans out alerts to subscribers on the dedicated `2,7,12,17,22,27,32,37,42,47,52,57 * * * *` trigger |

This is a curated subsystem summary, not the canonical Telegram schema or job inventory. Use [PharosWatchBot and Telegram Alerts](./telegram-alerts.md) and the shared Telegram manifests for current tables, families, and commands.

## File Tree Guide

This section is intentionally high-level. For the exhaustive current source inventory, run:

```bash
rg --files src shared worker scripts data functions
```

| Area                       | Primary paths                                                                                                                  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Frontend routes            | `src/app/**/page.tsx`, route `client.tsx`, route `layout.tsx` / `error.tsx` files                                              | Static Next.js export surfaces. Route-specific contracts live in the route docs linked from [Documentation Index](./README.md).                                                                                                                                                                                                                                                                                          |
| Shared UI components       | `src/components/**`, excluding shadcn primitives in `src/components/ui/**`                                                     | Product components, charts, page sections, status surfaces, and stablecoin-detail modules. Preserve local design patterns before introducing new abstractions.                                                                                                                                                                                                                                                           |
| Frontend hooks and helpers | `src/hooks/**`, `src/lib/**`                                                                                                   | TanStack Query wrappers, stale/refetch policy, view-model builders, route metadata, API helpers, and pure UI derivations.                                                                                                                                                                                                                                                                                                |
| Shared runtime contracts   | `shared/lib/**`, `shared/types/**`, `shared/data/stablecoins/**`                                                               | Runtime-neutral scoring, classification, endpoint metadata, cron metadata, stablecoin data, schemas, and types imported by both frontend and worker. Stablecoin metadata is authored in `shared/data/stablecoins/coins/*.json`; `shared/data/stablecoins/coins.generated.json` is the generated runtime aggregate. Legacy category shards are read-only compatibility shells guarded by `npm run check:stablecoin-data`. |
| API endpoint registry      | `shared/lib/api-endpoints/**`, `worker/src/routes/**`, `worker/src/router.ts`                                                  | Shared endpoint definitions drive method/auth/cache metadata; worker route arrays bind those definitions to handlers.                                                                                                                                                                                                                                                                                                    |
| Worker API handlers        | `worker/src/api/**`                                                                                                            | Public, admin, messaging, and dynamic OG/API handlers. Exact HTTP contracts are canonical in [API Reference](./api-reference.md).                                                                                                                                                                                                                                                                                        |
| Worker scheduled runtime   | `shared/lib/cron-jobs.ts`, `shared/lib/scheduled-runner-registry.ts`, `worker/src/handlers/scheduled/**`, `worker/src/cron/**` | Cron schedules, slot dispatch, leases, progress, domain ingestion/scoring jobs, freshness watchdogs, and reserve adapters. Run `npm run check:cron-sync` and `npm run check:cron-connections` for the authoritative schedule and connection-budget reports.                                                                                                       |
| Worker support libraries   | `worker/src/lib/**`                                                                                                            | D1 helpers, auth, rate limits, circuit breakers, fetch/RPC helpers, stores, scoring support, request attribution, and runtime credentials.                                                                                                                                                                                                                                                                               |
| Pages Functions            | `functions/**`                                                                                                                 | Same-origin site-data and ops proxy surfaces for Cloudflare Pages. Host/origin behavior is documented in [Worker Infrastructure](./worker-infrastructure.md) and [Operator Origin Access](./operator-origin-access.md).                                                                                                                                                                                                  |
| Static/generated data      | `data/**`, `public/**`, `src/generated/**`                                                                                     | Build-time digest data, logos, redirects, public assets, generated docs metadata/sitemap dates, homepage bootstrap snapshots, `/llms.txt`, public cemetery dataset exports, OpenAPI/Postman artifacts, and markdown exports. See [Scripts](./scripts.md) for the generator/check commands.                                                                                                                               |
| Operational scripts        | `scripts/**`, `worker/scripts/**`                                                                                              | CI guardrails, smoke tests, static export serving, data refresh helpers, and worker-bound maintenance tools. See [Scripts](./scripts.md).                                                                                                                                                                                                                                                                                |
| D1 migrations              | `worker/migrations/**`                                                                                                         | Backward-compatible migration tree plus baseline lineage in `worker/migrations/MANIFEST.md`. Standard deploy applies migrations before the new Worker deployment.                                                                                                                                                                                                                                                        |

The status contract surface is organized under `shared/types/status/` by ownership: core health state, cron telemetry, Telegram, yield/liquidity diagnostics, operational publication/dependency/canary state, response schemas, and public health/history. `shared/types/status.ts` remains the compatibility barrel used by existing frontend and Worker consumers, including lazy schema loaders. Domain modules import lower-level siblings directly and never import the compatibility barrel; internal schema primitives stay out of the public export surface. `shared/types/__tests__/status-barrel.test.ts` guards both the legacy runtime export list and schema-instance identity through the barrel.

Stablecoin catalog identity, routing, contracts, classifications, and other scalar metadata remain in `shared/data/stablecoins/coins/*.json`. Research-heavy domains may move as a unit into strict sidecars under `shared/data/stablecoins/domains/`: reserves, mint authority, GENIUS/MiCA compliance, and bridge/oracle/blacklistability risk review. `scripts/lib/stablecoin-catalog-sources.ts` validates each base source shape, claims whole-domain ownership for any present sidecar, merges deterministically, and then applies the full `StablecoinMeta` invariants. Generated registries consume only that merged projection.

Shared runtime host/origin defaults live in `shared/lib/runtime-origins.json` and `shared/lib/runtime-origins.ts`. Frontend API-base inference, `/_site-data/*` Pages Functions, ops-host Pages Functions, worker self/probe URLs, and local static-export tooling should consume that shared source instead of embedding production origins ad hoc.

The Stablecoin Cemetery public dataset export is static Pages data, not a Worker API route. `scripts/maintenance/generate-cemetery-dataset.ts` consumes the merged cemetery entry registry from `shared/lib/cemetery-merged.ts`, backed by curated dead rows in `shared/data/dead-stablecoins.json` and frozen tracked rows from `shared/data/stablecoins/coins.generated.json`. It writes `public/datasets/stablecoin-cemetery.json` plus `public/datasets/stablecoin-cemetery.csv` during `prebuild`, with per-source checksums recorded in the JSON metadata; `npm run check:cemetery-dataset` guards drift in CI.

The API integration artifacts follow the same static-export pattern. `scripts/maintenance/generate-postman-collection.ts` writes `public/postman/pharos-api.postman_collection.json` plus `public/postman/pharos-api.postman_environment.json`, and `scripts/maintenance/generate-openapi-spec.ts` writes `public/openapi.json` during `prebuild`; `npm run check:postman` and `npm run check:openapi` guard drift.

The homepage bootstrap payload follows the same generated-data pattern. `scripts/maintenance/generate-homepage-bootstrap.ts` writes `src/generated/homepage-bootstrap.json` during `prebuild` when an API base is configured, and `src/app/page.tsx` embeds it only on `/` as a non-executed JSON script before the client providers mount. The generator validates the payload against the same endpoint schemas used by the hooks. `src/components/providers.tsx` checks for the script after mount, then dynamically loads the lightweight bootstrap seed path so first paint does not synchronously parse the inline payload. Runtime seeding drops entries older than the endpoint freshness budget, so the static homepage shell can start with small market-data hints while normal browser reads still go through `/_site-data/*` or the configured public API base. The generator enforces a small App-Router/RSC-aware inline byte budget and omits oversized live responses instead of expanding `out/index.html`; a configured build still fails rather than preserving a stale populated payload when every bootstrap fetch fails.

Worker cron refactors should place reusable stage contracts under `worker/src/cron/shared/`. The seed contract layer in `worker/src/cron/shared/stage-contracts.ts` defines the shared vocabulary for stage progress, abort results, and handoff context so large cron decompositions do not each invent incompatible result shapes.

## Frontend Runtime And SEO Surface

- Indexable route membership is owned by `src/app/sitemap.ts`, route metadata modules, and the route-specific docs linked from [Documentation Index](./README.md). Do not mirror the full route inventory here; use the sitemap source and `npm run seo:check` for current crawlability coverage.
- Legacy aliases are maintained through `public/_redirects` and are not sitemap entries: `/telegram` and `/telegram/*` redirect to `/pharoswatchbot/`; `/mica` and `/mica/*` redirect to `/compliance/`; `/blacklist` and `/blacklist/*` redirect to `/freezewatch/`; `/report-cards` and `/risk-lab` redirect to `/safety-scores/`; `/peg-tracker` redirects to `/`; `/stability-index-alt` redirects to `/stability-index/`; `/tape` and `/tape/*` redirect to `/timeline/`; `/stablecoins/protocol/*` (the Liquity-v1/v2 lineage paths) redirect to `/stablecoins/infrastructure/*`. This list is representative; `public/_redirects` is the source of truth.
- Tool roots intentionally marked `noindex,follow`:
  - `/portfolio/`
  - `/screener/picker/` (profile-driven shortlist; Pages-only; KV-backed snapshot pinning at same-origin `/selector-snapshot/`; see [Screener Picker Page](./screener-picker-page.md))
- Public noindex utility route:
  - `/pharoswatchbot/app/` is the Telegram Mini App control panel and is marked `noindex,nofollow`.
- Tracked-variant browse ownership stays on the homepage query state (`/?variant=...`). The repo does not ship a dedicated `/stablecoins/variants/*` family.
- Legacy numeric stablecoin URLs from the pre-canonical-ID era (`/stablecoin/<DefiLlama id>/`) redirect to the matching canonical `/stablecoin/[id]/` route through `functions/stablecoin/[[path]].ts`.
- Private operator routes marked `noindex,nofollow`:
  - `/admin/`
  - `/admin-api/`
  - `/api/admin/`
- Crawlable server-rendered link hubs now live on the compare root, digest archive, depeg event archive, safety scores, liquidity, taxonomy landing pages, and stablecoin detail pages. These hubs are part of the static export and are what `npm run seo:check` validates for orphan routes, sitemap coverage, and click depth.
- `/llms.txt` is generated during `prebuild` from checked-in route/data sources as a curated LLM-facing index. It is a community proposal/inference aid, not a robots or sitemap replacement.
- Markdown content negotiation for agents is handled by `functions/_middleware.ts` for `/methodology/`, `/stablecoin/<id>/`, `/changelog/`, `/digest/<date>/`, and `/docs/*`. The `.md` variants are generated by `scripts/maintenance/generate-markdown-exports.ts` during `postbuild` and are written as `out/<route>/index.md`. Responses include `Vary: Accept` plus CDN no-store headers because Cloudflare's default CDN cache does not key on arbitrary `Vary: Accept`.
- The same Pages middleware also nonce-authorizes inline scripts on HTML responses and overwrites the CSP to remove script `unsafe-inline`. `shared/lib/site-csp.ts` is the shared CSP builder for middleware, the ops-host asset gates, local static-export smoke, and managed `public/_headers` fallback lines; `npm run check:site-csp-sync` guards those static headers against drift. `public/_routes.json` uses a single broad `/*` include so exported document routes pass through this middleware, while static asset prefixes such as `/_next/*`, `/logos/*`, `/dexes/*`, and `/featured/*` stay excluded from function routing. Nonced HTML responses set `Cloudflare-CDN-Cache-Control: no-store` / `CDN-Cache-Control: no-store` so a random nonce is not shared from CDN cache. Cloudflare Pages static headers live in `public/_headers`; the broad fallback CSP also omits script `unsafe-inline`, the broad fallback `Cache-Control` allows CDN compression for HTML responses, and static assets with their own cache policy detach the broad `Cache-Control` rule with `! Cache-Control` so Pages does not comma-join duplicate values.

### Runtime host and env rules

- `src/lib/api-url.ts` is the frontend runtime source of truth for API origin selection; `src/lib/api.ts` re-exports those helpers and layers request/freshness handling on top.
- `src/lib/request.ts` owns bespoke frontend JSON, text, blob, and raw-response lifecycles outside the endpoint-query registry. Its timeout covers response-body consumption, caller and timeout signals are merged, failures are classified, and `RequestSequence` cancels superseded UI requests and rejects late completions. TanStack endpoint reads continue through `src/lib/api.ts` and `useApiQuery()`, with the query signal forwarded to the transport.
- `NEXT_PUBLIC_API_BASE` is an optional explicit override, mainly for local `next dev` against `wrangler dev`.
- When `NEXT_PUBLIC_API_BASE` is unset, `buildRequestUrl()` maps public browser reads on `pharos.watch`, `ops.pharos.watch`, `stablecoin-dashboard.pages.dev`, and `*.stablecoin-dashboard.pages.dev` to same-origin `/_site-data/*`, while `buildApiUrl()` still points explicit public-API callsites (for example feedback, API-key self-serve, and OG fetches) at `https://api.pharos.watch`.
- `functions/_site-data/[[path]].ts` is the browser-facing proxy contract for the website data lane. It accepts only `GET`, allowlists public-read routes through `shared/lib/site-data-lane.ts`, and requires the canonical HTTPS `SITE_API_ORIGIN=https://site-api.pharos.watch`; malformed, non-HTTPS, or foreign hosts fail closed before the shared secret is attached. The lane gates caller `Origin` / `Referer`, forwards upstream `Age` / `Date`, and does not add a second Pages Cache API lifetime. Proxy deadlines cover bounded response-body consumption, not only headers.
- `site-api.pharos.watch` is an internal Worker host, not a browser surface. `worker/src/handlers/http/gates.ts` allows only `GET` allowlisted site-data paths plus the shared-secret header on that lane (or on Worker preview URLs during CI rehearsal).
- `NEXT_PUBLIC_GA_ID` gates GA4 script injection in `src/app/layout.tsx`. When it is unset, the site still renders normally and no browser analytics events are emitted from `src/lib/analytics.ts`.

### Metadata and crawl ownership

- `src/lib/page-metadata.ts` is the shared helper for per-route canonical metadata, Open Graph images, Twitter cards, indexable robots preview directives, and sentence-aware description trimming.
- `src/app/layout.tsx` owns the sitewide metadata baseline, icons, RSS alternates, and root JSON-LD (`WebSite`, `Organization`, `Person`, `WebApplication`) with stable `#website`, `#organization`, `#person-tokenbrice`, and `#webapp` anchors. It intentionally does not emit `SearchAction` until the site has a real query handler, and it does not preload GA because `src/components/google-analytics.tsx` loads analytics from the runtime component after the page shell is interactive.
- Dataset JSON-LD nodes must remain crawlable in isolation for Google Search Console: emit explicit Pharos `Organization` objects for `creator` and `publisher`, a URL-valued license, a Pharos URN `identifier`, and `sameAs` where the dataset has a canonical page or public export. When a Dataset uses `includedInDataCatalog`, the nested `DataCatalog` reference must include the catalog `@id`, `name`, and `url`, not only an ID reference. Dataset `distribution.contentUrl` values must point only at public crawlable API/static-export URLs, never same-origin `/_site-data/*`.
- `src/app/sitemap.ts` owns sitemap output for indexable routes. `/compare/` and `/compare/[slug]/` static comparison pages are included; `/digest/` and every generated `/digest/[date]/` detail page are included because daily and weekly digests are durable archive/citation pages with unique editorial text and snapshots; methodology changelog sitemap membership is the explicit `METHODOLOGY_CHANGELOG_SITEMAP_PATHS` allowlist. `/portfolio/`, `/admin/`, `/admin-api/`, `/screener/picker/`, `/stablecoin/[id]/yield/`, and `/pharoswatchbot/app/` are omitted. `/funding/` uses the latest of route edit time and checked-in funding data timestamps for `lastModified`. `LAST_EDITED` dates are auto-generated from git history during prebuild (`scripts/maintenance/generate-sitemap-dates.ts`) and written to a generated JSON file (gitignored) plus a committed `.d.ts` sidecar. Public docs use `scripts/maintenance/generate-docs-metadata.ts` for git-derived first/last modified dates and the same JSON/type-sidecar artifact pattern.
- `src/app/robots.ts` publishes the sitemap location and disallows crawling of `/admin/`, `/admin-api/`, and `/pharoswatchbot/app/`; everything else stays crawlable. `/admin/` and `/admin-api/` are operator surfaces with host gates plus `X-Robots-Tag: noindex, nofollow`; `/pharoswatchbot/app/` is a Telegram Mini App surface with noindex metadata/headers and Telegram frame ancestors, but it is not host-gated. The robots.txt block means crawlers can no longer observe those noindex responses — accepted tradeoff: already-indexed operator URLs cannot be deindexed via observed noindex while the disallow stands. Routes that rely on crawlers observing a noindex response (`/portfolio/`, yield subpages, datasets) remain crawlable.

### Standalone PharosVille

PharosVille now lives in the separate `TokenBrice/pharosville` repository and
is deployed through its own Cloudflare Pages project at
`https://pharosville.pharos.watch/`. The Pharos.watch host keeps only temporary
redirects from `/pharosville/` and `/lighthouse/` plus the shared API contract
schemas that the standalone app validates against.

The standalone app reads Pharos data through its own same-origin Pages Function
proxy. That proxy owns the PharosVille API key server-side and calls only the
allowlisted public read endpoints on `https://api.pharos.watch`, so the host
Worker does not need a CORS allowlist change for the split.

### Pages Function endpoints (not Worker API)

These are same-origin Pages Functions backed by Pages-only bindings (KV, D1). They do not appear in the Worker API catalogue and are not part of the `api.pharos.watch` surface.

| Endpoint                           | Description                                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /_site-data/*`                | Pages Function (`functions/_site-data/[[path]].ts`): same-origin website data lane. It validates the caller origin, signs the server-to-server hop with `SITE_API_SHARED_SECRET`, forwards allowed read requests to `SITE_API_ORIGIN`, and records site-data attribution when the `DB` binding is present.          |
| `POST /selector-snapshot`          | Pages Function (`functions/selector-snapshot/[[path]].ts`): projects `SelectorInput`, loads eight schema-validated canonical sources through the authenticated site-data lane in two fully consumed batches of four, runs the shared selector engine, and stores a KV-attested schema-v3 `pharos-verified` output. The 100 KB cap is streaming; HMAC-IP rate/quota keys require a dedicated pepper. |
| `GET /selector-snapshot/:sid`      | Pages Function: returns the KV-attested verified frozen projection or an explicitly `client-unverified` legacy projection, or `404`. It recomputes the sid, returns `502` for corrupt/mismatched trusted values, and returns `503` when a first-read five-year retention extension cannot be confirmed.                                                        |
| `GET /stablecoin/:legacy-id`       | Pages Function (`functions/stablecoin/[[path]].ts`): redirect shim for legacy stablecoin IDs before the App Router handles canonical detail routes.                                                                                                                                                                 |
| `GET /admin/*`, `GET /admin-api/*` | Pages Functions (`functions/admin/[[path]].ts`, `functions/admin-api/[[path]].ts`): operator-host asset gates for the Access-protected admin surfaces on `ops.pharos.watch`.                                                                                                                                        |
| `/api/admin/*`                     | Pages Function (`functions/api/admin/[[path]].ts`): same-origin operator proxy to `ops-api.pharos.watch`, using Cloudflare Access service-token bindings and the shared proxy helpers.                                                                                                                              |
| `functions/_middleware.ts`         | Pages middleware: applies host and noindex policy before route-specific Pages Functions run.                                                                                                                                                                                                                        |

### Static feed route handlers

The App Router feed handlers under `src/app/feed/**/route.ts` emit static RSS/XML feeds from checked-in or generated build inputs. Treat that source tree, the sitemap, and `npm run seo:check` as the current feed-route inventory.

---

## CSS Build Pipeline

Styling runs through **PostCSS** with the `@tailwindcss/postcss` plugin (configured in `postcss.config.mjs`). This is the Tailwind CSS v4 integration path -- there is no standalone `tailwind.config` file; Tailwind v4 reads design tokens and `@theme` directives directly from `src/app/globals.css`. The `cn()` utility in `src/lib/utils.ts` uses `tailwind-merge` for safe class deduplication at runtime.

Reminder: Tailwind classes must be static strings -- never construct class names dynamically, as the CSS purge pass cannot detect them.

`src/app/globals.css` also owns Tailwind v4 `@source not` exclusions for non-browser prose, data fixtures, and tests. Keep runtime class maps included, but do not let docs, scripts, worker code, or shared data text inflate the generated utility CSS.

---

## Coverage Subsystem

The `/coverage` page model lives under `src/lib/coverage/` as one module per feature (`price`, `safety`, `dex`, `reserves`, `redemption`, `yield`, `flows`, `blacklist`, `dependency`, `mint-authority`), plus a `shared.ts` with primitives (`createStatus`, `createPresetStatus`, `createDataUnavailableStatus`, `resolveBooleanCoverageStatus`). Each per-feature module owns:

- The feature's preset table (when applicable).
- The `resolve<Feature>Coverage(...)` function that maps a `StablecoinMeta` (plus auxiliary inputs) to a `CoverageStatus`.
- A `format<Feature>Breakdown(rows, breakdownMap)` callback returning `CoverageBreakdownItem[]`.
- The `statusKinds` property on the exported `coverageFeature` object (backed by a module-private `<FEATURE>_KINDS` array) enumerating every `kind` the resolver can produce, used by the legend invariant.
- The `legendItems` property on the exported `coverageFeature` object (backed by a module-private `<FEATURE>_LEGEND` const) — a list of `CoverageLegendItem` entries of shape `{ term, description, kinds[] }` aggregated into the global legend.

`src/lib/coverage.ts` is a thin orchestrator + barrel — it re-exports every public symbol so consumers can keep importing from `@/lib/coverage`, and it owns the cross-feature helpers (`buildCoverageRow`, `buildCoverageFeatureSummary`, `countAvailableFeatures`, `countHeadlineFeatures`, `isHeadlineFeatureCovered`). `buildCoverageFeatureSummary` calls `feature.formatBreakdown(rows, breakdownMap)` inline — adding a new feature requires providing the callback, otherwise TypeScript fails the build.

`src/lib/coverage-features.ts` wires each feature key to its per-feature module exports (formatter, status kinds, legend items); resolvers are wired directly in `coverage.ts`'s `buildCoverageRow` via per-feature module imports, not through `coverage-features.ts`. `src/lib/coverage-page-config.ts` derives `LEGEND_ITEMS` from those per-feature exports plus a small fixed set of general entries (NR / Data n/a / —). A runtime invariant test in `src/lib/__tests__/coverage.test.ts` asserts every `kind` any resolver can produce has a matching legend entry, and a second exhaustiveness test invokes each resolver against a synthetic fixture matrix to confirm `*_STATUS_KINDS` doesn't drift from actual resolver output.

---

## Worker Coding Conventions

### Loose-equality null guard (`!= null`)

The worker codebase deliberately uses `!= null` (loose equality) as the standard null/undefined guard for D1 query results. D1 can return either `null` or `undefined` for absent column values depending on the query path and column type, and `value != null` catches both in a single check. This is intentional -- do not "fix" these to `!== null` or `!== undefined`.

### Worker import boundary waiver

`npm run check:worker-boundary` enforces the worker/frontend/shared import boundary. The only named non-test waiver is `frozen-invariants-lifecycle-registry-check` for `scripts/ci/check-frozen-invariants.ts`, which imports worker and frontend registries to prove frozen stablecoin IDs were removed from lifecycle surfaces. Keep that waiver documented in the script header and guarded by `scripts/__tests__/worker-boundary-waivers.test.ts`; new cross-layer checks should move runtime-neutral metadata into `shared/` instead of expanding the waiver set.

---

## TypeScript Target Constraints

Both the root tsconfig and worker tsconfig target ES2022. Shared modules in `shared/lib/` compile under both configs and may use ES2022 features (nullish assignment `??=`, logical assignment `||=`, `Array.at()`, top-level `await`, etc.) but must remain runtime-neutral — no DOM APIs, no Node-only APIs, no Cloudflare-only APIs.

---

## Architectural Decision Records

Load-bearing, deliberately-locked decisions and _why_ they exist, so the rationale survives independent of the people/agents who set them. These are constraints, not aspirations — change them only with a deliberate, documented follow-up. The `CLAUDE.md` / `AGENTS.md` hard-rules block is the enforceable summary; this section is the rationale.

- **ADR-1 — Root tsconfig excludes `worker/`.** `worker/tsconfig.json` sets `"types": ["@cloudflare/workers-types", "node"]`, whose global types (and `D1Database` et al.) conflict with the frontend's DOM lib. Compiling both under one config produces ambient-type clashes, so the root config (`tsconfig.json` `exclude`) drops `worker/` and the worker compiles under its own config. Consequence: code shared by both runtimes must be runtime-neutral and live in `shared/lib/`, never reach into worker- or DOM-only APIs.
- **ADR-2 — `@shared/*` alias boundary.** Frontend and worker both import shared runtime/types through the `@shared/*` / `@shared/data/*` path alias (`tsconfig.json` `paths`), not relative cross-boundary paths. This keeps the runtime-neutral boundary explicit and greppable; `npm run check:worker-boundary` enforces it (see Worker import boundary waiver above for the single named exception).
- **ADR-3 — Methodology versioning is numeric-decimal, not semver minor.** Methodology versions increase as decimals: after `v5.9` the next step is `v5.91` or `v6.0`, never `v5.10`. This avoids the `5.9 < 5.10` ambiguity that bit earlier integer-segment version comparisons; compare versions numerically. Methodology changes update `/methodology`, the owning methodology doc, and the structured entry under `shared/data/methodology-changelogs/`.
- **ADR-4 — One Worker for OG + API + cron.** A single Cloudflare Worker serves the public/site/ops API surfaces, dynamic OG image generation, and all scheduled (cron) runtime work rather than splitting into per-concern Workers. This keeps one deploy/rollback unit and one D1 binding set. Cloudflare limits each invocation to six simultaneous outbound requests waiting for response headers; Pharos conservatively budgets the whole trigger at six and requires response-body cleanup before later phases to bound resources and preserve deterministic sequencing (see `worker-infrastructure.md`).
- **ADR-5 — Penalty-only score blends.** Reviewed risk inputs (Mint Authority since Safety Score v8.0, CDP oracle risk v8.11, bridge-route risk v8.12) drag the Decentralization dimension through a penalty-only blend — they can only lower a score, never lift it, and missing reviews stay neutral (e.g. `decentralization = min(current, 0.80·current + 0.20·reviewScore)`). This prevents thin or optimistic reviews from inflating scores and keeps "no data" strictly neutral. See `report-cards.md` and `classification.md`.
- **ADR-6 — Squashed D1 baseline.** `worker/migrations/0000_baseline.sql` consolidates migrations 0001–0071 into one fresh-DB schema script; existing databases never run the baseline and continue from their last-applied migration, while fresh databases apply the baseline then 0072 onward. The legacy-duplicate allowlist is frozen and must not expand. Cadence/procedure for the next squash lives in `docs/process/d1-baseline-squash-plan.md`; lineage is in `worker/migrations/MANIFEST.md`.
- **ADR-7 — Single-source route and cron metadata.** Static route metadata is declared once in `shared/lib/api-endpoints/` and cron schedules once in `shared/lib/cron-jobs.ts` (bound to runner keys via `shared/lib/scheduled-runner-registry.ts`); worker route/dispatch and CI sync checks consume those single sources. This keeps `wrangler.toml`, shared metadata, and dispatch in lockstep and makes drift a compile/CI failure rather than a silent default. See Route Definition Model above.
- **ADR-8 — Supply is read from DefiLlama list `circulating` as-is.** Use `getCirculatingRaw()` from `shared/lib/supply.ts`; DefiLlama list-endpoint `circulating` values are already USD-denominated, so they must never be multiplied by price, and no manual/on-chain/CMC/DEX supply overrides are added. This keeps one consistent supply basis across every aggregate and avoids double-counting.

---

## Stablecoin lifecycle phases

Every entry in `TRACKED_STABLECOINS` is in one of five lifecycle phases. The phase controls write-side collection, live aggregates, and public presentation. Phase transitions are a catalog policy change, not a scoring-algorithm change, so per-domain methodology versions are unaffected unless the scoring formula also changes.

| Phase | `status` field | New data collected? | Score recomputation? | Public treatment |
| --- | --- | --- | --- | --- |
| Active | `"active"` (or omitted) | Yes | Yes | Live tables, analytics, aggregates, alerts, and detail page |
| Pre-launch | `"pre-launch"` | No | No | `/upcoming/` and pre-launch detail variant |
| Quarantined | `"quarantined"` plus `listingStatusReview` | No | No | Static read-only detail record with reason and review date |
| Delisted | `"delisted"` plus sourced `listingStatusReview` | No | No | Static historical detail record; discovery fingerprints remain blocked |
| Frozen | `"frozen"` plus `frozenAt` and `obituary` | No | No | `/cemetery/` and preserved archive detail page |

The main registry universes from `shared/lib/stablecoins/registry.ts` are:

- `TRACKED_STABLECOINS` — the complete catalog across all five phases. Use for canonical identity, schema validation, static detail params, sitemap entries, and known provider IDs in discovery.
- `ACTIVE_STABLECOINS` — active or omitted status only. Every write-side cron, live aggregator, PSI/DEWS/Bank-Run-Gauge input, and Telegram alert target must use this universe.
- `PRE_LAUNCH_STABLECOINS`, `QUARANTINED_STABLECOINS`, `DELISTED_STABLECOINS`, and `FROZEN_STABLECOINS` — explicit lifecycle partitions that drive their respective static or archive surfaces.
- `READABLE_STABLECOINS` — all post-launch records: active, quarantined, delisted, and frozen. Use only for historical/read-only navigation and identity resolution, never live collection or cache publication.

Listing scope, classes, quarantine, and delisting are defined in [Stablecoin Listing Policy](./listing-policy.md). The freeze procedure is documented in [Freezing a Tracked Stablecoin](./freezing-stablecoins.md).

## Funding page

The `/funding` route is a static page backed by two hand-maintained JSON files in `shared/data/funding/` (costs and donations). No cron, no D1, no API endpoint. Donations are appended to `donations.json` via the `funding-update` Claude skill on a weekly cadence — the skill researches inbound transfers to `pharos-watch.eth` across six chains (Ethereum/Base/Optimism/Arbitrum/Polygon via Alchemy `alchemy_getAssetTransfers`, Gnosis via Etherscan V2 with `chainid=100`), prices each donation in USD at receipt via CoinGecko `/coins/{id}/history`, forward-verifies ENS, and writes after explicit user approval. See `docs/funding-page.md` for the data model and the rationale for the intentionally-simple architecture.
