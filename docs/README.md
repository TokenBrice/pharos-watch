# Documentation Index

Verified entry point for the `/docs` corpus. Use this file to find the authoritative document for a system or workflow before editing.
Application source-of-truth docs live in `/docs/` and [../README.md](../README.md). `/agents/` is a working-artifact archive unless a file there explicitly says otherwise.

## Start Here

- [../README.md](../README.md) - repo overview, local setup, deployment summary
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
- [live-reserves.md](./live-reserves.md) - live reserve-sync config, adapter registry, storage, API modes, and frontend/status consumers
- [data-pipeline.md](./data-pipeline.md) - stablecoin sync, price enrichment, FX/metal rates, and integrity guardrails
- [deployment-process.md](./deployment-process.md) - production deploy workflow and merge-gate policy
- [testing.md](./testing.md) - lint/test/coverage workflow and test inventory
- [scripts.md](./scripts.md) - operational and CI helper script inventory

## Route And Page Contracts

- [homepage.md](./homepage.md) - `/` dashboard composition, filter/query contract, and Start Here callout behavior
- [start-page.md](./start-page.md) - `/start/` onboarding route, curated route map, and homepage integration contract
- [about-page.md](./about-page.md) - `/about/` section contract and update rules
- [methodology-page.md](./methodology-page.md) - `/methodology/` section-to-source mapping and changelog/update contract
- [stablecoin-detail-page.md](./stablecoin-detail-page.md) - `/stablecoin/[id]/` route shell, view-model wiring, section order, and fallback/staleness rules
- [chains-page.md](./chains-page.md) - `/chains/` leaderboard, `/chains/[chain]/` profile contract, and Chain Health Score wiring
- [cemetery-and-compare.md](./cemetery-and-compare.md) - `/cemetery/` and `/compare/` data and URL contracts
- [dependency-map.md](./dependency-map.md) - dependency-graph construction, rendering, and interaction model
- [coverage-page.md](./coverage-page.md) - `/coverage/` matrix contract, source mapping, and update rules
- [portfolio-page.md](./portfolio-page.md) - `/portfolio/` route shell, local persistence, and report-card dependency contract
- [privacy-page.md](./privacy-page.md) - `/privacy/` longform policy surface, metadata, and footer integration
- [status-dashboard.md](./status-dashboard.md) - `/status/` public health surface plus `/admin/` operator dashboard contract

## Public Route Coverage

Some public routes are documented by feature docs or the architecture doc rather than dedicated route-contract files. Use this map when you know the route first and need the authoritative doc quickly.

| Route | Primary doc(s) |
|-------|-----------------|
| `/blacklist/` | [blacklist-tracker.md](./blacklist-tracker.md) |
| `/chains/` | [chains-page.md](./chains-page.md), [api-reference.md](./api-reference.md) |
| `/chains/[chain]/` | [chains-page.md](./chains-page.md), [api-reference.md](./api-reference.md) |
| `/compare/[slug]/` | [cemetery-and-compare.md](./cemetery-and-compare.md) |
| `/depeg/` | [depeg-detection.md](./depeg-detection.md), [dews.md](./dews.md) |
| `/digest/` | [digest-pipeline.md](./digest-pipeline.md) |
| `/digest/[date]/` | [digest-pipeline.md](./digest-pipeline.md) |
| `/flows/` | [mint-burn-flows.md](./mint-burn-flows.md) |
| `/liquidity/` | [dex-liquidity.md](./dex-liquidity.md) |
| `/safety-scores/` | [report-cards.md](./report-cards.md) |
| `/stability-index/` | [stability-index.md](./stability-index.md) |
| `/stablecoins/[peg]/` | [architecture.md](./architecture.md), [classification.md](./classification.md) |
| `/stablecoins/backing/[backing]/` | [architecture.md](./architecture.md), [classification.md](./classification.md) |
| `/stablecoins/governance/[governance]/` | [architecture.md](./architecture.md), [classification.md](./classification.md) |
| `/telegram/` | [telegram-alerts.md](./telegram-alerts.md) |
| `/yield/` | [yield-intelligence.md](./yield-intelligence.md) |

## Feature And Methodology Docs

- [classification.md](./classification.md) - classification system, peg handling, and commodity/non-DL coin treatment
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
- [digest-pipeline.md](./digest-pipeline.md) - digest generation, storage, distribution, and SSG pipeline
- [feedback-pipeline.md](./feedback-pipeline.md) - feedback widget, POST contract, rate limiting, and GitHub routing
- [telegram-alerts.md](./telegram-alerts.md) - Telegram webhook commands, subscription tables, and alert dispatch rules
- [shadow-stablecoins.md](./shadow-stablecoins.md) - PSI-only shadow asset boundary and UI exclusion rules

## Design References

- [design-context.md](./design-context.md) - user, brand, and product-direction baseline
- [design-language.md](./design-language.md) - live UI patterns, typography, spacing, cards, and responsive rules
- [design-tokens.md](./design-tokens.md) - token layers and CSS variable architecture

## Version Histories

- [blacklist-tracker-timeline.md](./blacklist-tracker-timeline.md) - blacklist methodology version history
- [depeg-dews-timeline.md](./depeg-dews-timeline.md) - depeg tracker and DEWS version history
- [liquidity-score-timeline.md](./liquidity-score-timeline.md) - liquidity score version history
- [mint-burn-flows-timeline.md](./mint-burn-flows-timeline.md) - mint/burn methodology version history
- [report-cards-timeline.md](./report-cards-timeline.md) - report-card scoring version history
- [stability-index-timeline.md](./stability-index-timeline.md) - PSI version history
- [yield-intelligence-timeline.md](./yield-intelligence-timeline.md) - yield methodology version history

## Reference Artifact

- [documentation-map-2026-03-05.tsv](./documentation-map-2026-03-05.tsv) - legacy-named documentation surface map retained for audit support; refreshed during later audits and explicitly non-canonical
