# Documentation Index

Verified entry point for the `/docs` corpus. Use this file to find the authoritative document for a system or workflow before editing.
Application source-of-truth docs live in `/docs/` and [../README.md](../README.md). `/agents/` is a working-artifact archive unless a file there explicitly says otherwise.

## Start Here

- [../README.md](../README.md) - repo overview, local setup, deployment summary
- [agent-task-router.md](./agent-task-router.md) - agent-first task routing from user intent to docs, files, checks, and gotchas
- [agent-code-map.md](./agent-code-map.md) - generated compact code entrypoint/export map for fast discovery
- [api-reference.md](./api-reference.md) - exact HTTP routes, query params, headers, and response contracts
- [architecture.md](./architecture.md) - curated file tree, API inventory, and SEO surface
- [worker-infrastructure.md](./worker-infrastructure.md) - Worker env bindings, cron slots, cache/auth behavior, and status endpoints
- [deployment-process.md](./deployment-process.md) - local merge gate, worktree flow, and CI deploy sequence
- [testing.md](./testing.md) - test commands, CI gates, coverage thresholds, and helpers

## System And Operations

- [architecture.md](./architecture.md) - architecture-significant routes, file tree, and key tables
- [api-reference.md](./api-reference.md) - public and admin API contract reference
- [worker-infrastructure.md](./worker-infrastructure.md) - runtime model, env interface, cron orchestration, and observability
- [operator-origin-access.md](./operator-origin-access.md) - operator-only origin prep, Access setup runbook, and verification steps
- [worker-and-api-limits.md](./worker-and-api-limits.md) - repo-enforced runtime budgets, throttle constants, and external-provider assumptions to re-check before shipping worker changes
- [data-flow-map.md](./data-flow-map.md) - external source -> cron -> D1 -> API -> hook -> page mapping
- [api-endpoint-authoring.md](./api-endpoint-authoring.md) - shared endpoint registry, route-binding, auth/cache/site-data, hook, and test checklist
- [doc-ownership.json](./doc-ownership.json) - advisory source-glob to documentation-update map for agents and reviewers
- [live-reserves.md](./live-reserves.md) - live reserve-sync config, adapter registry, storage, API modes, and frontend/status consumers
- [data-pipeline.md](./data-pipeline.md) - stablecoin sync, price enrichment, FX/metal rates, and integrity guardrails
- [deployment-process.md](./deployment-process.md) - production deploy workflow and merge-gate policy
- [testing.md](./testing.md) - lint/test/coverage workflow and test inventory
- [scripts.md](./scripts.md) - operational and CI helper script inventory

## Runbooks

- [runbooks/blacklist-sync.md](./runbooks/blacklist-sync.md) - blacklist sync incidents, stale windows, and remediation entrypoints
- [runbooks/db-connectivity.md](./runbooks/db-connectivity.md) - D1/connectivity outage triage and recovery checks
- [runbooks/mint-burn-integrity.md](./runbooks/mint-burn-integrity.md) - mint/burn divergence, stale coverage, and repair actions
- [runbooks/stablecoins-cache.md](./runbooks/stablecoins-cache.md) - stablecoins cache availability, provider breaker, and lease recovery

## Route And Page Contracts

- [homepage.md](./homepage.md) - `/` dashboard composition, filter/query contract, Start Here callout behavior, and primary variant-browse ownership
- [alt-pegs-page.md](./alt-pegs-page.md) - `/alt-pegs/` non-USD market-structure route, crawlability pattern, and homepage integration contract
- [start-page.md](./start-page.md) - `/start/` onboarding route, curated route map, and homepage integration contract
- [upcoming-page.md](./upcoming-page.md) - `/upcoming/` pre-launch tracker, filter model, and crawlability contract
- [about-page.md](./about-page.md) - `/about/` section contract and update rules
- [api-page.md](./api-page.md) - `/about/api/` public API reference page, auth summary, and build-time docs rendering contract
- [methodology-page.md](./methodology-page.md) - `/methodology/` section-to-source mapping and changelog/update contract
- [stablecoin-detail-page.md](./stablecoin-detail-page.md) - `/stablecoin/[id]/` route shell, view-model wiring, section order, and fallback/staleness rules
- [chains-page.md](./chains-page.md) - `/chains/` leaderboard, `/chains/[chain]/` profile contract, and Chain Health Score wiring
- [lighthouse-page.md](./lighthouse-page.md) - `/lighthouse/` cinematic route, model, stage layers, and selection contract
- [cemetery-and-compare.md](./cemetery-and-compare.md) - `/cemetery/` and `/compare/` data and URL contracts
- [dependency-map.md](./dependency-map.md) - dependency-graph construction, rendering, and interaction model
- [coverage-page.md](./coverage-page.md) - `/coverage/` matrix contract, source mapping, and update rules
- [funding-page.md](./funding-page.md) - `/funding/` public funding ledger contract and static JSON data model
- [portfolio-page.md](./portfolio-page.md) - `/portfolio/` route shell, local persistence, and report-card dependency contract
- [privacy-page.md](./privacy-page.md) - `/privacy/` longform policy surface, metadata, and footer integration
- [status-dashboard.md](./status-dashboard.md) - `/status/` public health surface plus `/admin/` operator dashboard contract

## Public Route Coverage

Some public routes are documented by feature docs or the architecture doc rather than dedicated route-contract files. Use this map when you know the route first and need the authoritative doc quickly.

| Route                                           | Primary doc(s)                                                                                                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                                             | [homepage.md](./homepage.md)                                                                                                                          |
| `/alt-pegs/`                                    | [alt-pegs-page.md](./alt-pegs-page.md)                                                                                                                |
| `/about/`                                       | [about-page.md](./about-page.md)                                                                                                                      |
| `/about/api/`                                   | [api-page.md](./api-page.md), [api-reference.md](./api-reference.md)                                                                                  |
| `/blacklist/`                                   | [blacklist-tracker.md](./blacklist-tracker.md)                                                                                                        |
| `/cemetery/`                                    | [cemetery-and-compare.md](./cemetery-and-compare.md)                                                                                                  |
| `/changelog/`                                   | [architecture.md](./architecture.md)                                                                                                                  |
| `/chains/`                                      | [chains-page.md](./chains-page.md), [chain-health.md](./chain-health.md), [api-reference.md](./api-reference.md)                                      |
| `/chains/[chain]/`                              | [chains-page.md](./chains-page.md), [chain-health.md](./chain-health.md), [api-reference.md](./api-reference.md)                                      |
| `/lighthouse/`                                  | [lighthouse-page.md](./lighthouse-page.md), [architecture.md](./architecture.md)                                                                      |
| `/compare/`                                     | [cemetery-and-compare.md](./cemetery-and-compare.md)                                                                                                  |
| `/compare/[slug]/`                              | [cemetery-and-compare.md](./cemetery-and-compare.md)                                                                                                  |
| `/coverage/`                                    | [coverage-page.md](./coverage-page.md)                                                                                                                |
| `/depeg/`                                       | [depeg-detection.md](./depeg-detection.md), [dews.md](./dews.md)                                                                                      |
| `/dependency-map/`                              | [dependency-map.md](./dependency-map.md)                                                                                                              |
| `/digest/`                                      | [digest-pipeline.md](./digest-pipeline.md)                                                                                                            |
| `/digest/[date]/`                               | [digest-pipeline.md](./digest-pipeline.md)                                                                                                            |
| `/docs/`                                        | [architecture.md](./architecture.md), [doc-ownership.json](./doc-ownership.json)                                                                      |
| `/docs/[slug]/`                                 | [architecture.md](./architecture.md), [doc-ownership.json](./doc-ownership.json)                                                                      |
| `/flows/`                                       | [mint-burn-flows.md](./mint-burn-flows.md)                                                                                                            |
| `/funding/`                                     | [funding-page.md](./funding-page.md)                                                                                                                  |
| `/liquidity/`                                   | [dex-liquidity.md](./dex-liquidity.md)                                                                                                                |
| `/methodology/`                                 | [methodology-page.md](./methodology-page.md)                                                                                                          |
| `/portfolio/`                                   | [portfolio-page.md](./portfolio-page.md)                                                                                                              |
| `/privacy/`                                     | [privacy-page.md](./privacy-page.md)                                                                                                                  |
| `/safety-scores/`                               | [report-cards.md](./report-cards.md)                                                                                                                  |
| `/stablecoin/[id]/`                             | [stablecoin-detail-page.md](./stablecoin-detail-page.md)                                                                                              |
| `/stability-index/`                             | [stability-index.md](./stability-index.md)                                                                                                            |
| `/start/`                                       | [start-page.md](./start-page.md)                                                                                                                      |
| `/status/`                                      | [status-dashboard.md](./status-dashboard.md)                                                                                                          |
| `/stablecoins/`                                 | [architecture.md](./architecture.md), [classification.md](./classification.md) — taxonomy surface only; tracked-variant browse ownership stays on `/` |
| `/stablecoins/[peg]/`                           | [architecture.md](./architecture.md), [classification.md](./classification.md)                                                                        |
| `/stablecoins/backing/`                         | [architecture.md](./architecture.md), [classification.md](./classification.md)                                                                        |
| `/stablecoins/backing/[backing]/`               | [architecture.md](./architecture.md), [classification.md](./classification.md)                                                                        |
| `/stablecoins/governance/`                      | [architecture.md](./architecture.md), [classification.md](./classification.md)                                                                        |
| `/stablecoins/governance/[governance]/`         | [architecture.md](./architecture.md), [classification.md](./classification.md)                                                                        |
| `/stablecoins/infrastructure/`                  | [architecture.md](./architecture.md), [classification.md](./classification.md)                                                                        |
| `/stablecoins/infrastructure/[infrastructure]/` | [architecture.md](./architecture.md), [classification.md](./classification.md)                                                                        |
| `/telegram/`                                    | [telegram-alerts.md](./telegram-alerts.md)                                                                                                            |
| `/upcoming/`                                    | [upcoming-page.md](./upcoming-page.md)                                                                                                                |
| `/yield/`                                       | [yield-intelligence.md](./yield-intelligence.md)                                                                                                      |

## Operator Routes

These routes are not public product surfaces, but they are part of the maintained operator workflow on `ops.pharos.watch`.

| Route     | Primary doc(s)                                                                                                                                                 |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/admin/` | [status-dashboard.md](./status-dashboard.md), [operator-origin-access.md](./operator-origin-access.md), [api-reference.md](./api-reference.md#admin-endpoints) |

## Route Contract Update Checklist

For route/page behavior changes, start from the route's primary doc above and then verify the adjacent code/checks:

- Page shell and metadata: `src/app/**/page.tsx`, `src/app/layout.tsx`, `src/app/sitemap.ts`, `src/app/robots.ts`
- Client behavior: route `client.tsx`, route view-model helpers, and `src/components/**`
- API/data hooks: `src/hooks/**`, `src/lib/api.ts`, and `shared/lib/api-endpoints/**`
- Checks: route-focused tests when present, `npm run check:verified-doc-links`, `npm run check:doc-source-paths`, and `npm run seo:check` after a Pages build for crawlability changes

## Methodology Changelog Routes

These are public sub-pages of `/methodology/`. Use the route map below when you need the authoritative doc for a specific changelog URL.

| Route                                       | Primary doc(s)                                                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `/methodology/pricing-pipeline-changelog/`  | [methodology-page.md](./methodology-page.md), [pricing-pipeline-timeline.md](./pricing-pipeline-timeline.md)     |
| `/methodology/scoring-changelog/`           | [methodology-page.md](./methodology-page.md), [report-cards-timeline.md](./report-cards-timeline.md)             |
| `/methodology/depeg-changelog/`             | [methodology-page.md](./methodology-page.md), [depeg-dews-timeline.md](./depeg-dews-timeline.md)                 |
| `/methodology/liquidity-score-changelog/`   | [methodology-page.md](./methodology-page.md), [liquidity-score-timeline.md](./liquidity-score-timeline.md)       |
| `/methodology/stability-index-changelog/`   | [methodology-page.md](./methodology-page.md), [stability-index-timeline.md](./stability-index-timeline.md)       |
| `/methodology/blacklist-tracker-changelog/` | [methodology-page.md](./methodology-page.md), [blacklist-tracker-timeline.md](./blacklist-tracker-timeline.md)   |
| `/methodology/mint-burn-flow-changelog/`    | [methodology-page.md](./methodology-page.md), [mint-burn-flows-timeline.md](./mint-burn-flows-timeline.md)       |
| `/methodology/yield-changelog/`             | [methodology-page.md](./methodology-page.md), [yield-intelligence-timeline.md](./yield-intelligence-timeline.md) |
| `/methodology/chain-health-changelog/`      | [methodology-page.md](./methodology-page.md), [chain-health-timeline.md](./chain-health-timeline.md)             |

## Feature And Methodology Docs

- [classification.md](./classification.md) - classification system, peg handling, and commodity/non-DL coin treatment
- [stablecoin-data.md](./stablecoin-data.md) - stablecoin metadata registry files, editing rules, cache-admission checks, and doc touchpoints
- [pricing-pipeline.md](./pricing-pipeline.md) - live-price consensus, authoritative overrides, source normalization, and fallback enrichment
- [bluechip-ratings.md](./bluechip-ratings.md) - Bluechip sync coverage, cache shape, and frontend consumers
- [depeg-detection.md](./depeg-detection.md) - two-stage depeg detection, confirmation, event lifecycle, and peg score inputs
- [dews.md](./dews.md) - DEWS formula, sub-signals, bands, and API contract
- [dex-liquidity.md](./dex-liquidity.md) - liquidity score algorithm, discovery pipeline, and DEX price cross-validation
- [stability-index.md](./stability-index.md) - PSI formula, bands, storage, and API surface
- [report-cards.md](./report-cards.md) - report-card scoring, portfolio analyzer, and stress test
- [redemption-backstops.md](./redemption-backstops.md) - modeled redemption routes, effective-exit scoring, storage, and API/detail consumers
- [supply-snapshot.md](./supply-snapshot.md) - supply snapshot cron, schema, helpers, and API consumers
- [blacklist-tracker.md](./blacklist-tracker.md) - freeze/blacklist coverage, contracts, sync flow, and API/frontend behavior
- [mint-burn-flows.md](./mint-burn-flows.md) - mint/burn ingestion, scoring, schema, and admin backfills
- [yield-intelligence.md](./yield-intelligence.md) - APY resolution, PYS scoring, warning signals, schema, and UI consumers
- [yield-intelligence-operations.md](./yield-intelligence-operations.md) - runtime guardrails and degraded-mode behavior for the `sync-yield-data` cron
- [digest-pipeline.md](./digest-pipeline.md) - digest generation, storage, distribution, and SSG pipeline
- [feedback-pipeline.md](./feedback-pipeline.md) - feedback widget, POST contract, rate limiting, and GitHub routing
- [telegram-alerts.md](./telegram-alerts.md) - Telegram webhook commands, subscription tables, and alert dispatch rules
- [shadow-stablecoins.md](./shadow-stablecoins.md) - PSI-only shadow asset boundary and UI exclusion rules
- [chain-health.md](./chain-health.md) - Chain Health Score inputs, formula, factors, bands, and update contract

## Design References

- [design-context.md](./design-context.md) - user, brand, and product-direction baseline
- [design-language.md](./design-language.md) - live UI patterns, typography, spacing, cards, and responsive rules
- [design-tokens.md](./design-tokens.md) - token layers and CSS variable architecture

## Version Histories

- [chain-health-timeline.md](./chain-health-timeline.md) - Chain Health Score methodology version history
- [blacklist-tracker-timeline.md](./blacklist-tracker-timeline.md) - blacklist methodology version history
- [depeg-dews-timeline.md](./depeg-dews-timeline.md) - depeg tracker and DEWS version history
- [liquidity-score-timeline.md](./liquidity-score-timeline.md) - liquidity score version history
- [mint-burn-flows-timeline.md](./mint-burn-flows-timeline.md) - mint/burn methodology version history
- [pricing-pipeline-timeline.md](./pricing-pipeline-timeline.md) - pricing pipeline methodology version history
- [report-cards-timeline.md](./report-cards-timeline.md) - report-card scoring version history
- [stability-index-timeline.md](./stability-index-timeline.md) - PSI version history
- [yield-intelligence-timeline.md](./yield-intelligence-timeline.md) - yield methodology version history

## Reference Artifact

- [documentation-map-2026-03-05.tsv](./documentation-map-2026-03-05.tsv) - legacy-named documentation surface map retained for audit support; refreshed during later audits and explicitly non-canonical
