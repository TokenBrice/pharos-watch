# Documentation Index

Verified entry point for the `/docs` corpus. Use this file to find the authoritative document for a system or workflow before editing.
Application source-of-truth docs live in `/docs/` and [../README.md](../README.md). Durable process, tracker, and route-maintenance guidance should live in `/docs/`, not in a separate agent archive.

## Start Here

- [../README.md](../README.md) - repo overview, local setup, deployment summary
- [agent-task-router.md](./agent-task-router.md) - agent-first task routing from user intent to docs, files, checks, and gotchas
- [agent-code-map.md](./agent-code-map.md) - generated compact code entrypoint/export map for fast discovery
- [architecture.md](./architecture.md) - curated architecture, route model, and ownership map
- [api-endpoint-authoring.md](./api-endpoint-authoring.md) - compact API endpoint change checklist before reading the full API reference
- [worker-and-api-limits.md](./worker-and-api-limits.md) - compact Worker/API limits before reading deep runtime docs
- [pharos-urn.md](./pharos-urn.md) - public citation/URN contract for methodology, depeg, stablecoin, and About trust surfaces
- [process/agent-artifacts.md](./process/agent-artifacts.md) - routing for durable process docs, trackers, route-maintenance notes, and temporary artifacts

## System And Operations

- [architecture.md](./architecture.md) - architecture-significant routes, file tree, and key tables
- [api-reference.md](./api-reference.md) - public and admin API contract reference; use the affected endpoint section when possible
- [worker-infrastructure.md](./worker-infrastructure.md) - deep runtime model, env interface, cron orchestration, and observability reference
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
- [og-images.md](./og-images.md) - the six OG-image classes (static screenshots, editorial cards, mechanism cards, case-study cards, selector cards, dynamic Worker cards), how/when to renew, and CI guardrails
- [process/adding-a-stablecoin.md](./process/adding-a-stablecoin.md) - repeatable checklist for adding active and pre-launch stablecoins
- [process/stablecoin-research-sidecars.md](./process/stablecoin-research-sidecars.md) - ownership, migration, and coordinated generation rules for research-heavy stablecoin metadata
- [freezing-stablecoins.md](./freezing-stablecoins.md) - operator runbook for transitioning a tracked stablecoin into the `frozen` lifecycle phase
- [security-governance.md](./security-governance.md) - durable security rules (token-in-URL discipline, inline-script policy) and reactive-playbook routing

## Process Policies

- [process/boundary-waivers.md](./process/boundary-waivers.md) - worker import-boundary waiver inventory with retirement rationale
- [process/cron-trigger-policy.md](./process/cron-trigger-policy.md) - governance for adding new cron trigger expressions to the Worker
- [process/d1-baseline-squash-plan.md](./process/d1-baseline-squash-plan.md) - planning doc for the second D1 baseline squash cadence and procedure
- [process/ddrr-calibration.md](./process/ddrr-calibration.md) - advisory DDRR calibration report process for evidence-gated DDR refinements
- [process/feature-flags.md](./process/feature-flags.md) - `NEXT_PUBLIC_PHAROS_*` feature flag inventory and default-state rules
- [process/pages-env-rollout.md](./process/pages-env-rollout.md) - rollout procedure for flipping `NEXT_PUBLIC_PHAROS_*` flags on production Pages

## Runbooks

- [runbooks/blacklist-sync.md](./runbooks/blacklist-sync.md) - blacklist sync incidents, stale windows, and remediation entrypoints
- [runbooks/d1-telemetry-kill-switch.md](./runbooks/d1-telemetry-kill-switch.md) - D1 route/source telemetry kill-switch order and degraded-mode controls
- [runbooks/db-connectivity.md](./runbooks/db-connectivity.md) - D1/connectivity outage triage and recovery checks
- [runbooks/mint-burn-integrity.md](./runbooks/mint-burn-integrity.md) - mint/burn divergence, stale coverage, and repair actions
- [runbooks/stablecoins-cache.md](./runbooks/stablecoins-cache.md) - stablecoins cache availability, provider breaker, and lease recovery
- [runbooks/telegram-admin-broadcast-safety.md](./runbooks/telegram-admin-broadcast-safety.md) - admin broadcast safety controls and dry-run pre-flight
- [runbooks/telegram-backlog-expiration.md](./runbooks/telegram-backlog-expiration.md) - Telegram pending backlog expiration triage and replay window recovery
- [runbooks/telegram-group-admin-gating-rollback.md](./runbooks/telegram-group-admin-gating-rollback.md) - rollback the group-admin hard gate through a code-level mode change and Worker redeploy
- [runbooks/telegram-mini-app-auth-failures.md](./runbooks/telegram-mini-app-auth-failures.md) - diagnose `mini_app_session_invalid` spikes (token rotation, replay, stale clients)
- [runbooks/telegram-mini-app-botfather.md](./runbooks/telegram-mini-app-botfather.md) - capture BotFather Mini App configuration and post-deploy smoke tests
- [runbooks/telegram-no-delivery.md](./runbooks/telegram-no-delivery.md) - Telegram dispatcher reports events but no messages; triage and recovery
- [runbooks/telegram-operator-queries.md](./runbooks/telegram-operator-queries.md) - read-only SQL queries for PharosWatchBot incident triage
- [runbooks/telegram-preset-resolution-failure.md](./runbooks/telegram-preset-resolution-failure.md) - investigate rising preset resolver failures and stale `TRACKED_STABLECOINS` drift
- [runbooks/telegram-rate-limit-storm.md](./runbooks/telegram-rate-limit-storm.md) - Telegram pending queue grows under HTTP 429 retries; backoff and recovery
- [runbooks/telegram-secret-rotation.md](./runbooks/telegram-secret-rotation.md) - rotate Telegram webhook secret and bot token with overlap windows
- [runbooks/telegram-setup-wizard-stuck.md](./runbooks/telegram-setup-wizard-stuck.md) - clear stale `setup-step` rows in `telegram_pending_disambiguation`
- [runbooks/telegram-webhook-retry-dedupe.md](./runbooks/telegram-webhook-retry-dedupe.md) - Telegram webhook retry/dedupe incidents, stuck processing rows, and recovery
- [runbooks/yield-benchmark-fallback-stale.md](./runbooks/yield-benchmark-fallback-stale.md) - yield benchmark fallback, retained-rate, and stale benchmark triage
- [runbooks/yield-deterministic-cooldown.md](./runbooks/yield-deterministic-cooldown.md) - deterministic on-chain all-fail and cooldown triage
- [runbooks/yield-health.md](./runbooks/yield-health.md) - admin yield health summary thresholds and remediation
- [runbooks/yield-history-cleanup-writer-pause.md](./runbooks/yield-history-cleanup-writer-pause.md) - yield-history cleanup writer-pause guard and restore workflow
- [runbooks/yield-rankings-stale-or-missing.md](./runbooks/yield-rankings-stale-or-missing.md) - stale, malformed, or missing yield rankings cache triage
- [runbooks/yield-supplemental-snapshot.md](./runbooks/yield-supplemental-snapshot.md) - empty, malformed, or stale supplemental yield snapshot triage

## Incident Response

- [incident-response/safe-browsing-flag.md](./incident-response/safe-browsing-flag.md) - Google Safe Browsing / browser "Dangerous site" warning recovery

## Route And Page Contracts

- [homepage.md](./homepage.md) - `/` dashboard composition, filter/query contract, saved shortcuts, and primary variant-browse ownership
- [alt-pegs-page.md](./alt-pegs-page.md) - `/alt-pegs/` non-USD market-structure route, crawlability pattern, and homepage integration contract
- [start-page.md](./start-page.md) - `/start/` onboarding route, curated route map, and homepage integration contract
- [upcoming-page.md](./upcoming-page.md) - `/upcoming/` pre-launch tracker, filter model, and crawlability contract
- [about-page.md](./about-page.md) - `/about/` section contract and update rules
- [api-page.md](./api-page.md) - `/api/` self-serve API access page plus `/about/api/` public API reference page, auth summary, and build-time docs rendering contract
- [methodology-page.md](./methodology-page.md) - `/methodology/` section-to-source mapping and changelog/update contract
- [learn-page.md](./learn-page.md) - `/learn/case-studies/`, `/learn/case-studies/[slug]/`, and `/learn/glossary/` route contracts
- [learn-mechanisms-page.md](./learn-mechanisms-page.md) - `/learn/mechanisms/` hub and `/learn/mechanisms/[archetype]/` explainer contract, content schema, and coverage invariant
- [stablecoin-detail-page.md](./stablecoin-detail-page.md) - `/stablecoin/[id]/` route shell, view-model wiring, section order, and fallback/staleness rules
- [chains-page.md](./chains-page.md) - `/chains/` leaderboard, `/chains/[chain]/` profile contract, and Chain Health Score wiring
- [cemetery-and-compare.md](./cemetery-and-compare.md) - `/cemetery/` and `/compare/` data and URL contracts
- [dependency-map.md](./dependency-map.md) - dependency-graph construction, rendering, and interaction model
- [coverage-page.md](./coverage-page.md) - `/coverage/` matrix contract, source mapping, and update rules
- [funding-page.md](./funding-page.md) - `/funding/` public funding ledger contract and static JSON data model
- [portfolio-page.md](./portfolio-page.md) - `/portfolio/` route shell, local persistence, and report-card dependency contract
- [privacy-page.md](./privacy-page.md) - `/privacy/` longform policy surface, metadata, and footer integration
- [status-dashboard.md](./status-dashboard.md) - `/status/` public health surface plus `/admin/` operator dashboard contract
- [tape-page.md](./tape-page.md) - `/timeline/` cross-class event feed route, URL filter contract, digest grouping, projector pipeline, and homepage marquee integration
- [compliance-page.md](./compliance-page.md) - `/compliance/` combined MiCA authorization and GENIUS implementation-watch route contract
- [mica-tracker.md](./mica-tracker.md) - EU MiCA metadata: the `mica` extension, status criteria, and maintenance via the `mica-research` skill
- [genius-tracker.md](./genius-tracker.md) - U.S. GENIUS Act metadata: the `genius` extension, applicability/status criteria, and maintenance via the `genius-research` skill

## Public Route Coverage

Some public routes are documented by feature docs or the architecture doc rather than dedicated route-contract files. Use this map when you know the route first and need the authoritative doc quickly.

| Route                                           | Primary doc(s)                                                                                                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                                             | [homepage.md](./homepage.md)                                                                                                                          |
| `/alt-pegs/`                                    | [alt-pegs-page.md](./alt-pegs-page.md)                                                                                                                |
| `/about/`                                       | [about-page.md](./about-page.md)                                                                                                                      |
| `/about/api/`                                   | [api-page.md](./api-page.md), [api-reference.md](./api-reference.md)                                                                                  |
| `/about/bluechip/`                              | [about-page.md](./about-page.md), [bluechip-ratings.md](./bluechip-ratings.md), [report-cards.md](./report-cards.md)                                 |
| `/api/`                                         | [api-page.md](./api-page.md), [api-reference.md](./api-reference.md)                                                                                  |
| `/blacklist/`                                   | [blacklist-tracker.md](./blacklist-tracker.md) — legacy redirect alias for `/freezewatch/`                                                             |
| `/freezewatch/`                                 | [blacklist-tracker.md](./blacklist-tracker.md)                                                                                                        |
| `/cemetery/`                                    | [cemetery-and-compare.md](./cemetery-and-compare.md)                                                                                                  |
| `/changelog/`                                   | [architecture.md](./architecture.md)                                                                                                                  |
| `/chains/`                                      | [chains-page.md](./chains-page.md), [chain-health.md](./chain-health.md), [api-reference.md](./api-reference.md)                                      |
| `/chains/[chain]/`                              | [chains-page.md](./chains-page.md), [chain-health.md](./chain-health.md), [api-reference.md](./api-reference.md)                                      |
| `/compare/`                                     | [cemetery-and-compare.md](./cemetery-and-compare.md)                                                                                                  |
| `/compare/[slug]/`                              | [cemetery-and-compare.md](./cemetery-and-compare.md)                                                                                                  |
| `/coverage/`                                    | [coverage-page.md](./coverage-page.md)                                                                                                                |
| `/depeg/`                                       | [depeg-detection.md](./depeg-detection.md), [dews.md](./dews.md)                                                                                      |
| `/depeg/[event]/`                               | [depeg-detection.md](./depeg-detection.md), [dews.md](./dews.md)                                                                                      |
| `/dependency-map/`                              | [dependency-map.md](./dependency-map.md)                                                                                                              |
| `/digest/`                                      | [digest-pipeline.md](./digest-pipeline.md)                                                                                                            |
| `/digest/[date]/`                               | [digest-pipeline.md](./digest-pipeline.md)                                                                                                            |
| `/docs/`                                        | [architecture.md](./architecture.md), [doc-ownership.json](./doc-ownership.json)                                                                      |
| `/docs/[slug]/`                                 | [architecture.md](./architecture.md), [doc-ownership.json](./doc-ownership.json)                                                                      |
| `/feed/cemetery/`                               | [architecture.md](./architecture.md), [cemetery-and-compare.md](./cemetery-and-compare.md)                                                            |
| `/feed/cemetery.xml/`                           | [architecture.md](./architecture.md), [cemetery-and-compare.md](./cemetery-and-compare.md)                                                            |
| `/feed/depeg/`                                  | [architecture.md](./architecture.md), [depeg-detection.md](./depeg-detection.md)                                                                      |
| `/feed/depeg.xml/`                              | [architecture.md](./architecture.md), [depeg-detection.md](./depeg-detection.md)                                                                      |
| `/feed/digest/`                                 | [architecture.md](./architecture.md), [digest-pipeline.md](./digest-pipeline.md)                                                                      |
| `/feed/digest.xml/`                             | [architecture.md](./architecture.md), [digest-pipeline.md](./digest-pipeline.md)                                                                      |
| `/feed/methodology/`                            | [architecture.md](./architecture.md), [methodology-page.md](./methodology-page.md)                                                                    |
| `/feed/methodology.xml/`                        | [architecture.md](./architecture.md), [methodology-page.md](./methodology-page.md)                                                                    |
| `/flows/`                                       | [mint-burn-flows.md](./mint-burn-flows.md)                                                                                                            |
| `/funding/`                                     | [funding-page.md](./funding-page.md)                                                                                                                  |
| `/learn/`                                       | [learn-page.md](./learn-page.md), [learn-mechanisms-page.md](./learn-mechanisms-page.md)                                                               |
| `/learn/case-studies/`                          | [learn-page.md](./learn-page.md)                                                                                                                      |
| `/learn/case-studies/[slug]/`                   | [learn-page.md](./learn-page.md), [depeg-detection.md](./depeg-detection.md)                                                                          |
| `/learn/glossary/`                              | [learn-page.md](./learn-page.md), [methodology-page.md](./methodology-page.md)                                                                        |
| `/learn/mechanisms/`                            | [learn-mechanisms-page.md](./learn-mechanisms-page.md)                                                                                                |
| `/learn/mechanisms/[archetype]/`                | [learn-mechanisms-page.md](./learn-mechanisms-page.md), [classification.md](./classification.md)                                                      |
| `/liquidity/`                                   | [dex-liquidity.md](./dex-liquidity.md)                                                                                                                |
| `/methodology/`                                 | [methodology-page.md](./methodology-page.md)                                                                                                          |
| `/compliance/`                                  | [compliance-page.md](./compliance-page.md), [mica-tracker.md](./mica-tracker.md)                                                                       |
| `/portfolio/`                                   | [portfolio-page.md](./portfolio-page.md)                                                                                                              |
| `/privacy/`                                     | [privacy-page.md](./privacy-page.md)                                                                                                                  |
| `/safety-scores/`                               | [report-cards.md](./report-cards.md)                                                                                                                  |
| `/screener/`                                    | [architecture.md](./architecture.md), [homepage.md](./homepage.md), [classification.md](./classification.md), [dews.md](./dews.md), [dex-liquidity.md](./dex-liquidity.md), [mint-authority-scoring.md](./mint-authority-scoring.md), [report-cards.md](./report-cards.md) |
| `/screener/picker/`                             | [screener-picker-page.md](./screener-picker-page.md)                                                                                                  |
| `/sitemap-tree/`                                | [architecture.md](./architecture.md)                                                                                                                  |
| `/stablecoin/[id]/`                             | [stablecoin-detail-page.md](./stablecoin-detail-page.md)                                                                                              |
| `/stablecoin/[id]/yield/`                       | [yield-intelligence.md](./yield-intelligence.md), [stablecoin-detail-page.md](./stablecoin-detail-page.md)                                            |
| `/stability-index/`                             | [stability-index.md](./stability-index.md)                                                                                                            |
| `/start/`                                       | [start-page.md](./start-page.md)                                                                                                                      |
| `/status/`                                      | [status-dashboard.md](./status-dashboard.md)                                                                                                          |
| `/timeline/`                                    | [tape-page.md](./tape-page.md)                                                                                                                        |
| `/stablecoins/`                                 | [architecture.md](./architecture.md), [classification.md](./classification.md) — taxonomy surface only; tracked-variant browse ownership stays on `/` |
| `/stablecoins/[peg]/`                           | [architecture.md](./architecture.md), [classification.md](./classification.md)                                                                        |
| `/stablecoins/backing/`                         | [architecture.md](./architecture.md), [classification.md](./classification.md)                                                                        |
| `/stablecoins/backing/[backing]/`               | [architecture.md](./architecture.md), [classification.md](./classification.md)                                                                        |
| `/stablecoins/governance/`                      | [architecture.md](./architecture.md), [classification.md](./classification.md)                                                                        |
| `/stablecoins/governance/[governance]/`         | [architecture.md](./architecture.md), [classification.md](./classification.md)                                                                        |
| `/stablecoins/infrastructure/`                  | [architecture.md](./architecture.md), [classification.md](./classification.md)                                                                        |
| `/stablecoins/infrastructure/[infrastructure]/` | [architecture.md](./architecture.md), [classification.md](./classification.md)                                                                        |
| `/pharoswatchbot/`                              | [telegram-alerts.md](./telegram-alerts.md) — canonical PharosWatchBot page; `/telegram` is a redirect alias                                           |
| `/pharoswatchbot/app/`                          | [telegram-mini-app.md](./telegram-mini-app.md) — Telegram Mini App surface; metadata is noindex/nofollow, robots-disallowed, and omitted from sitemap |
| `/upcoming/`                                    | [upcoming-page.md](./upcoming-page.md)                                                                                                                |
| `/yield/`                                       | [yield-intelligence.md](./yield-intelligence.md)                                                                                                      |

## Operator Routes

These routes are not public product surfaces, but they are part of the maintained operator workflow on `ops.pharos.watch`.

| Route     | Primary doc(s)                                                                                                                                                 |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/admin/`     | [status-dashboard.md](./status-dashboard.md), [operator-origin-access.md](./operator-origin-access.md), [api-reference.md](./api-reference.md#admin-endpoints) |
| `/admin-api/` | [api-page.md](./api-page.md), [operator-origin-access.md](./operator-origin-access.md), [api-reference.md](./api-reference.md#admin-endpoints)                 |
| `/api/admin/*` | [api-page.md](./api-page.md), [operator-origin-access.md](./operator-origin-access.md), [api-reference.md](./api-reference.md#admin-endpoints)                 |

## Route Contract Update Checklist

For route/page behavior changes, start from the route's primary doc above and then verify the adjacent code/checks:

- Route inventory: every retained `src/app/**/page.tsx` route should be represented in the public/operator route maps above, or explicitly documented as excluded/noindex utility behavior.
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
| `/methodology/depeg-resolver-changelog/`    | [methodology-page.md](./methodology-page.md), [depeg-resolver-timeline.md](./depeg-resolver-timeline.md)         |
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
- [depeg-resolver.md](./depeg-resolver.md) - Depeg Duration Resolver (DDR): two-stage will-it-repeg / expected-duration outlook, verdict tiers, and API contract
- [dex-liquidity.md](./dex-liquidity.md) - liquidity score algorithm, discovery pipeline, and DEX price cross-validation
- [mint-authority-scoring.md](./mint-authority-scoring.md) - Mint Authority Score formula, caps, bands, inheritance, public surfaces, and the v8.0 Decentralization blend
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
- [telegram-alerts.md](./telegram-alerts.md) - PharosWatchBot page route, Telegram webhook commands, subscription tables, and alert dispatch rules
- [telegram-architecture.md](./telegram-architecture.md) - PharosWatchBot worker seams, ownership, and freeze-window rules
- [telegram-mini-app.md](./telegram-mini-app.md) - Telegram Mini App surface: launch entrypoints, payload registry, auth model, seam rules, debugging workflow
- [shadow-stablecoins.md](./shadow-stablecoins.md) - PSI-only shadow asset boundary and UI exclusion rules
- [chain-health.md](./chain-health.md) - Chain Health Score inputs, formula, factors, bands, and update contract

## Design References

- [design-context.md](./design-context.md) - user, brand, and product-direction baseline
- [design-language.md](./design-language.md) - live UI patterns, typography, spacing, cards, and responsive rules
- [design-tokens.md](./design-tokens.md) - token layers and CSS variable architecture
- [data-visualization.md](./data-visualization.md) - metaphor-led visualization surfaces (Fiat World Atlas, PSI Lighthouse, DEWS Radar, Nautical Harbor Chart)

## Version Histories

- [chain-health-timeline.md](./chain-health-timeline.md) - Chain Health Score methodology version history
- [blacklist-tracker-timeline.md](./blacklist-tracker-timeline.md) - blacklist methodology version history
- [depeg-dews-timeline.md](./depeg-dews-timeline.md) - depeg tracker and DEWS version history
- [depeg-resolver-timeline.md](./depeg-resolver-timeline.md) - Depeg Duration Resolver methodology version history
- [liquidity-score-timeline.md](./liquidity-score-timeline.md) - liquidity score version history
- [mint-burn-flows-timeline.md](./mint-burn-flows-timeline.md) - mint/burn methodology version history
- [pricing-pipeline-timeline.md](./pricing-pipeline-timeline.md) - pricing pipeline methodology version history
- [report-cards-timeline.md](./report-cards-timeline.md) - report-card scoring version history
- Redemption Backstop history is machine-readable in `shared/lib/methodology-versions/redemption-backstop.ts` and currently deep-links to `/methodology/#safety-scores-methodology` because redemption backstops feed Safety Score liquidity rather than a standalone public changelog route.
- Mint Authority Score history is machine-readable in `shared/lib/methodology-versions/mint-authority.ts` and currently deep-links to `/methodology/#mint-authority-score` rather than a standalone public changelog route.
- [stability-index-timeline.md](./stability-index-timeline.md) - PSI version history
- [yield-intelligence-timeline.md](./yield-intelligence-timeline.md) - yield methodology version history
