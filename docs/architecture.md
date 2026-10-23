# Architecture — Curated File Tree & Routing Model

> **Agent navigation** — [Routes](#route-definition-model) · [Layers/shared contracts](#file-tree-guide) · [Frontend runtime/SEO](#frontend-runtime-and-seo-surface) · [Pages endpoints](#pages-function-endpoints-not-worker-api) · [CSS](#css-build-pipeline) · [Coverage](#coverage-subsystem) · [Worker conventions](#worker-coding-conventions) · [TypeScript targets](#typescript-target-constraints) · [ADR quick navigation](#architectural-decision-records) · [Lifecycle phases](#stablecoin-lifecycle-phases).

## API Endpoints

Curated architecture-significant routes. Start with the [Documentation Index](./README.md) for the full docs map, or go straight to the [API Reference](./api-reference.md) for the exhaustive HTTP contract.

## Route Definition Model

Static route metadata is declared once in the folderized `shared/lib/api-endpoints/` module surface (`@shared/lib/api-endpoints`). That shared descriptor list carries path, method, admin/cache/probe/status-action metadata, shared dynamic-admin path matching, plus the worker dependency-hydration hints needed for static routes. Worker route primitives now live in `worker/src/routes/shared.ts`, domain route arrays are split under `worker/src/routes/`, and `worker/src/routes/registry.ts` composes them into the dispatch map that `worker/src/router.ts` consumes for method validation and generic dispatch. Dependency hydration lives in `worker/src/routes/dependency-hydrators.ts` and stays exhaustive/keyed by `EndpointDependency`, so adding a new dependency without wiring hydration still fails at compile time instead of silently defaulting.

Cron trigger metadata follows the same single-source pattern. `shared/lib/cron-jobs.ts` remains the schedule authority, while `shared/lib/scheduled-runner-registry.ts` binds each expression to its symbolic runner and required public/heavy owner. The duplicate-free union of `worker/wrangler.toml` and `worker/wrangler.heavy.toml` stays in lockstep with shared metadata and dispatch.

The architecture doc no longer carries a hand-maintained endpoint inventory. Use the generated OpenAPI artifact (`public/openapi.json`), the generated quick-reference block in [API Reference](./api-reference.md), and the source route registries (`shared/lib/api-endpoints/` plus `worker/src/routes/`) for current route membership. The architecture contract is the routing model above, not the full route list.

## Telegram Subsystem Tables

Schema purposes and relationships are owned by [Telegram Architecture: D1 schema](./telegram-architecture.md#d1-schema); migration SQL is authoritative. Do not maintain a second table inventory here.

## Telegram Alert Cron Job

The shared schedule/runner registries own dispatch placement and budgets; see [Cron Scheduling](./worker-infrastructure.md#cron-scheduling). [Telegram Architecture](./telegram-architecture.md) owns the durable delivery flow.

## File Tree Guide

| Layer | Source owner | Boundary |
| --- | --- | --- |
| Frontend | `src/app/`, `src/components/`, `src/hooks/`, `src/lib/` | Static Next.js export; route contracts are linked from the [docs index](./README.md). |
| Shared contracts | `shared/contracts/`, `shared/types/`, `shared/lib/`, `shared/data/stablecoins/` | Runtime-neutral schemas, metadata and computation shared by frontend, Worker and Pages Functions. |
| Worker HTTP | `shared/lib/api-endpoints/`, `worker/src/routes/`, `worker/src/api/` | Descriptors own metadata; Worker route arrays bind handlers. [API Reference](./api-reference.md) owns HTTP contracts. |
| Worker scheduling | `shared/lib/cron-jobs.ts`, `shared/lib/scheduled-runner-registry.ts`, `worker/src/handlers/scheduled/`, `worker/src/cron/` | Registries own cadence, role and slot; [Worker Infrastructure](./worker-infrastructure.md#cron-scheduling) owns execution. |
| Worker support | `worker/src/lib/` | Runtime-bound storage, auth, transport, leases and domain support; reusable cron stages belong in `worker/src/cron/shared/`. |
| Pages Functions | `functions/` | Same-origin website/operator proxies and Pages-only surfaces; see the [endpoint map](#pages-function-endpoints-not-worker-api). |
| Static artifacts/tooling | `data/`, `public/`, `src/generated/`, `scripts/`, `worker/scripts/` | Build inputs, exports and operational tooling; [Scripts](./scripts.md) owns generator/check interfaces. |
| D1 migrations | `worker/migrations/` | Apply backward-compatible migrations before new Worker deployment; lineage is `worker/migrations/MANIFEST.md`. Destructive cleanup is a separate reviewed rollout. |

`shared/types/` owns wire schemas, vocabulary and pure validation; admission stays in `shared/lib/` (types cannot import it: `pharos/shared-types-imports`). Provider maps use its `chain-identity.ts`, `deployment-id.ts` and `exit-route-identity.ts`, never another registry. Custom errors reuse `issue` in `shared/types/safety-schema-primitives.ts`; guards and ordering stay local.

The private source-only `shared/contracts/` workspace exports only `@pharos/contracts/api-meta`, `@pharos/contracts/api-keys` and `@pharos/contracts/request-source`: API metadata, keys and attribution, with no root/wildcard export. Use exact subpaths, never physical/`@shared/contracts` bypasses (`pharos/contracts-imports`). Package implementations import relatively except root-pinned Zod; they cannot import `shared/lib/`. Other domain schemas stay in `shared/types/`, without compatibility re-exports for moved contracts.

`shared/lib/runtime-origins.json` and `shared/lib/runtime-origins.ts` own shared host/origin defaults for frontend inference, Pages proxies, Worker self/probes and local tooling. Do not embed production origins independently.

Domain schema splits, catalog merging, numeric/display admission, reserve/dependency helpers and their exact source owners are in the [shared implementation boundaries](process/architecture-appendix.md#shared-implementation-boundaries). These domain contracts remain applicable when changing their owners; the layer and import boundaries above apply to all shared work.

## Frontend Runtime And SEO Surface

`route-chrome.tsx` owns chrome/workspace boundaries; `src/lib/nav-config.ts` owns navigation.

Stable providers outlive navigation; optional chrome never gates content. [Shell loading](./homepage.md#shared-shell-loading) owns lazy islands, PSI and footer; `page-loading-skeleton.tsx` retains only route-consumed loading helpers.

- `src/lib/public-route-inventory.ts` and `src/app/sitemap.ts` share indexable paths, including registry-derived families. `npm run seo:check` checks coverage, orphans and depth.
- History and API documents retain citations/fragments through [methodology archives](./methodology-page.md), [changelog archives](./process/blog-publishing.md#changelog) and [separate API documents](./api-page.md).
- `public/_redirects` owns non-sitemap aliases. Static rules precede dynamic rules: Cloudflare silently drops rules beyond its 100 post-dynamic-rule cap. `functions/stablecoin/[[path]].ts` redirects legacy numeric IDs.
- `functions/_middleware.ts` negotiates Markdown; `scripts/maintenance/generate-markdown-exports.ts` emits `index.md`. Require `Vary: Accept` **and CDN no-store**: Cloudflare does not cache-key arbitrary `Vary`. `/llms.txt` replaces neither robots nor sitemap.
- `public/_routes.json` uses one broad `/*` include and static-asset excludes; overlapping include splats are invalid. `public/_headers` owns static cache policy; route exceptions detach the broad cache rule with `! Cache-Control` to avoid comma-joining. Nonce injection and CSP ownership: [CSP posture](./security-governance.md#csp-posture).
- [Static invocation exclusions](./process/worker-infrastructure-appendix.md#static-asset-invocation) keep public assets direct and privileged/function-backed routes gated.
- Client navigation state does not infer a preceding route from `document.referrer`. Display projections may bound examples but retain authoritative totals and disclose omissions; [ADR-34](#adr-34) applies to search, detail and summary surfaces.

### Runtime host and env rules

- `src/lib/api-url.ts` owns origin selection; `src/lib/api.ts` adds transport/freshness. Explicit `NEXT_PUBLIC_API_BASE` wins and disables site-data.
- `buildRequestUrl()` maps admitted UI-host public reads to `/_site-data/*`; release-set `NEXT_PUBLIC_FORCE_SITE_DATA_PROXY=true` extends this to any host. Intentional `buildApiUrl()` calls and `/api/admin/*` are unchanged. `buildApiUrl()` uses public origin on canonical/Pages hosts, relative paths locally/server-side.
- Build-only detail inputs are never browser-proxied. Internal `site-api.pharos.watch` and credential admission follow [Site-Data Auth](process/worker-infrastructure-appendix.md#site-data-auth); the loopback dev proxy applies shared path/method admission before credentials.
- `src/hooks/use-url-filters.ts` supplies query-free static/first-hydration state. Consumers wait for `isReady` before normalization/initialization; history writes preserve the hash and notify subscribers.
- `src/lib/url-state.ts` selects scalar/list schema variants, preserving enum literals and readonly items; numeric/boolean/list types never collapse to `never`. Decode retains defaults/normalization; encode omits defaults and sorts keys.
- `src/lib/request.ts` bounds callbacks through success **and error bodies**. Explicit signals beat `RequestInit.signal`; first abort fixes timeout/cancellation identity. `RequestSequence` rejects superseded results. `src/lib/data-health.ts` ages served generations under effective API budgets; warnings/verdicts impose floors, never replace clocks. See [freshness](./data-flow-map.md#freshness-contract-frontend).
- `src/hooks/use-freshness-boundary.ts` ages served verdicts at producer-budget crossings without changing SSR/hydration or polling; [frontend freshness](./data-flow-map.md#freshness-contract-frontend) owns consumer behavior.
- Unset `NEXT_PUBLIC_GA_ID` skips analytics, not site functionality. `isAnalyticsAllowed()` (`src/lib/analytics.ts`) admits only public apex routes: no operator/Mini App/ops/Pages aliases/previews, except test-ID loopback smoke. Payloads use bounded descriptors/query length, never search text/query strings. Account automatic measurement is separate; [Privacy](./privacy-page.md) owns policy.

### Metadata and crawl ownership

- `src/lib/page-metadata.ts` owns canonical/social/robots metadata; lifecycle overrides win. Route docs own experiments.
- `src/app/layout.tsx` owns sitewide metadata, RSS alternates and root JSON-LD identities. Do not emit `SearchAction` without a real query handler or preload analytics independently of its runtime gate.
- Dataset JSON-LD requires explicit Pharos `Organization` creator/publisher, URL license, Pharos URN and canonical `sameAs`; included `DataCatalog` needs `@id`, `name`, `url`. `url`/`sameAs` identify HTML; `distribution.contentUrl` is a crawlable public download, never `/_site-data/*`. Profile Markdown is build-time catalog data, not live metrics.
- `src/app/sitemap.ts` / `src/app/robots.ts` own crawl/membership policy. Git route dates are editorial, not metric clocks; summary/sidecar changes affect only their profile's floor. Funding also uses checked-in data dates. History metadata generators reject shallow checkouts, never use filesystem dates; refresh via [Scripts](./scripts.md).
- Operator/Mini App routes use `noindex,nofollow`; Mini App is not host-gated. Robots-blocked crawlers cannot observe noindex to deindex existing operator URLs. Public noindex routes (portfolio, yield subpages, datasets) stay crawlable; [Screener](./screener-page.md#snapshot-sharing) owns picker sharing.

### Standalone PharosVille

Independent `TokenBrice/pharosville` runs at `https://pharosville.pharos.watch/`. Pharos.watch keeps redirects/shared API schemas, not its runtime. Its same-origin proxy keeps the Pharos key server-side for allowlisted public reads; no Worker CORS expansion is required.

### Pages Function endpoints (not Worker API)

These same-origin Pages surfaces are **not** Worker API routes. Bindings/admission are function-specific; [HTTP Request Handling](./worker-infrastructure.md#http-request-handling) and [Pages Functions Proxy](./operator-origin-access.md#pages-functions-proxy) own host/proxy policy.

| Endpoint | Pages owner / contract |
| --- | --- |
| `GET /_site-data/*` | `functions/_site-data/[[path]].ts`; admitted website reads, signed internal hop via optional `SITE_API` service binding (URL fetch when absent), and site-data attribution. |
| `POST /selector-snapshot`, `GET /selector-snapshot/:sid` | `functions/selector-snapshot/[[path]].ts`; verified KV snapshots, [sharing contract](./screener-page.md#snapshot-sharing). |
| `GET /stablecoin/:legacy-id` | `functions/stablecoin/[[path]].ts`; canonical-ID redirects. |
| `GET /admin/*`, `GET /admin-api/*`, `/api/admin/*` | Asset host gates in `functions/admin/[[path]].ts` / `functions/admin-api/[[path]].ts`; proxy in `functions/api/admin/[[path]].ts`. [Operator Origin Access](./operator-origin-access.md) owns Access/service-token requirements. |
| `GET /safety-scores/map.json`, `GET /safety-scores/map.png`, `GET /safety-scores/map.webp` | `functions/safety-scores/map.json.ts` / `map.png.ts` / `map.webp.ts`; [Safety Score Map serving](./safety-score-map.md#serving). |
| `GET /social-posts/:date.png`, `GET /social-posts/:date.json` | `functions/social-posts/[[path]].ts`; immutable graphic/manifest, [Daily Social Posts](./daily-social.md). |
| Document middleware | `functions/_middleware.ts`; Markdown negotiation and CSP before route functions; host gates remain in per-route functions and `functions/lib/ops-asset-host-gate.ts`. |

### Static feed route handlers

The App Router feed handlers under `src/app/feed/**/route.ts` emit static RSS/XML feeds from checked-in or generated build inputs; that tree owns the feed-route inventory. The sitemap and `npm run seo:check` cover indexable HTML routes, not RSS feeds.
Depeg RSS uses `classifyDepegClosure`: only recovered events (including legacy) say `Resolved`; other terminal classes name tracking closure, not recovery.

---

## CSS Build Pipeline

`postcss.config.mjs` uses Tailwind v4's `@tailwindcss/postcss`; `src/app/globals.css` owns tokens, `@theme` and source exclusions. Classes must be static strings, never dynamically constructed. Exclude prose/fixtures/tests, not runtime class maps. `src/lib/utils.ts` owns `cn()`/`tailwind-merge` composition.

---

## Coverage Subsystem

`src/lib/coverage-feature-modules.ts` binds each feature's resolver, breakdown formatter, status kinds and legend; `src/lib/coverage.ts` composes rows/summaries without re-exporting feature internals. `COVERAGE_FEATURES` and the legend derive from those modules, and the coverage legend invariant requires every resolver kind to have a legend entry. Column semantics and inputs are owned by [Source Of Truth Per Column](./coverage-page.md#source-of-truth-per-column).

---

## Worker Coding Conventions

### Loose-equality null guard (`!= null`)

The worker codebase deliberately uses `!= null` (loose equality) as the standard null/undefined guard for D1 query results. D1 can return either `null` or `undefined` for absent column values depending on the query path and column type, and `value != null` catches both in a single check. This is intentional -- do not "fix" these to `!== null` or `!== undefined`.

### Worker import boundary waiver

[ADR-2](#adr-2) owns the alias/direction boundary; [Active Waivers](process/boundary-waivers.md#active-waivers) owns the named exceptions. New cross-layer checks should extract runtime-neutral metadata rather than expand waivers. `scripts/lib/runtime-reachability-policies.mts` owns whole-bundle reachability policies, complementing direct-import lint.

---

## TypeScript Target Constraints

Both the root tsconfig and worker tsconfig target ES2022, but the worker config pins `lib: ["ES2021"]`. Shared modules in `shared/lib/` and `shared/contracts/` compile under both configs and may use ES2022 *syntax* (nullish assignment `??=`, logical assignment `||=`, top-level `await`, etc.) — but not the ES2022 *library* surface (`Array.at()`, `Object.hasOwn()`, …), which does not typecheck under the worker config — and must remain runtime-neutral — no DOM APIs, no Node-only APIs, no Cloudflare-only APIs.

See [ADR-1](#adr-1) for the separate compilation roots and transitive shared-file coverage.

---

## Architectural Decision Records

Load-bearing decisions and _why_ they exist. The root `CLAUDE.md` / `AGENTS.md` rules are a selective entry summary, not the complete constraint set: the ADR is the constraint; a named check enforces it only where one exists. Absence of a check does not make a constraint optional.

These records are a living charter: amend in place for precision, scope, or changed premises; git preserves the history. When a later record falsifies an earlier premise, add a reciprocal "premise falsified by ADR-N" line on the earlier record in the same change. Keep release targets, incident telemetry, and application notes in their owning docs; put non-default status lines beneath the unchanged heading. Lifecycle and approval rules: [Architectural decisions](process/agent-artifacts.md#architectural-decisions). ADR-11–18 do not appear in repository history; IDs are never reused.

Eight data-integrity rules were adopted on 2026-09-22 after a repo-wide review found each one violated in five or more independent places. ADR-28 to ADR-35 state them; the per-domain contract wording lives in the owning docs named by each record.

Read an individual decision rather than the entire record collection: [ADR-1](#adr-1) · [ADR-2](#adr-2) · [ADR-3](#adr-3) · [ADR-4](#adr-4) · [ADR-6](#adr-6) · [ADR-7](#adr-7) · [ADR-8](#adr-8) · [ADR-9](#adr-9) · [ADR-10](#adr-10) · [ADR-19](#adr-19) · [ADR-20](#adr-20) · [ADR-21](#adr-21) · [ADR-22](#adr-22) · [ADR-23](#adr-23) · [ADR-24](#adr-24) · [ADR-25](#adr-25) · [ADR-26](#adr-26) · [ADR-27](#adr-27) · [ADR-28](#adr-28) · [ADR-29](#adr-29) · [ADR-30](#adr-30) · [ADR-31](#adr-31) · [ADR-32](#adr-32) · [ADR-33](#adr-33) · [ADR-34](#adr-34) · [ADR-35](#adr-35) · [ADR-36](#adr-36) · [ADR-37](#adr-37) · [ADR-38](#adr-38) · [ADR-39](#adr-39) · [ADR-40](#adr-40) · [ADR-41](#adr-41) · [ADR-42](#adr-42) · [ADR-5](#adr-5).


### Active Records

#### ADR-1

- **ADR-1 — Root tsconfig excludes `worker/`.** Ambient-type clashes between Cloudflare/Node globals and the frontend DOM library motivated separate compilation configs; that is historical motivation, not a claim that today's combined build was tested. The root `tsconfig.json` excludes `worker/`. Worker roots are `src` and `scripts` under `worker/tsconfig.json`; shared files are typechecked when reached through imports, not by including every unrelated shared source or test. Shared runtime logic belongs in runtime-neutral `shared/lib/`, never Worker- or DOM-only APIs, and obeys the [TypeScript Target Constraints](#typescript-target-constraints).
#### ADR-2

- **ADR-2 — Shared import boundary.** Frontend, Worker, and Pages Functions import unpackaged shared runtime/types through `@shared/*`, not relative cross-boundary paths. ESLint's `pharos/require-shared-alias` rejects relative imports resolving into root `shared/` from `src/`, `worker/`, and `functions/`; `shared/lib/` internals retain relative imports for unpackaged shared modules. The source-only contracts workspace instead requires its exact exported `@pharos/contracts/<topic>` entrypoints, including from `shared/lib/`; `pharos/contracts-imports` rejects package-root/private paths and alias/physical bypasses and confines implementation dependencies to package-local relative imports and Zod. The worker/frontend direction bans remain separate (see Worker import boundary waiver above for the single named exception).

  Source-graph checks resolve declared local workspace exports to their source modules and traverse them for unused exports, critical-test ownership, architecture boundaries and runtime reachability. Third-party packages remain external leaves; erased type-only edges remain erased in runtime graphs.

  **Contracts admission (manual review, not an automatic extraction programme).** Admit a domain only when all of these hold:
  1. It owns a cross-runtime wire shape, validation primitive or vocabulary, not domain computation, presentation, scheduling, registry or methodology policy.
  2. Its complete source dependency closure, including type-only imports and re-exports, is runtime-neutral under the [TypeScript target constraints](#typescript-target-constraints). After admission every implementation dependency is package-local or Zod; there are no policy, registry or data imports, even transitively. Do not pull those authorities into the package merely to close the graph.
  3. Review enumerates a small, cohesive public symbol surface and exact topic exports, explains what becomes private and why that boundary improves on the existing module API, and preserves narrow loading. No root/wildcard exports or compatibility bypasses.
  4. Name production consumers in at least two distinct runtimes among frontend, Worker and Pages Functions. Count importer files per runtime, distinguishing value and type-only use; scripts, tests and shared barrels do not establish another runtime. Record outgoing dependencies and the proposed closure alongside the evidence.

  `pharos/contracts-imports` enforces exact manifest-exported consumer paths, package-local relative/Zod implementation imports (including type-only edges), and literal specifiers for dynamic imports/`require`. It does **not** establish runtime neutrality, policy-free semantics, consumer demand or a suitably small API; those remain the admission review above. Changes to exported topics also update callers, boundary tests and the documented import guidance together.

  **Evaluated boundaries retained outside the package:** endpoint descriptors still depend on history-query policy and OG vocabulary; status domains compose market, mint/burn, live-reserve and Safety schemas; the digest family composes Safety publication/cause schemas; Safety public types directly import methodology policy data. Their full closures are not an admissible wire kernel. Supply helpers have no outgoing imports and multiple runtime consumers, but already expose one narrow computation authority: packaging them supplies no justified wire-contract boundary. The narrower digest Safety Map contract and its calendar-validation dependency form a closed cross-runtime candidate, not an admitted export; evaluate that specific surface rather than extracting the digest family wholesale.

#### ADR-3

- **ADR-3 — Methodology versioning is numeric-decimal, not semver minor.** Methodology versions increase as decimals with at most two decimal digits: after `v9.46`, use `v9.47` or `v10.0`, never `v9.461`; after `v5.9`, use `v5.91` or `v6.0`, never `5.10` as the successor of `5.9`. The `5.9`/`5.10` case is an explanatory example, not a recorded incident: the repaired ordering case was `6.09` versus `6.1` (`6b5964f5c`). Compare versions numerically. `createMethodologyVersion` rejects changelog versions activated on or after 2026-09-07 with a third decimal digit; earlier entries remain valid history.

  **Four-target methodology change checklist:**
  1. Update the owning domain's runtime version source in `shared/lib/methodology-versions/constants.ts`, surfaced through `shared/lib/methodology-versions/registry.ts`; Safety's constant reads its domain-only `shared/lib/methodology-versions/current-version.json`.
  2. Add the structured history entry under `shared/data/methodology-changelogs/`.
  3. Update the owning methodology document.
  4. Update the relevant public `/methodology` section when its explanation changes.

  New history shards or lanes are wired into the authored shared registry; regenerate/check downstream changelog exports, route-parity fixtures, and generated documentation outputs. Manifest-pinned scoring input changes also regenerate the evaluation-build manifest from source. Skipping the runtime version source ships a history entry for a version the runtime never adopts. Do not record release targets in this record; they live in structured methodology history and owning docs.


#### ADR-4

**Status:** Partially superseded · **Relations:** cron unity superseded by [ADR-38](#adr-38)

- **ADR-4 — Conservative trigger-wide outbound connection budget.** Cloudflare caps each invocation at six outbound requests awaiting headers; Pharos budgets the whole trigger at six and requires body cleanup between phases for bounded resources and deterministic sequencing. `check:cron-connections` enforces a static declared-pressure model, not runtime admission control. [ADR-38](#adr-38) owns the present two-script topology, including public OG/API co-location. See the [connection-budget contract](./worker-and-api-limits.md#connection-budget-operating-assumption).
#### ADR-6

- **ADR-6 — Squashed D1 baseline.** `worker/migrations/0000_baseline.sql` consolidates migrations 0001–0227 into one fresh-DB schema script. Before applying the squashed tree to an existing database, verify the exact baseline filename is already in its migration ledger; otherwise stop for a separately reviewed adoption plan. Fresh databases apply the baseline then 0228 onward. `check:migrations` rejects duplicate sequence prefixes. Squash procedure: `docs/process/d1-baseline-squash-plan.md`; lineage: `worker/migrations/MANIFEST.md`.
#### ADR-7

- **ADR-7 — Single-source route and cron metadata.** Shared endpoint descriptors in `shared/lib/api-endpoints/` own static route metadata. Route assurance is the typed registry plus tests, not a universal compile failure. Cron schedules live in `shared/lib/cron-jobs.ts`, bound to runner keys by `shared/lib/scheduled-runner-registry.ts`. `check:cron-sync` compares the duplicate-free union of `worker/wrangler.toml` and `worker/wrangler.heavy.toml` with shared schedules and dispatch, including owner placement. See Route Definition Model above.
#### ADR-8

- **ADR-8 — DefiLlama list supply keeps its USD basis; bounded supplemental gap-fill is explicit.**
  **(a) USD basis and supplemental authority.** List-endpoint `circulating` values are already USD-denominated: never multiply them by price or apply arbitrary manual/on-chain/CMC/DEX overrides. Source-owned supplemental paths must be explicit, documented, fail-closed, and double-count safe. At publication, scoring, filtering, and history/delta boundaries use `getCirculatingRawOrNull()` and historical `*OrNull` helpers from `shared/lib/supply.ts`; `admitSupplyBuckets()` distinguishes explicit observed zero from unavailable or invalid buckets.

  Zero-list history repair selects the latest validly dated chart point before supply admission: an explicit zero or invalid latest value cannot resurrect an older positive current total. Historical lookbacks remain separate. This veto does not disable the independently reviewed curated on-chain fallback. Producer-owned history packets (including current-only on-chain packets and `defillama-history-gap-fill`) bypass generic D1 hydration rather than splicing providers into unavailable buckets; ordinary unattributed supplemental history retains its admitted fallback.

  **(b) CoinGecko aggregate admission.** The DEC-01 supply decision retains bounded aggregate gap-fill for a tracked missing-chain gap, not merely chain-only remainder attribution. Admission requires the reviewed CG/DL ratio bound, hysteresis, coherent source buckets, and per-asset provenance. Current and each historical bucket must conserve without scaling observed chains: a missing-chain historical remainder is CG−DL only when every existing chain observed that bucket and their sum matches DL within `max($0.01, DL × 1e-6)`; otherwise that missing-chain bucket is `null`, named in `withheldHistoricalBuckets`, with one per-bucket reason in the accompanying `withheldHistoricalBucketReasons` (`history-unobserved` | `nonconserving`). The admitted aggregate series remains unchanged; unbounded/unavailable aggregate buckets stay unavailable. Owning contract and DEC-01 detail: [CoinGecko aggregate gap-fill limits](./supply-snapshot.md#coingecko-aggregate-gap-fill-limits-dec-01).

  Fresh and carried CoinGecko gap-fill packets own their history, including withheld aggregate buckets and per-bucket provenance. Later publication hydration must not refill these absences from D1, even when the retained provenance is the only ownership signal.

  **(c) Chain-dropout repair and quarantine.** The chain-dropout decision is the second dated supplemental permission, not a count of runtime lanes. Observed aggregate rows reaching the guard include zero aggregates; a current chain observation at zero, `null`, or at most half its vetted baseline is guarded, including omitted known chains. Baselines come from persisted state, a reviewed seed, or previous-day supply. Reviewed issuer-native reads or DefiLlama daily charts repair only the missing difference, without rewriting historical aggregates. Native repair uses `observedAtKind: "local-read"`; chart repair uses `"upstream"`. Aggregate observation clocks never present a local read as upstream time. Unrepaired material deficits quarantine the asset with bounded conservative carry, then unavailable supply. The exception is a deficit of at most 5% (`partialCoverageMaxDeficitRatio`) of the vetted whole-asset total: it publishes the observed remainder as `chains-unavailable` with explicit `partialCoverage: true`, excluded chains `null`, the quarantine retained and nothing added. Other assets continue. Material quarantine releases only on list recovery, on-chain corroboration, or dated reviewed release; immaterial chain-only holds may also release on later daily-chart confirmation. Elapsed time alone never accepts a collapse. See [Chain dropout guard](./supply-snapshot.md#chain-dropout-guard).
#### ADR-9

- **ADR-9 — Per-cache availability ratio overrides.** Public cache availability normally tolerates the global `>8×` degraded / `>12×` stale age bands (`STATUS_CACHE_RATIO_THRESHOLDS`), but a cache whose slow stale window under-reports user impact can tighten them through `STATUS_CACHE_RATIO_OVERRIDES`. `yield-data` uses `>2×`/`>4×` (July 19 incident ruling R3, `011783976`), so two missed publishes degrade public status. Overrides resolve through `getCacheRatioThresholds`/`getCacheHealthyMaxRatio` into cache status, Worker `buildCacheStatuses`, and the override-aware per-record `buildFreshnessMeta`, including yield API metadata. Global defaults and non-overridden caches are unchanged. [ADR-30](#adr-30) requires each published freshness verdict to name its effective budget and generation. Detail: `docs/status-dashboard.md`.
#### ADR-10

- **ADR-10 — Cron growth headroom is topology-reviewed, not a single expression count.** `CRON_GROWTH_HEADROOM_POLICY` in `shared/lib/cron-jobs.ts` caps three distinct units: the duplicate-free physical-expression union across both Wrangler configs, deduplicated fetch-capable job identities, and headroom-full (`5/6`) logical slot plans. Read current ceilings there. Growth that adds logical work, fetch surface, or connection pressure requires another ADR and consolidation/rebalance review; alias/accounting-only ceiling changes adding none of those require a dated note on that constant, not a new ADR. P2-09's hourly-alias correction (40→41, 2026-09-17, `80aa18d0b`) is that precedent. These are internal operability guards, not spare unaudited capacity.
#### ADR-19

**Relations:** supersedes [ADR-5](#adr-5)

- **ADR-19 — Domain-composed Safety Score.** Safety Score V9 owns asset-risk judgment, composed from domain producers rather than competing with them. **(i) One engine per sub-dimension.** Other surfaces may present views, not competing formulas. Mint copies had diverged; Exit's duplicated tables were a drift risk, not demonstrated drift (`1477934f6` found none). **(ii) Anti-double-counting.** A signal enters composition once at its owning layer; the retired Mint Authority route-family pricing is not added again where `capSemantics` already prices that risk. **(iii) Downstream consumers re-bin, never independently re-derive published judgments.** DDR uses published posture, with curated `authorityPosture` fallback whenever derived posture is absent, including with a projection installed. Yield uses the same shared resolver for its distinct opportunity judgment; [ADR-36](#adr-36) replay is same-engine validation, not a competing score. Duplicate curated judgments are validated annotations unless an explicitly owned fallback applies. Policy constants are bound by the policy digest; reviewed code coefficients are allowed when bound by evaluation-build identity. Manifest-pinned scoring input changes regenerate that build manifest in the same commit. See `report-cards.md` and `mint-authority-scoring.md`.
#### ADR-20

**Relations:** Telegram latency-only deferral premise falsified by [ADR-24](#adr-24)

- **ADR-20 — Cron CPU-class rebalance and physical-trigger freeze.** Cloudflare's [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) distinguish sub-hourly and hourly-or-longer Cron CPU classes. This decision converted `quarterHourly`, `v9SupplyAttributionOffset`, and `statusSelfCheckOffset` to hourly physical aliases without changing logical schedules, slots, or cadences; preserve those aliases. The current required set is declared per logical schedule by `cpuPlacement` (`hourly-physical-required` / `sub-hourly-allowed`) in `shared/lib/cron-jobs.ts` and checked by registry-iterating tests in `shared/lib/__tests__/cron-jobs.test.ts`. Splitting aliases rebalances existing work; it adds no logical work, fetch surface, or connection pressure. Physical-trigger growth remains topology-reviewed under [ADR-10](#adr-10); current ceilings live in `CRON_GROWTH_HEADROOM_POLICY`. [ADR-39](#adr-39) is the narrowly reviewed exception to this physical-trigger freeze, moving the union ceiling 41→43. The original Telegram latency-only deferral is not a current safety rationale: expired `sending` claims become terminal `execution_unknown`, so durability alone cannot prove delivery. See [incident evidence](process/adr-20-25-cron-incident-evidence.md#adr-20).
#### ADR-21

**Relations:** Telegram latency-only deferral premise falsified by [ADR-24](#adr-24) · **Acceptance:** not recorded

- **ADR-21 — V9 publication CPU-class rebalance.** Preserve hourly physical aliases for `v9PublicationOffset`'s logical half-hour cadence, slot identity, publication window and zero-connection declaration. A one-shot writer cannot treat a terminated publication as replay-safe queued work; its tolerance follows publication safety, not an abandonment percentage. Read current topology gates from `CRON_GROWTH_HEADROOM_POLICY`; [ADR-39](#adr-39) is the narrow freeze exception. [ADR-24](#adr-24) falsifies the Telegram durability contrast. Historical topology and incident evidence: [ADR-21 evidence](process/adr-20-25-cron-incident-evidence.md#adr-21).
#### ADR-22

**Acceptance:** not recorded

- **ADR-22 — DDR run-scoped heap separation and mint/burn CPU-class rebalance.** CPU-class correction alone does not provide a heap boundary. Keep DDR in its independent, hourly-aliased `depegResolverOffset` invocation, not serially behind supply attribution's large run-scoped graph. Preserve its D1-only connection declaration, freshness contract, and core/version and V9 memory-lane admission fences. Separate invocations prevent same-run graph overlap but do not guarantee service-level isolate separation; production executions remain the acceptance criterion. Keep `halfHourlyMintBurnCritical` on hourly physical aliases for its existing logical cadence. At the time, these changes raised the reviewed physical topology from 34 to 39; current ceilings live in `CRON_GROWTH_HEADROOM_POLICY`. The bounded snapshot compiler and alias correction were preferred to new Queue/Workflow orchestration. See [incident evidence](process/adr-20-25-cron-incident-evidence.md#adr-22).
#### ADR-23

**Acceptance:** not recorded

- **ADR-23 — Extended mint/burn CPU-class rebalance.** ADR-22 missed `halfHourlyMintBurnExtended`. Preserve its logical cadence and slot identity while deploying hourly physical aliases. Narrowing a memory graph cannot change the platform CPU class, but abandonment alone does not prove CPU exhaustion: ADR-24's invocation analytics cover these attempts and report memory-limit, not CPU-limit, outcomes. The correction remains a placement decision, not a proven CPU-cause attribution. It added no logical work, fetch surface, or connection pressure; the reviewed topology rose from 39 to 40 at the time. Current ceilings and execution-substrate review thresholds live in `CRON_GROWTH_HEADROOM_POLICY`. See [incident evidence](process/adr-20-25-cron-incident-evidence.md#adr-23).
#### ADR-24

**Relations:** falsifies the Telegram latency-only deferral premise in [ADR-20](#adr-20) and [ADR-21](#adr-21) · **Acceptance:** not recorded

- **ADR-24 — Five-minute Telegram lane runs on the narrow Worker runtime registry.** Use the narrow membership registry and thin alert-safety envelope, not the full catalog or full V9 publication decoding, in the Telegram lane. The incident-time projection field list was a membership requirement, not a permanent exhaustive schema. Catalog removal alone was insufficient: alert context must read the compact assessment rather than gunzip and parse the full publication. Runtime reachability policy must exclude both heap sources. Expired `sending` claims become terminal `execution_unknown` with `pending_effect_owner_lost`, never automatic retry candidates; the Bot API effect is unconfirmed, so abandonment can mean missed delivery rather than latency alone. This falsifies the earlier deferral premise without claiming every ambiguous alert was lost. No trigger, logical schedule, slot, or connection budget changed; the physical ceiling remained 40 at the time, not as a current freeze. Acceptance requires a clean first week of safety-event dispatches and sidecars, without platform abandonment, memory-limit outcomes, or new lost-effect-owner rows. See [incident evidence](process/adr-20-25-cron-incident-evidence.md#adr-24).

#### ADR-25

**Acceptance:** not recorded

- **ADR-25 — Stagger memory-heavy `:00` Worker invocations without changing logical slots.** Stagger measured execution and daily housekeeping away from the quarter-hourly core while preserving logical schedules, freshness slots, connection peaks, and measured-execution-before-DEX sequencing. Membership-only consumers use narrow projections; the core's evidence-rich graph is not subject to a blanket full-catalog ban. The original combined `5,35` measured-execution expression was later split into hourly aliases by P2-09 (`80aa18d0b`); daily housekeeping is now full-catalog-banned by reachability policy. The physical topology stayed at 40 at the time; read current ceilings from `CRON_GROWTH_HEADROOM_POLICY`. Staggering reduces run-scoped overlap but cannot guarantee service-level isolate separation. Acceptance requires clean first production executions of both staggered lanes without memory-limit or platform-abandoned outcomes. See [incident evidence](process/adr-20-25-cron-incident-evidence.md#adr-25).
#### ADR-26

**Status:** Parity gate active; bounded reserve Queue wakeups admitted; V9 Workflow experiment remains terminally retired 2026-10-08 · **Evidence:** `b386ebfb0` (V9 retirement)

- **ADR-26 — Cloudflare Workflows parity gate for heavy cron lanes.** Workflows are a possible substrate, not a replacement for scheduling semantics. A deterministic instance ID deduplicates only within one Workflow; `create({ id })` does not claim or take over `cron_slot_executions`, coordinate leases, or make restart exactly-once. Slot fences, lease checks, and terminal `cron_runs` remain required until a separately admitted implementation proves an equivalent protocol.

  Retained-sample evidence links and the six-question lane matrix are owned by the [ADR-26 measurement record](process/adr-26-workflows-measurements.md#parity-answers-and-lane-decisions), not a second current scheduling contract. The V9 pilot's status, history disposition, rollback floor and deletion receipts are owned by the [sunset record](process/worker-infrastructure-appendix.md#safety-score-v9-workflow-shadow-pilot). Cron publication, accepted replay, fences and leases remain authoritative; Wrangler/account-state checks enforce the retired class/binding's absence on both roles. Any new Workflow/Queue proposal needs separate admission and current trigger/heap evidence.

  **Reserve Queue amendment.** The public Worker may produce and consume wakeup hints for the existing reserve suffix and the exhausted-cohort redemption/watchdog tail. This is not a new cohort, cadence, publication authority or generic Queue/Workflow admission. The consumer uses one message, zero batching delay and concurrency one; it rereads the exact D1 checkpoint and atomically claims a separate Queue execution ledger under the shared recovery lease. Root/attempt/generation/hash/frontier/source-invocation identity, producer-priority admission and existing domain/child/publication fences remain mandatory. Queue IDs and redelivery never grant execution by themselves; no synthetic cron slot or scheduled-time evidence is created.

  A send happens only after durable readiness and child/job/event settlement. Every consumer gets a fresh event-entry absolute deadline before imports; each invocation executes one bounded producer slice **or** the already sealed cohort tail, preserving existing CPU/coin limits. Semantic failure falls back to the unchanged minute cron recovery; bounded transport retries and a dead-letter queue cannot create new domain attempts. The declared non-cron connection peak and serial handoff reservation live beside cron budgets. [Reserve behavior](process/live-reserves-appendix.md#queue-continuation-contract) owns metrics/reconciliation; [deployment](deployment-process.md#reserve-queue-provisioning) owns provisioning, rollout and operational acceptance. Observed post-deploy queue latency, full-cohort completion, CPU/memory and duplicate/cron-race evidence are required before claiming the projected improvement; local tests are not production proof.


#### ADR-27

- **ADR-27 — A started idempotent mutation is at-most-once.** This is the keyed `runIdempotentAction` contract in `worker/src/lib/idempotency.ts`, scoped to action, idempotency key, and request fingerprint; unkeyed requests are outside it. Known terminal responses expire after seven days. An expired started attempt with an unconfirmed effect becomes `execution_unknown`: a permanent tombstone whose replays return `503`, never a fresh reservation merely because time passed. A proven pre-effect failure may release its reservation; abandoned started executions have no generic automatic reopening capability. Any future reconciler requires an action-specific design proving the effect never committed, not a dormant callback. The audit boundary likewise treats an unconfirmed 5xx as `unknown`, not `confirmed`.


#### ADR-28

- **ADR-28 — R1: unavailable is not zero.** Missing, unreadable or unvalidated observations remain `null` or typed unavailable; producer/store/view boundaries must not invent values with optimistic defaults (`?? 0`, `?? 1`, `?? false`, defaulted bands, `=== true`). Reuse domain discriminants: supply's `*OrNull`/`admitSupplyBuckets`, DEWS's tagged unavailable zero, digest `CollectorResult`, Telegram `unavailableFields`. Views may show placeholders; published numbers, counts, ratios and scores may not.
Domain applications: [R1 evidence boundaries](process/architecture-appendix.md#adr-28-applications).
#### ADR-29

- **ADR-29 — R2: a failed read never becomes a positive claim.** Missing/failed required evidence cannot imply healthy, in-sync, open, covered, zero or empty; successful bootstrap/empty is distinct. Fan-outs settle independently, retain failures and fail closed. Cron-history failure exposes `healthy: null`/`telemetryUnknownReason`; public-health errors remain logged typed outcomes. EVM optional probes tolerate only observed execution reverts, not transport/state/admission failure; admit byte/uint/Multicall semantics before endpoints. Owners: [status](./status-dashboard.md), [RPC](./worker-infrastructure.md#module-initialization).
Domain applications: [R2 failed-read boundaries](process/architecture-appendix.md#adr-29-applications).
#### ADR-30

- **ADR-30 — Data-integrity R3: a published freshness verdict names its budget and its generation.** Publish the threshold and served generation together, never substituting a sibling, last-clean or publication clock. Cache health uses `healthyMaxRatio`/`healthyMaxAge` under [ADR-9](#adr-9); input degradation is separate and unreadable streaks remain null. Yield's validated sentinel atomically binds `generationId`/`publishedAt` to every applied publication, including degraded input; legacy/table/cron evidence has null identity but may retain a valid fallback timestamp. Safety retains its own clock and 86400-second budget. This is distinct from ADR-9's incident R3. Details: [status](./status-dashboard.md), [yield](./yield-intelligence.md#engineering-contract).
Domain applications: [R3 source-clock boundaries](process/architecture-appendix.md#adr-30-applications).
#### ADR-31

- **ADR-31 — R4: non-`ok` implies a machine-readable reason; execution and input quality are separate.** `createCronResult` requires `metadata.reason`, projected by `resolveCronDegradedReason` into `cron_runs.degraded_reason`. Legacy reasonless degraded/error results warn and persist `unspecified-<status>`; other non-ok statuses retain their literal. Degraded means a required stage did not complete; publication needs separate evidence. Completed work with editorial/input findings returns ok plus `metadata.quality`. Compile/schema failures name asset and field. Details: [status](./status-dashboard.md).
#### ADR-32

- **ADR-32 — R5: one authority per cadence, threshold, and vocabulary.** Import schedules/budgets from `shared/lib/cron-jobs.ts` and `CRON_SCHEDULE_CADENCES`, availability from `STATUS_CACHE_RATIO_OVERRIDES`, labels/colors from `shared/lib/classification.ts`. Per-coin/chain maps must derive from registries or have registry-iterating completeness tests; “keep in sync” comments are not guards.
Reserve sync status uses `ReserveSyncStatusSchema` and its derived type from `shared/types/live-reserves.ts` directly across wire schemas, Worker storage/views and the Node coverage audit; scheduler vocabulary remains a separate semantic authority.
Status reliability consumers import `StatusHealthValue` directly from `shared/types/status/core.ts`; pending-depeg evidence imports `ConfirmationTimestampStatus` from its classifier owner, `worker/src/cron/pending-depeg-confirmation.ts`, rather than copying either vocabulary.
Safety producer overlays and compiled facts reuse dependency input fields, role consistency, bridge-supply rows and peg reference vocabulary from shared fact schemas; compiled evidence/path/envelope admission remains separate.
Domain applications: [R5 canonical policy projections](process/architecture-appendix.md#adr-32-applications).
#### ADR-33

- **ADR-33 — R6: provenance names what was read this run.** Route source, freshness kind, census scope and pagination completeness are run evidence, not feed labels. Redemption requires typed `routeObserved: true` before claiming onchain/protocol-api source. A capped/failed scan is incomplete; only an exhaustive census can veto independent staged pools. Local collection time is never upstream observation or certified state time. [ADR-8(c)](#adr-8) distinguishes native `local-read` from chart `upstream` supply clocks; [GLDT evidence](process/live-reserves-appendix.md#additional-adapter-evidence-boundaries) keeps unverified signatures diagnostic. Details: [reserves](./live-reserves.md), [DEX](./dex-liquidity.md).
Domain applications: [R6 source identity and review clocks](process/architecture-appendix.md#adr-33-applications).
#### ADR-34

- **ADR-34 — R7: never publish display-capped or clamped values as statistics.** Headlines use authoritative aggregates, not pages or slices; disclose shown/total bounds (home depegs “Top 3 of N by deviation”; status counts full populations while listing 25 details). Without reproducible denominators use `reportedCollateralizationRatio`, not bounded `collateralizationRatio`. V9 structural shares normalize only floating tails within 0.0001 percentage point, with a clamp marker; other out-of-range values pass unclamped to asset-quarantine validation. Details: [reserves](./live-reserves.md), [report cards](./report-cards.md), [frontend rules](../src/AGENTS.md).
#### ADR-35

- **ADR-35 — R8: per-asset isolation inside an admitted publication.** Quarantine bad assets with named reasons; publish unaffected members only after global admission. Safety holds below ≥90% unaffected closure, on stale DEX or failed source/coverage floors, retaining the accepted generation. Admitted technical quarantines are `pipeline-gap` with null score/grade, not NR; dependents receive unavailable upstream results. Details: [report cards](./report-cards.md), [evaluation appendix](process/report-cards-appendix.md).
Domain applications: [R8 redemption admission](process/architecture-appendix.md#adr-35-applications).

#### ADR-36

**Acceptance:** not recorded

- **ADR-36 — Offline, generation-bound dependency scenario artifacts.** `worker/scripts/compute-dependency-scenarios.ts` computes the bounded hub/shock cohort sequentially in GitHub Actions Node, on schedule or manual dispatch, not in Worker publication or request-time compute. Gate 0 measured Node CPU/RSS, not Worker-isolate peak memory. Canonical cards, journals, and publication identity never consume these hypothetical artifacts.

  Canonical publication atomically retains publication-bound private replay inputs without serializing another full capture. Retention serialization failures do not advance replay rows or block canonical publication; identity violations remain fatal, and held attempts keep prior replay inputs. Offline compute must reassemble the accepted generation, reproduce its published baseline through the same compiler, and reject capture, registry, build, or generation mismatch. Only accepted-publication-equivalent compute earns a stamp binding those identities, methodology, and exact payload hash; publish rechecks that stamp and source identities before writes.

  Storage is content-addressed in existing D1: bounded bodies may remain single rows; larger bodies use verified ordered chunks and an immutable manifest before the latest commit marker advances. Chunk publication requires proven active public-reader capability and matching activation identity before staging and committing. Readers verify complete payload identity before schema admission; invalid readback never advances the marker. Rollback must stay within the chunk-capable reader floor or use reviewed storage rollback. Legacy deletion remains a separate destructive release after old-reader closure and durable export/restore proof.


  The API returns validated artifacts with freshness, including stale artifacts; consumers must hide numbers for `stale` or `unavailable` (display-side suppression, not API redaction). Every verdict names source/accepted generations, age, budget, and non-current reason. `current` requires matching generations within budget; `earlier-generation` numbers remain explicitly modeled on the named older publication. The uncached `GET /api/dependency-scenarios/v1` uses `no-store`; capture races or scheduling delays never relabel an old artifact as current. Local smoke/workflow activation is not first-production-run evidence. Commands, credentials, retention, prune mechanics, and rollout proof: [Scenario artifact storage and retention](./runbooks/dependency-network.md#scenario-artifact-storage-and-retention).


#### ADR-37

**Acceptance:** not recorded

- **ADR-37 — Lossless Worker catalog transport.** Worker transport must reproduce complete source records, canonical order, indexes, and suspended-feed normalized views without removing evidence, controls, sources, nulls, or score-bearing fields. The private catalog seam changes transport only; it adds no runtime external storage or RPC dependency. Decoding must use bounded allocation, retaining decoded objects without whole-catalog inflate intermediates.

  Full-cohort equality tests guard complete records, order, and registry views. The decoder and packed artifact are evaluation-build inputs: decoder/artifact changes rotate build identity while unchanged decoded content keeps registry fingerprint and methodology unchanged. Capture-only observers/producers and the build-time generator are outside the evaluator closure; source-equality tests guard generator correctness. Local hydration/probe results are not production peak-memory proof; first relevant production execution remains acceptance evidence. Codec, buffer, compression, minification, and dated probe details: [Packed catalog transport mechanics](process/worker-infrastructure-appendix.md#packed-catalog-transport-mechanics).

#### ADR-38

**Relations:** supersedes [ADR-4](#adr-4) cron unity · **Acceptance:** not recorded

- **ADR-38 — Separate heavy scheduled Worker, shared fenced D1 authority.** `stablecoin-heavy` owns `v9PublicationOffset`, `halfHourlyChartsOffset`, and `v9SupplyAttributionOffset`; `stablecoin-api` retains HTTP, dynamic OG, and other scheduled plans, including reserve sync/recovery. Heavy has no public routing, workers.dev, preview URLs, CORS, or rate-limit bindings. Both scripts share D1 and ownership fences, not competing publication authority. Cutover/deletion status is owned by the [sunset record](process/worker-infrastructure-appendix.md#safety-score-v9-workflow-shadow-pilot).

  Script separation isolates public traffic from moved graphs; offsets alone do not create isolate boundaries, and heavy overlap still needs admission controls. Wrong-owner deliveries log `scheduled-worker-not-owner` before dynamic runner imports, fences, and D1 work, not before every static import; unknown expressions throw. Shared fences tolerate cron-propagation overlap without resets or counterfeit run rows. ADR-26's V9 pilot is terminal no-go; any new Workflow proposal requires separate admission.

  Each role requires SHA-tagged sole-version activation proof, monotonic `worker-active-version:<role>` markers, and immutable activation evidence. Status and reconciliation use the registry owner; public activation cannot stand in for heavy. V9 admission joins the current stablecoins publication ledger/time, not cross-script UUID equality. Packaging and activation procedures: [CI deploy sequence](./deployment-process.md#ci-deploy-sequence) and [first heavy deployment prerequisites](./deployment-process.md#first-heavy-deployment-prerequisites-adr-38). Topology rollback restores public ownership/triggers before disabling heavy with explicit empty crons; it never recreates the retired Workflow or lost history. First affected executions and public health remain separate acceptance requirements.

  The owner-approved WS4/D12 canary is a narrow private-fetch extension: public retains `dewsPsiOffset` claim/lease/terminal ownership while only `project-tape` executes through the default heavy fetch handler. No public route, RPC entrypoint, new cadence or second terminal writer is introduced. This one service-binding call raises that lane from zero to one connection and admits one additional deduplicated fetch-capable entry; existing physical-trigger and headroom-full ceilings stay unchanged. Original deadline/generation and live driver authority fence executor writes; durable per-generation admission rejects duplicates and transport loss never authorizes a local rerun. Heavy placement is a fetch-only hint, not scheduled pinning or an isolate guarantee. Rollback and measured acceptance are owned by [the canary contract](./worker-infrastructure.md#project-tape-placed-fetch-canary); no second lane is authorized before a recorded go/no-go.


#### ADR-39

**Relations:** narrowly reviewed exception to the [ADR-20](#adr-20)/[ADR-21](#adr-21) physical-trigger freeze · **Evidence:** introduced in `b386ebfb0`; original `dexcap`/`budget` approval record unavailable in verified docs · **Acceptance:** not recorded

- **ADR-39 — Bounded supplemental active measured-execution capacity.** Expand bounded active capacity before any newly promoted EVM cohort, not by raising unproven per-run budgets. The public-owned `halfHourlyMeasuredExecutionSupplemental` adds interleaved logical opportunities with hourly physical aliases while preserving original dispatch, diagnostics, shadow work, per-invocation budgets, and rotation/freshness bounds. Wall duration is not CPU evidence.

  This is the narrowly reviewed exception to ADR-20/21's physical-trigger freeze: the union ceiling moves 41→43, while deduplicated fetch-capable-job and headroom-full-slot ceilings stay 34 and two. Topology review leaves the source and recovery-capable consumer 5/6 slots unchanged; combining RPC work with those slots lacks safe headroom, and serializing it behind core/DDR/V9 would undo graph separation. ADR-26's Queues/Workflows option was considered and rejected for this bounded expansion because it would require new parity proof for slot takeover, leases, terminal rows and replay-safe publication rather than reuse the current runner. An eventual promoted union crossing the existing fan-out, p95 or connection thresholds still requires renewed review.

  Both active slots share the existing job lease, whole-asset cursor and publication surfaces, with the actual producer schedule/path stored on each generation. Existing slot/child fences and global job admission handle duplicate deliveries and up-to-15-minute propagation overlap without lease or fence resets. ADR-38 ownership is unchanged; additional offsets do not create a guaranteed isolate boundary. Capacity scheduling activates no cohort and proves no production CPU/heap fit. Canonical union/setup/worst-fallback, independent proof, replay, rotation/freshness and first-production resource evidence remain mandatory before Base V3-first activation. See [the owning capacity design and rollback](process/worker-infrastructure-appendix.md#measured-execution-capacity-expansion).

#### ADR-40

**Enforcement:** capability-aware RPC resolver and focused routing tests · **Acceptance:** pending production observation

- **ADR-40 — Prefer admitted Dwellir for supported operations, independently of trial gates.** Owner-approved capacity allocation makes Dwellir the first eligible scheduled candidate, with incumbent relative order and inventory/profile boundaries preserved. Key, budget, circuit, run-local failure and explicit rollback admission still apply. Method/pin requirements distinguish recent finalized state, arbitrary old state, historical headers/receipts and inclusive log intervals; batches intersect member requirements. Recent-state availability never proves archive retention or licenses number/latest substitution.

  The diagnostic parity lane keeps independent incumbent comparators and unchanged sufficiency, availability, equality and freshness gates. It is not a promotion controller or evidence of uniform latency superiority. No new provider purchase, concurrency or cron capacity is authorized. Historical-origin replacement is a separate evidence-method change subject to [ADR-3](#adr-3); unavailable bootstrap state remains rejected until that method is reviewed and implemented. R1–R8 remain binding. [Runtime routing](./worker-infrastructure.md#module-initialization) and [trial report](./api-reference-admin.md#get-apirpc-provider-trial) own operational details.

#### ADR-41

**Relations:** added-fetch-surface review under [ADR-10](#adr-10) · **Approval:** owner-approved Hive public-node surface and launch policy, 2026-10-19 · **Acceptance:** pending first public execution and 24-hour observation

- **ADR-41 — Serialize native Hive pricing within existing publication.** Keep `sync-stablecoins` on the **public** quarter-hourly plan (not the heavy Worker). The CoinGecko HIVE parent joins the existing batch; `collectPrimaryProviderQuotes()` awaits all provider waves before one serial native observer and then consensus. Declared job peak stays four of six connections, with no cron, slot, D1 cache or per-trade writes. Consolidation uses the existing publication rather than another trigger or Queue/Workflow lifecycle.
- The observer bounds ten physical RPCs, three seconds per call, twenty seconds overall and one MiB per body, composed with inherited cancellation. Raw arrays are bounded by 500 orders/side and 1,000 trades and do not persist. Research calls measured 360–535 ms on hive.blog and 49–134 ms on deathwing; those sequential samples are not production CPU/heap or p95 evidence. Public quotas remain undocumented. One aggregate circuit outcome and generation-linked diagnostic packet reuse existing persistence.
- [Native Hive acceptance](process/pricing-pipeline-appendix.md#native-hive-order-book) owns the first-run/full-day evidence and rejection-rate distinction. Roll back collection and live registration together if those gates fail; retain historical labels through the retired-source mechanism, never publish par, loosen gates, delete history or alter supply. There is no schema reversal or Worker-role migration.

#### ADR-42

**Relations:** applies [ADR-29](#adr-29) and [ADR-30](#adr-30) to reader surfaces · **Enforcement:** `isPublicWarning` in `src/lib/data-health.ts`; banner, notice and hero tests · **Approval:** owner-approved public-warnings simplification, 2026-10-21 · **Acceptance:** pending first production reserve post-sync operator alert

- **ADR-42 — Readers see material data problems only; operators get the rest.** A public surface warns only when data is past its stale band (`FRESHNESS_RATIOS.DEGRADED`, 12× the producer interval, or the producer's `degradedBudgetSec`), is missing with nothing retained, or is curated as quarantined/delisted. `degraded` findings (source/quality advisories, non-fresh dependencies, failed refreshes over retained data, catch-up and mild lateness) are not reader notices: they reach the operator Telegram through the sentinel watchdogs and stay inspectable on /status. `isPublicWarning` is the single visibility authority; components do not invent their own thresholds.
- R2 still binds at the value: an unreadable observation stays unavailable where it is displayed, and suppressing a page-level notice never turns a failed read into a healthy claim. R3/R4 budgets, generations and machine reasons remain in API payloads and /status; only their reader display is removed. Owners: [detail page](./stablecoin-detail-page.md), [Telegram operator alerts](./telegram-alerts.md).

#### ADR-5

**Status:** Superseded · **Relations:** superseded by [ADR-19](#adr-19)

- **ADR-5 — Historical penalty-only score blends.** Superseded by [ADR-19](#adr-19); not an active V9 path. Historical V8 rules: `shared/data/methodology-changelogs/safety-score/v8.json`. Exact historical recomputation requires historical source and retained inputs.

---

## Stablecoin lifecycle phases

Every entry in `TRACKED_STABLECOINS` is in one of five lifecycle phases. The phase controls write-side collection, live aggregates, and public presentation. Phase transitions are a catalog policy change, not a scoring-algorithm change, so per-domain methodology versions are unaffected unless the scoring formula also changes.

| Phase | `status` field | New data collected? | Score recomputation? | Public treatment |
| --- | --- | --- | --- | --- |
| Active | `"active"` (or omitted) | Yes | Yes | Live tables, analytics, aggregates, alerts, and detail page |
| Pre-launch | `"pre-launch"` | No | No | `/upcoming/` and pre-launch detail variant |
| Quarantined | `"quarantined"` plus `listingStatusReview` | No ordinary collection; explicitly expiring reserve-only prerequisite exception | No | Static read-only detail record with reason and review date |
| Delisted | `"delisted"` plus sourced `listingStatusReview` | No | No | Static historical detail record |
| Frozen | `"frozen"` plus `frozenAt` and `obituary` | No | No | `/cemetery/` and preserved archive detail page |

Registry universes/source authoring: [Stablecoin Data](./stablecoin-data.md#source-files). Collection and lifecycle authorization: [Listing Policy](./listing-policy.md#lifecycle-policy). Freeze transition: [procedure](./freezing-stablecoins.md#procedure). Readable/history membership alone never authorizes live collection or cache publication.

## Funding page

The `/funding` route is a static page backed by the hand-maintained cost and donation records under `shared/data/funding/`; it has no cron, D1, or API surface. Use the project `funding-update` skill for the approval-gated research workflow and [Funding Page](./funding-page.md) for the data contract.
