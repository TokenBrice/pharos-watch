# Architecture — Curated File Tree & API Endpoints

## API Endpoints

Curated architecture-significant routes. Start with the [Documentation Index](./README.md) for the full docs map, or go straight to the [API Reference](./api-reference.md) for the exhaustive HTTP contract.

## Route Definition Model

Static route metadata is declared once in the folderized `shared/lib/api-endpoints/` module surface (`@shared/lib/api-endpoints`). That shared descriptor list carries path, method, admin/cache/probe/status-action metadata, shared dynamic-admin path matching, plus the worker dependency-hydration hints needed for static routes. Worker route primitives now live in `worker/src/routes/shared.ts`, domain route arrays are split under `worker/src/routes/`, and `worker/src/routes/registry.ts` composes them into the dispatch map that `worker/src/router.ts` consumes for method validation and generic dispatch. Dependency hydration lives in `worker/src/routes/dependency-hydrators.ts` and stays exhaustive/keyed by `EndpointDependency`, so adding a new dependency without wiring hydration still fails at compile time instead of silently defaulting.

Cron trigger metadata follows the same single-source pattern. `shared/lib/cron-jobs.ts` remains the schedule authority, while `shared/lib/scheduled-runner-registry.ts` binds each cron expression to a symbolic scheduled-runner key that both the worker scheduler and `scripts/check-cron-schedule-sync.ts` consume. That keeps `worker/wrangler.toml`, shared cron metadata, and scheduled-runner dispatch in lockstep.

| Endpoint                                     | Description                                                                                                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/stablecoins`                       | Full stablecoin list with supply, price, chains. Returns `X-Data-Age` header                                                                                                                                                   |
| `GET /api/stablecoin/:id`                    | Per-coin detail (cache-aside, 5min TTL)                                                                                                                                                                                        |
| `GET /api/stablecoin-summary/:id`            | Lightweight per-coin snapshot (price + aggregate supply/deltas)                                                                                                                                                                |
| `GET /api/stablecoin-reserves/:id`           | Live or fallback reserve composition for live-enabled assets                                                                                                                                                                   |
| `GET /api/redemption-backstops`              | Modeled redemption-route and effective-exit snapshot for configured assets                                                                                                                                                     |
| `GET /api/stablecoin-charts`                 | Historical total supply chart data                                                                                                                                                                                             |
| `GET /api/blacklist`                         | Freeze/blacklist events (filterable by token, chain)                                                                                                                                                                           |
| `GET /api/blacklist-summary`                 | Blacklist summary stats, chart data, chain options, and methodology envelope                                                                                                                                                   |
| `GET /api/depeg-events`                      | Depeg events (`?stablecoin=ID`, `?active=true`, `?limit=N&offset=M`)                                                                                                                                                           |
| `GET /api/peg-summary`                       | Per-coin peg scores + aggregate summary stats                                                                                                                                                                                  |
| `GET /api/usds-status`                       | USDS Sky protocol status                                                                                                                                                                                                       |
| `GET /api/bluechip-ratings`                  | Bluechip safety ratings (keyed by Pharos ID)                                                                                                                                                                                   |
| `GET /api/dex-liquidity`                     | DEX liquidity scores, pool data, protocol/chain breakdowns, HHI, trends (keyed by Pharos ID)                                                                                                                                   |
| `GET /api/dex-liquidity-history`             | Per-coin historical liquidity data (`?stablecoin=ID&days=90`)                                                                                                                                                                  |
| `GET /api/chains`                            | Chain-level stablecoin aggregates with Chain Health Scores, computed on-the-fly from stablecoins + report-card caches and published with freshness metadata (`_meta` / `X-Data-Age`)                                          |
| `GET /api/non-usd-share`                     | Historical non-USD peg share series for market-structure views (`?days=N`)                                                                                                                                                     |
| `GET /api/supply-history`                    | Per-coin supply history (`?stablecoin=ID&days=N`)                                                                                                                                                                              |
| `GET /api/daily-digest`                      | AI-generated daily market summary (latest)                                                                                                                                                                                     |
| `GET /api/digest-archive`                    | All daily digests, newest-first                                                                                                                                                                                                |
| `GET /api/digest-snapshot`                   | Contextual data snapshot for a specific digest date (`?date=YYYY-MM-DD` or `YYYY-MM-DD-weekly`) for SSG builds                                                                                                                |
| `GET /api/health`                            | Worker health check (includes circuit breaker states)                                                                                                                                                                          |
| `GET /api/public-status-history`             | Public `/status/` transition history and current-status runway data                                                                                                                                                            |
| `GET /api/status`                            | Admin status dashboard (raw/effective status, causes, confidence, staleness, probes, timeline). Preferred access is `ops.pharos.watch/admin/` (browser) or `ops-api.pharos.watch/api/status` with Access service-token headers |
| `GET /api/status-history`                    | Admin machine-readable status timeline/probe history (`?limit=N`, max 200). Preferred access is `ops-api.pharos.watch/api/status-history` with Access service-token headers                                                    |
| `GET /api/request-source-stats`              | Admin machine-readable total site-vs-external demand summary, including Pages `/_site-data/*` delivery telemetry, `public-api` / `site-api` worker-lane load, and keyed public-API load by API key. Preferred access is `ops-api.pharos.watch/api/request-source-stats` with Access service-token headers |
| `GET /api/stability-index`                   | Latest Pharos Stability Index sample plus daily history and component breakdowns (`?detail=true` for full history)                                                                                                            |
| `GET /api/og/*`                              | Dynamic Open Graph PNG images for stablecoin detail, safety scores, depeg, and PSI share cards                                                                                                                                 |
| `GET /api/report-cards`                      | Stablecoin risk grade cards with dimension scores (peg, liquidity, resilience, decentralization, dependency)                                                                                                                   |
| `GET /api/safety-score-history`              | Per-coin Safety Score grade transition history (`?stablecoin=ID&days=N`)                                                                                                                                                       |
| `GET /api/telegram-pulse`                    | Public Telegram landing-page adoption metrics (watcher counts, subscription counts, top subscribed coins)                                                                                                                     |
| `GET /api/yield-rankings`                    | Cache-backed yield rankings with live-hydrated Safety Scores and risk-adjusted metrics                                                                                                                                         |
| `GET /api/yield-history`                     | Per-coin historical yield data (`?stablecoin=ID&days=90`)                                                                                                                                                                      |
| `GET /api/mint-burn-flows`                   | Mint/burn flow data with gauge score, per-coin net-flow + pressure-shift signals, hourly timeseries (`?stablecoin=ID`, `?hours=N`)                                                                                             |
| `GET /api/mint-burn-events`                  | Individual mint/burn transfer events for a stablecoin (`?stablecoin=ID`, `?direction=`, `?chain=ethereum`, `?burnType=`, `?scope=all or counted`, `?minAmount=`, `?limit=N&offset=M`)                                       |
| `GET /api/stress-signals`                    | DEWS stress signal scores per coin (`?stablecoin=ID`, `?days=N`)                                                                                                                                                               |
| `POST /api/backfill-depegs`                  | Admin: backfill depeg events (preferred access: `ops-api.pharos.watch` + Access service-token headers)                                                                                                                         |
| `POST /api/backfill-supply-history`          | Admin: backfill per-coin supply history (preferred access: `ops-api.pharos.watch` + Access service-token headers)                                                                                                              |
| `POST /api/backfill-stability-index`         | Admin: backfill historical stability index scores (preferred access: `ops-api.pharos.watch` + Access service-token headers)                                                                                                    |
| `POST /api/backfill-cg-prices`               | Admin: backfill CoinGecko historical prices into price_cache (preferred access: `ops-api.pharos.watch` + Access service-token headers)                                                                                         |
| `POST /api/backfill-mint-burn`               | Admin: controlled mint/burn ingestion backfill by `configKey` (preferred access: `ops-api.pharos.watch` + Access service-token headers)                                                                                        |
| `POST /api/reclassify-atomic-roundtrips`     | Admin: retroactively tag same-tx mint/burn noise as `flow_type='atomic_roundtrip'` (preferred access: `ops-api.pharos.watch` + Access service-token headers)                                                                   |
| `POST /api/audit-depeg-history`              | Admin: audit depeg events against CoinGecko price data for false positive detection, synthetic split consolidation, or contradictory terminal-price repair (GET supports `dry-run=true` previews only; preferred access: `ops-api.pharos.watch` + Access service-token headers) |
| `POST /api/trigger-digest`                   | Admin: force digest regeneration bypassing 1h dedup (preferred access: `ops-api.pharos.watch` + Access service-token headers)                                                                                                  |
| `POST /api/reset-blacklist-sync`             | Admin: roll back blacklist sync state to re-scan missed events (preferred access: `ops-api.pharos.watch` + Access service-token headers)                                                                                       |
| `POST /api/remediate-blacklist-amount-gaps`  | Admin: remediate recoverable blacklist amount/provenance gaps (preferred access: `ops-api.pharos.watch` + Access service-token headers)                                                                                       |
| `POST /api/backfill-blacklist-current-balances` | Admin: rebuild `blacklist_current_balances` rows for matching blacklist configs, with optional `dryRun`, `stablecoin`, `chainId`, and `limit` filters (preferred access: `ops-api.pharos.watch` + Access service-token headers) |
| `GET /api/backfill-dews`                     | Admin: DEWS backtest audit against historical depeg events (reports true-positive rate and lead time; `repair=...&dry-run=true` also previews DEWS refresh/prune mutations; preferred access: `ops-api.pharos.watch` + Access service-token headers) |
| `POST /api/backfill-dews`                    | Admin: DEWS repair surface for current-row refreshes and bounded history pruning under the live trust floor (preferred access: `ops-api.pharos.watch` + Access service-token headers)                                           |
| `POST /api/backfill-mint-burn-prices`        | Admin: backfill mint/burn event prices (preferred access: `ops-api.pharos.watch` + Access service-token headers)                                                                                                               |
| `GET /api/debug-sync-state`                  | Admin: view blacklist sync state for all chains (preferred access: `ops-api.pharos.watch` + Access service-token headers)                                                                                                      |
| `GET /api/api-keys`                          | Admin: list public API keys (masked token, owner/tier metadata, usage timestamps; preferred access: `ops-api.pharos.watch` + Access service-token headers)                                                                   |
| `GET /api/api-keys/audit-log`                | Admin: list API key lifecycle audit-log entries, optionally filtered by API key ID (preferred access: `ops-api.pharos.watch` + Access service-token headers)                                                                 |
| `POST /api/api-keys`                         | Admin: create a new public API key and return the plaintext token once (preferred access: `ops-api.pharos.watch` + Access service-token headers)                                                                             |
| `POST /api/api-keys/:id/update`              | Admin: update public API key metadata / rate limit / active state (preferred access: `ops-api.pharos.watch` + Access service-token headers)                                                                                  |
| `POST /api/api-keys/:id/deactivate`          | Admin: deactivate a public API key immediately (preferred access: `ops-api.pharos.watch` + Access service-token headers)                                                                                                      |
| `POST /api/api-keys/:id/rotate`              | Admin: rotate a public API key secret and return the new plaintext token once (preferred access: `ops-api.pharos.watch` + Access service-token headers)                                                                      |
| `GET /api/discovery-candidates`              | Admin: list stablecoin coverage candidates surfaced by the Monday CoinGecko discovery scan plus quarter-hourly DefiLlama residual intake                                                                                      |
| `POST /api/discovery-candidates/:id/dismiss` | Admin: dismiss a discovery candidate from the status dashboard                                                                                                                                                                 |
| `POST /api/bulk-dismiss-discovery-candidates` | Admin: bulk-dismiss discovery candidates via `?all=true` or `?ids=csv`                                                                                                                                                        |
| `POST /api/reset-cron-lease`                 | Admin: clear a stuck `cron_leases` row by `?job=` so the next tick can claim it cleanly                                                                                                                                       |
| `POST /api/reset-circuit-breaker`            | Admin: clear cached breaker state for `?circuit=` so the next call re-probes with a closed breaker                                                                                                                            |
| `POST /api/kill-cron-in-flight`              | Admin: force-terminate a stale in-flight cron by `?job=&leaseOwner=` (409 on owner mismatch)                                                                                                                                   |
| `GET /api/status-probe-history`              | Admin: per-path historical probe data for incident triage (`?path=`, `?days=1-30`)                                                                                                                                             |
| `GET /api/admin-action-log`                  | Admin: persistent audit log of admin mutations (actor, action, target, result, HTTP status, details)                                                                                                                            |
| `POST /api/feedback`                         | Public: submit feedback (bug, data-correction, feature-request). Rate-limited, auto-verified                                                                                                                                   |
| `POST /api/telegram-webhook`                 | Telegram bot webhook (command handling, subscription management)                                                                                                                                                               |

## Telegram Subsystem Tables

| Table                             | Description                                                                 |
| --------------------------------- | --------------------------------------------------------------------------- |
| `telegram_subscribers`            | Bot subscriber preferences (`chat_id`, alert type flags)                    |
| `telegram_subscriptions`          | Per-user coin subscriptions (`chat_id`, `stablecoin_id`)                    |
| `telegram_pending_disambiguation` | Ephemeral mid-conversation state for ticker disambiguation                  |
| `telegram_pending_alerts`         | Overflow subscriber-alert delivery queue drained by the 5-minute alert cron |

The Telegram subscriber, disambiguation, and overflow-queue tables are part of the squashed worker baseline in `worker/migrations/0000_baseline.sql`; see [`worker/migrations/MANIFEST.md`](../worker/migrations/MANIFEST.md) for the pre-squash lineage and current post-baseline files. For the full bot flow, see [Telegram Alert Bot](./telegram-alerts.md).

## Telegram Alert Cron Job

| Job                        | Description                                                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `dispatch-telegram-alerts` | Detects DEWS/depeg/safety/launch changes and fans out alerts to subscribers on the dedicated `2,7,12,17,22,27,32,37,42,47,52,57 * * * *` trigger |

## File Tree Guide

This section is intentionally high-level. For the exhaustive current source inventory, use [Agent Code Map](./agent-code-map.md) or run:

```bash
rg --files src shared worker scripts data functions
```

| Area | Primary paths | Notes |
| --- | --- | --- |
| Frontend routes | `src/app/**/page.tsx`, route `client.tsx`, route `layout.tsx` / `error.tsx` files | Static Next.js export surfaces. Route-specific contracts live in the route docs linked from [Documentation Index](./README.md). |
| Shared UI components | `src/components/**`, excluding shadcn primitives in `src/components/ui/**` | Product components, charts, page sections, status surfaces, and stablecoin-detail modules. Preserve local design patterns before introducing new abstractions. |
| Frontend hooks and helpers | `src/hooks/**`, `src/lib/**` | TanStack Query wrappers, stale/refetch policy, view-model builders, route metadata, API helpers, and pure UI derivations. |
| Shared runtime contracts | `shared/lib/**`, `shared/types/**`, `shared/data/stablecoins/**` | Runtime-neutral scoring, classification, endpoint metadata, cron metadata, stablecoin data, schemas, and types imported by both frontend and worker. |
| API endpoint registry | `shared/lib/api-endpoints/**`, `worker/src/routes/**`, `worker/src/router.ts` | Shared endpoint definitions drive method/auth/cache metadata; worker route arrays bind those definitions to handlers. |
| Worker API handlers | `worker/src/api/**` | Public, admin, messaging, and dynamic OG/API handlers. Exact HTTP contracts are canonical in [API Reference](./api-reference.md). |
| Worker scheduled runtime | `shared/lib/cron-jobs.ts`, `shared/lib/scheduled-runner-registry.ts`, `worker/src/handlers/scheduled/**`, `worker/src/cron/**` | Cron schedules, slot dispatch, leases, progress, domain ingestion/scoring jobs, and reserve adapters (44 adapters). Connection budgets for the 15 job-bearing/status-tracked trigger groups in `CRON_JOB_DEFINITIONS` are enforced by `npm run check:cron-connections`; the manual digest-trigger poll slot is scheduled separately and currently documented outside that enforced budget table. |
| Worker support libraries | `worker/src/lib/**` | D1 helpers, auth, rate limits, circuit breakers, fetch/RPC helpers, stores, scoring support, request attribution, and runtime credentials. |
| Pages Functions | `functions/**` | Same-origin site-data and ops proxy surfaces for Cloudflare Pages. Host/origin behavior is documented in [Worker Infrastructure](./worker-infrastructure.md) and [Operator Origin Access](./operator-origin-access.md). |
| Static/generated data | `data/**`, `public/**`, `src/generated/**` | Build-time digest data, logos, redirects, public assets, generated `/llms.txt`, and generated sitemap dates. |
| Operational scripts | `scripts/**`, `worker/scripts/**` | CI guardrails, smoke tests, static export serving, data refresh helpers, and worker-bound maintenance tools. See [Scripts](./scripts.md). |
| D1 migrations | `worker/migrations/**` | Backward-compatible migration tree plus baseline lineage in `worker/migrations/MANIFEST.md`. Standard deploy applies migrations before worker promotion. |

Shared runtime host/origin defaults live in `shared/lib/runtime-origins.json` and `shared/lib/runtime-origins.ts`. Frontend API-base inference, `/_site-data/*` Pages Functions, ops-host Pages Functions, worker self/probe URLs, and local static-export tooling should consume that shared source instead of embedding production origins ad hoc.

Worker cron refactors should place reusable stage contracts under `worker/src/cron/shared/`. The seed contract layer in `worker/src/cron/shared/stage-contracts.ts` defines the shared vocabulary for stage progress, abort results, and handoff context so large cron decompositions do not each invent incompatible result shapes.

## Frontend Runtime And SEO Surface

- Indexable route families include:
  - `/`
  - `/coverage/`
  - `/chains/` and `/chains/[chain]/`
  - `/stablecoin/[id]/`
  - `/stablecoins/`
  - `/stablecoins/[peg]/`
  - `/stablecoins/governance/` and `/stablecoins/governance/[governance]/`
  - `/stablecoins/backing/` and `/stablecoins/backing/[backing]/`
  - `/stablecoins/infrastructure/` and `/stablecoins/infrastructure/[infrastructure]/`
  - `/compare/[slug]/`
  - `/digest/` and `/digest/[date]/`
  - `/methodology/` and `/methodology/*-changelog/`
  - `/about/api/`
  - `/changelog/`
  - major feature pages with standalone static copy (`/start/`, `/upcoming/`, `/blacklist/`, `/depeg/`, `/liquidity/`, `/safety-scores/`, `/stability-index/`, `/yield/`, `/flows/`, `/dependency-map/`, `/cemetery/`, `/telegram/`, `/status/`, `/about/`, `/privacy/`)
- Tool roots intentionally marked `noindex,follow`:
  - `/compare/`
  - `/portfolio/`
- Stealth/noindex public routes:
  - `/funding/` (`noindex,nofollow`; static JSON-backed funding ledger, intentionally absent from sitemap/nav in v1)
- Private operator routes marked `noindex,nofollow`:
  - `/admin/`
  - `/api/admin/`
- Crawlable server-rendered link hubs now live on the digest archive, safety scores, liquidity, taxonomy landing pages, and stablecoin detail pages. These hubs are part of the static export and are what `npm run seo:check` validates for orphan routes, sitemap coverage, and click depth.
- `/llms.txt` is generated during `prebuild` from checked-in route/data sources as a curated LLM-facing index. It is a community proposal/inference aid, not a robots or sitemap replacement.
- Cloudflare Pages static headers live in `public/_headers`. HTML routes use `Cache-Control: public, max-age=0, s-maxage=300, stale-while-revalidate=86400`; static assets with their own cache policy detach the broad rule with `! Cache-Control` so Pages does not comma-join duplicate values.

### Runtime host and env rules

- `src/lib/api.ts` is the frontend runtime source of truth for API origin selection.
- `NEXT_PUBLIC_API_BASE` is an optional explicit override, mainly for local `next dev` against `wrangler dev`.
- When `NEXT_PUBLIC_API_BASE` is unset, `buildRequestUrl()` maps public browser reads on `pharos.watch`, `ops.pharos.watch`, and `*.stablecoin-dashboard.pages.dev` to same-origin `/_site-data/*`, while `buildApiUrl()` still points explicit public-API callsites (for example feedback and OG fetches) at `https://api.pharos.watch`.
- `functions/_site-data/[[path]].ts` is the browser-facing proxy contract for the website data lane. It accepts only `GET`, allowlists public-read routes through `shared/lib/site-data-routes.ts`, requires `SITE_API_ORIGIN` on the production Pages hosts (`pharos.watch`, `ops.pharos.watch`), and still allows preview/local rehearsal to fall back to `https://api.pharos.watch` when that origin is intentionally unset. That fallback is useful only for exempt routes, auth-off/report-only rehearsals, or proxy setups that also forward a valid API key; protected public routes on production `api.pharos.watch` do not accept only `X-Pharos-Site-Proxy-Secret`. All normal site-data upstream requests use `SITE_API_SHARED_SECRET` against `site-api.pharos.watch` or a Worker preview URL.
- `site-api.pharos.watch` is an internal Worker host, not a browser surface. `worker/src/handlers/http/gates.ts` allows only `GET` allowlisted site-data paths plus the shared-secret header on that lane (or on Worker preview URLs during CI rehearsal).
- `NEXT_PUBLIC_GA_ID` gates GA4 script injection in `src/app/layout.tsx`. When it is unset, the site still renders normally and no browser analytics events are emitted from `src/lib/analytics.ts`.

### Metadata and crawl ownership

- `src/lib/page-metadata.ts` is the shared helper for per-route canonical metadata, Open Graph images, Twitter cards, and sentence-aware description trimming.
- `src/app/layout.tsx` owns the sitewide metadata baseline, icons, `api.pharos.watch` preconnect, and root JSON-LD (`WebSite`, `Organization`, `Person`, `WebApplication`) with stable `#website`, `#organization`, `#person-tokenbrice`, and `#webapp` anchors. It intentionally does not emit `SearchAction` until the site has a real query handler.
- `src/app/sitemap.ts` owns sitemap output for indexable routes. `/compare/`, `/portfolio/`, `/funding/`, and `/admin/` are omitted; `/compare/[slug]/` static comparison pages are included. `LAST_EDITED` dates are auto-generated from git history during prebuild (`scripts/generate-sitemap-dates.ts`) and written to a generated JSON file (gitignored).
- `src/app/robots.ts` publishes an allow-all crawl policy, explicit AI crawler allow groups, disallows for operator surfaces (`/admin`, `/admin/`, `/api/admin`, `/api/admin/`), and the sitemap location.

---

## CSS Build Pipeline

Styling runs through **PostCSS** with the `@tailwindcss/postcss` plugin (configured in `postcss.config.mjs`). This is the Tailwind CSS v4 integration path -- there is no standalone `tailwind.config` file; Tailwind v4 reads design tokens and `@theme` directives directly from `src/app/globals.css`. The `cn()` utility in `src/lib/utils.ts` uses `tailwind-merge` for safe class deduplication at runtime.

Reminder: Tailwind classes must be static strings -- never construct class names dynamically, as the CSS purge pass cannot detect them.

---

## Worker Coding Conventions

### Loose-equality null guard (`!= null`)

The worker codebase deliberately uses `!= null` (loose equality) as the standard null/undefined guard for D1 query results. D1 can return either `null` or `undefined` for absent column values depending on the query path and column type, and `value != null` catches both in a single check. This is intentional -- do not "fix" these to `!== null` or `!== undefined`.

---

## TypeScript Target Constraints

Both the root tsconfig and worker tsconfig target ES2022. Shared modules in `shared/lib/` compile under both configs and may use ES2022 features (nullish assignment `??=`, logical assignment `||=`, `Array.at()`, top-level `await`, etc.) but must remain runtime-neutral — no DOM APIs, no Node-only APIs, no Cloudflare-only APIs.

---

## Funding page

The `/funding` route is a static page backed by two hand-maintained JSON files in `shared/data/funding/` (costs and donations). No cron, no D1, no API endpoint. Donations are appended to `donations.json` via the `funding-update` Claude skill on a weekly cadence — the skill researches inbound transfers to `pharos-watch.eth` across six chains (Ethereum/Base/Optimism/Arbitrum/Polygon via Alchemy `alchemy_getAssetTransfers`, Gnosis via Gnosisscan REST), prices each donation in USD at receipt via CoinGecko `/coins/{id}/history`, forward-verifies ENS, and writes after explicit user approval. See `docs/funding-page.md` for the data model and the rationale for the intentionally-simple architecture.
