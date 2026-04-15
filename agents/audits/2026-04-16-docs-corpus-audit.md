# Docs Corpus Audit - 2026-04-16

## Executive Summary

Scope: all 60 files under `docs/`, plus the repo-level docs validators and source files needed to verify API, cron, env, test-inventory, and file-path claims.

Health: the verified docs corpus is structurally healthy but too duplicated. Existing validators passed before edits:

- `npm run check:verified-doc-links`
- `npm run check:doc-counts`
- `npm run check:doc-sync`
- `npm run check:env-contract`

Verified high-risk accuracy: good for link integrity, hardcoded counts, methodology constants, and env contracts; weaker for hand-maintained inventories and runtime-budget prose. This pass found 8 verified discrepancies, all concentrated in route inventory, cron/Telegram runtime limits, and stale source-file paths. No fully orphaned docs were found after accounting for `docs/README.md`, but many leaf docs have no outbound navigation by design.

Redundancy level: high. `api-reference.md`, `architecture.md`, `worker-infrastructure.md`, `worker-and-api-limits.md`, `testing.md`, `deployment-process.md`, `scripts.md`, and `data-flow-map.md` repeat command, endpoint, cron, and cache/auth concepts. The duplication is manageable today because validators cover some exact values, but unvalidated tables already drifted.

Top priorities:

1. Keep exact API contracts canonical in `docs/api-reference.md`; keep `docs/architecture.md` as an inventory only.
2. Replace hand-maintained source/test path tables with generated or validator-backed inventories.
3. Add a source-path doc check for backtick file references under `docs/`.
4. Reduce repeated CI/deploy command lists to one canonical source plus links.

## Inventory

Last update is from `git log -1 --date=short -- <file>` before this audit's edits.

| File | Audience | Purpose | Last update |
| --- | --- | --- | --- |
| `docs/README.md` | Contributors/agents | Canonical docs index, route map, and methodology-doc map | 2026-04-14 |
| `docs/about-page.md` | Contributors | `/about/` page contract and update rules | 2026-04-16 |
| `docs/agent-code-map.md` | Agents/contributors | Generated source entrypoint/export discovery map | 2026-04-15 |
| `docs/agent-task-router.md` | Agents | Task-to-doc/source/check routing guide | 2026-04-14 |
| `docs/api-page.md` | Contributors/API consumers | `/about/api/` rendering contract for API docs | 2026-04-08 |
| `docs/api-reference.md` | API consumers/operators | Canonical public/admin HTTP contract | 2026-04-16 |
| `docs/architecture.md` | Contributors/operators | Route inventory, file tree, SEO and runtime orientation | 2026-04-16 |
| `docs/blacklist-tracker-timeline.md` | Contributors | Blacklist methodology/version history | 2026-04-15 |
| `docs/blacklist-tracker.md` | Contributors/API consumers | Blacklist tracker methodology, data model, API/UI behavior | 2026-04-16 |
| `docs/bluechip-ratings.md` | Contributors | Bluechip sync coverage and cache/API consumers | 2026-04-08 |
| `docs/cemetery-and-compare.md` | Contributors | `/cemetery/` and `/compare/` route contracts | 2026-03-26 |
| `docs/chain-health-timeline.md` | Contributors | Chain Health Score methodology history | 2026-04-07 |
| `docs/chains-page.md` | Contributors | `/chains/` and `/chains/[chain]/` contracts | 2026-04-14 |
| `docs/classification.md` | Contributors | Classification, peg, infrastructure, and commodity handling | 2026-04-10 |
| `docs/coverage-page.md` | Contributors | `/coverage/` matrix contract and source mapping | 2026-04-15 |
| `docs/data-flow-map.md` | Contributors/operators | Domain-level upstream-to-UI flow map | 2026-04-14 |
| `docs/data-pipeline.md` | Contributors/operators | Stablecoin sync, pricing enrichment, FX/metal, integrity rules | 2026-04-15 |
| `docs/depeg-detection.md` | Contributors/API consumers | Depeg detection and PegScore pipeline | 2026-04-08 |
| `docs/depeg-dews-timeline.md` | Contributors | Depeg/DEWS methodology history | 2026-04-15 |
| `docs/dependency-map.md` | Contributors | Dependency graph construction and UI behavior | 2026-03-30 |
| `docs/deployment-process.md` | Operators/contributors | Merge gate, deploy flow, rollback, production workflow | 2026-04-14 |
| `docs/design-context.md` | Designers/contributors | Product/user/design baseline | 2026-03-24 |
| `docs/design-language.md` | Designers/contributors | Current UI language and deployed component patterns | 2026-04-03 |
| `docs/design-tokens.md` | Designers/contributors | Token layers and CSS variable architecture | 2026-03-26 |
| `docs/dews.md` | Contributors/API consumers | DEWS formula, signals, storage, and API contract | 2026-04-16 |
| `docs/dex-liquidity.md` | Contributors/API consumers | Liquidity score and DEX discovery/scoring pipeline | 2026-04-16 |
| `docs/digest-pipeline.md` | Contributors/operators | Digest generation, archive, distribution, SSG sync | 2026-04-15 |
| `docs/doc-ownership.json` | Agents/reviewers | Source-glob to doc-update advisory map | 2026-04-14 |
| `docs/documentation-map-2026-03-05.tsv` | Auditors | Legacy documentation surface map, non-canonical | 2026-03-22 |
| `docs/feedback-pipeline.md` | Contributors/operators | Feedback widget/API/GitHub routing | 2026-04-14 |
| `docs/homepage.md` | Contributors | Homepage composition and filter/query contract | 2026-04-09 |
| `docs/liquidity-score-timeline.md` | Contributors | Liquidity methodology history | 2026-04-14 |
| `docs/live-reserves.md` | Contributors/operators | Live reserves config, adapters, store, API/status consumers | 2026-04-16 |
| `docs/methodology-page.md` | Contributors | `/methodology/` source mapping and changelog contract | 2026-04-14 |
| `docs/mint-burn-flows-timeline.md` | Contributors | Mint/burn methodology history | 2026-04-14 |
| `docs/mint-burn-flows.md` | Contributors/API consumers | Mint/burn ingestion, scoring, API, UI, admin backfills | 2026-04-14 |
| `docs/operator-origin-access.md` | Operators | Ops host split, Cloudflare Access setup, verification | 2026-04-14 |
| `docs/portfolio-page.md` | Contributors | `/portfolio/` route shell and local persistence contract | 2026-04-14 |
| `docs/pricing-pipeline-timeline.md` | Contributors | Pricing methodology history | 2026-04-15 |
| `docs/pricing-pipeline.md` | Contributors/API consumers | Price consensus, source roster, fallback enrichment | 2026-04-15 |
| `docs/privacy-page.md` | Contributors/legal reviewers | `/privacy/` content and metadata contract | 2026-03-25 |
| `docs/redemption-backstops.md` | Contributors/API consumers | Redemption route scoring, storage, API/detail consumers | 2026-04-16 |
| `docs/report-cards-timeline.md` | Contributors | Safety Score methodology history | 2026-04-16 |
| `docs/report-cards.md` | Contributors/API consumers | Report-card scoring, raw inputs, portfolio/stress behavior | 2026-04-16 |
| `docs/scripts.md` | Contributors/operators | Operational and CI helper script inventory | 2026-04-14 |
| `docs/shadow-stablecoins.md` | Contributors | PSI-only shadow asset boundary | 2026-04-08 |
| `docs/stability-index-timeline.md` | Contributors | PSI methodology history | 2026-04-08 |
| `docs/stability-index.md` | Contributors/API consumers | PSI formula, storage, API, UI behavior | 2026-04-08 |
| `docs/stablecoin-detail-page.md` | Contributors | `/stablecoin/[id]/` route, view model, sections | 2026-04-10 |
| `docs/start-page.md` | Contributors | `/start/` onboarding route and homepage integration | 2026-04-06 |
| `docs/status-dashboard.md` | Operators/contributors | `/status/` public and `/admin/` operator dashboard contract | 2026-04-14 |
| `docs/supply-snapshot.md` | Contributors/operators | Supply snapshot cron, schema, helpers, API consumers | 2026-04-14 |
| `docs/telegram-alerts.md` | Operators/contributors | Telegram webhook, subscriptions, dispatch cron | 2026-04-08 |
| `docs/testing.md` | Contributors/operators | Test/lint/CI gate reference and test inventory | 2026-04-16 |
| `docs/upcoming-page.md` | Contributors | `/upcoming/` pre-launch tracker contract | 2026-04-13 |
| `docs/worker-and-api-limits.md` | Operators/contributors | Repo-enforced limits, budgets, timeouts | 2026-04-16 |
| `docs/worker-infrastructure.md` | Operators/contributors | Worker env/auth/cache/cron/observability/migrations | 2026-04-15 |
| `docs/yield-intelligence-operations.md` | Operators | Yield cron runtime guardrails | 2026-03-27 |
| `docs/yield-intelligence-timeline.md` | Contributors | Yield methodology history | 2026-04-13 |
| `docs/yield-intelligence.md` | Contributors/API consumers | Yield source resolution, scoring, API, UI behavior | 2026-04-14 |

## Dependency Map

High-incoming docs:

| Doc | Incoming verified links | Role |
| --- | ---: | --- |
| `docs/api-reference.md` | 16 | Canonical HTTP contract |
| `docs/architecture.md` | 15 | Source/route orientation hub |
| `docs/methodology-page.md` | 13 | Methodology route hub |
| `docs/data-pipeline.md` | 10 | Stablecoin sync/pricing support hub |
| `docs/worker-infrastructure.md` | 9 | Worker/runtime operations hub |
| `docs/classification.md` | 8 | Shared metadata semantics hub |

No file was completely orphaned. `docs/README.md` links every canonical doc, so incoming-count alone is not enough to prove discoverability. Leaf docs with no outbound docs links include route contracts, timelines, and reference docs such as `about-page.md`, `api-page.md`, `blacklist-tracker.md`, and `classification.md`; this is acceptable when the index is their parent.

Intentional cycles exist around hub docs:

- `README.md` links almost all docs; some docs link back to `README.md`.
- `data-pipeline.md` links `pricing-pipeline.md` and `stability-index.md`.
- `pricing-pipeline.md` links back to `data-pipeline.md`.
- `homepage.md`, `start-page.md`, and `design-language.md` cross-link because behavior and visual contract overlap.

## Inaccuracies Found

```
[INACCURACY] docs/architecture.md:29
  Documented: Endpoint inventory listed `/api/chains` then `/api/supply-history`, omitting `/api/non-usd-share`.
  Actual:     `shared/lib/api-endpoints/definitions.ts`, `API_PATHS.nonUsdShare()`, `worker/src/routes/public-routes.ts`, and `docs/api-reference.md` define `GET /api/non-usd-share`.
  Action:     fix the doc
  Status:     fixed in `docs/architecture.md`
```

```
[INACCURACY] docs/worker-infrastructure.md:498
  Documented: Telegram dispatch trigger uses 1 max concurrent external connection with 5 headroom.
  Actual:     `worker/src/cron/telegram-pending-queue.ts` sets `SEND_BATCH_SIZE = 5`; `sendBatch()` and pending-queue drain send up to 5 Telegram requests concurrently.
  Action:     fix the doc and the cron-budget metadata
  Status:     fixed in `docs/worker-infrastructure.md` and `shared/lib/cron-jobs.ts`
```

```
[INACCURACY] docs/worker-infrastructure.md:500
  Documented: Daily 08:05 trigger uses 4 max concurrent external connections.
  Actual:     `worker/src/cron/sync-bluechip.ts` fetches Bluechip slugs in parallel batches of 3 while the Anthropic digest path and CoinGecko discovery can run concurrently; runtime peak is 5 because daily digest and weekly recap are chained.
  Action:     fix the doc; flag checker/metadata modeling for a follow-up because `check-cron-connection-budget` does not encode chained subgroups.
  Status:     fixed in `docs/worker-infrastructure.md`; metadata modeling remains a follow-up.
```

```
[INACCURACY] docs/telegram-alerts.md:223
  Documented: Per-coin subscription booleans listed DEWS, depeg, and safety only.
  Actual:     `worker/src/cron/dispatch-telegram-alerts.ts` and `worker/src/api/telegram-webhook-store.ts` also use `alert_launch`.
  Action:     fix the doc
  Status:     fixed in `docs/telegram-alerts.md`
```

```
[INACCURACY] docs/telegram-alerts.md:229
  Documented: Global all-stablecoin flags listed DEWS, depeg, and safety only.
  Actual:     `GLOBAL_ALERT_COLUMN_BY_TYPE` includes `global_alert_launch`; webhook list rendering also reads it.
  Action:     fix the doc
  Status:     fixed in `docs/telegram-alerts.md`
```

```
[INACCURACY] docs/telegram-alerts.md:270
  Documented: Retryable pending sends retry up to 2 times / 3 attempts total.
  Actual:     `drainPendingQueue()` retries while `attempts < 5`; `telegram-pending-queue.test.ts` verifies `attempts=4` retries and `attempts=5` drops.
  Action:     fix the doc
  Status:     fixed in `docs/telegram-alerts.md`
```

```
[INACCURACY] docs/live-reserves.md:468
  Documented: File index referenced `worker/src/lib/live-reserves-store-view.ts`.
  Actual:     That file does not exist. The current split is `live-reserves-store-overview.ts` and `live-reserves-store-response.ts`.
  Action:     fix the doc
  Status:     fixed in `docs/live-reserves.md`
```

```
[INACCURACY] docs/testing.md:575,578,579,585,595,597,598,599
  Documented: Test inventory mapped several tests to non-existent source files (`jwt-verify.ts`, `mint-burn-parse.ts`, `mint-burn-roundtrip-sweep.ts`, `psi-benchmark-scenarios.ts`, `report-cards-snapshot-topo.ts`, `stablecoins-cache-validation.ts`, `status-evaluation-state.ts`, `telegram-bot-stats.ts`).
  Actual:     The tests import current modules under `shared/lib/cloudflare-access-jwt.ts`, `worker/src/lib/mint-burn-pipeline/*`, `worker/src/lib/stability-index.ts`, `worker/src/lib/report-cards-snapshot.ts`, `worker/src/lib/stablecoins-cache.ts`, and `worker/src/lib/status/*`.
  Action:     fix the doc
  Status:     fixed in `docs/testing.md`
```

## Redundancy Map

| Duplicated content | Locations | Risk | Recommendation |
| --- | --- | --- | --- |
| Endpoint inventory and route descriptions | `api-reference.md`, `architecture.md`, `worker-infrastructure.md`, `data-flow-map.md` | One route omission was found in `architecture.md` | Canonicalize exact contracts in `api-reference.md`; keep `architecture.md` as generated/validated inventory only; data-flow map should link to API reference for schema detail |
| Cron schedules and connection budgets | `worker-infrastructure.md`, `worker-and-api-limits.md`, `data-flow-map.md`, `shared/lib/cron-jobs.ts`, handler comments | Telegram and daily 08:05 budget drift | Keep schedules/budgets in `shared/lib/cron-jobs.ts`; have docs state runtime intent and link to checker output; add support for chained subgroups or document the exception |
| CI/merge-gate command lists | `testing.md`, `deployment-process.md`, `scripts.md`, `scripts/lib/validate-contract.mjs`, workflows | Manual lists can lag after validation changes | Treat `scripts/lib/validate-contract.mjs` and workflows as code truth; docs should show high-level phases plus `npm run test:merge-gate` |
| Test inventory | `testing.md` plus actual `__tests__` tree | Several stale source targets found | Replace exhaustive source-target table with generated command and only document critical suites manually |
| Methodology versions and timelines | Runtime methodology docs, timeline docs, public methodology components, version modules | Mostly covered by `check:doc-sync`, but timeline prose is long | Keep exact version labels in shared version modules; timeline docs remain changelogs, methodology docs stay current behavior |
| Design conventions | `design-context.md`, `design-language.md`, `design-tokens.md`, route docs | Some style guidance duplicated in route docs | Keep tokens in `design-tokens.md`, product patterns in `design-language.md`, route docs only note route-specific deviations |

## Condensation Opportunities

| File/section | Current size | Target size | Notes |
| --- | ---: | ---: | --- |
| `docs/api-reference.md` | 3192 lines | 2400-2700 lines | Keep exact schema detail, but remove repeated admin auth boilerplate under every admin endpoint by linking to one admin-auth section |
| `docs/worker-infrastructure.md` | 1187 lines | 800-900 lines | Move repeated cron tables toward generated summaries; keep env/auth/cache/migration runbooks |
| `docs/testing.md` | 987 lines | 550-700 lines | Replace stale exhaustive test inventory with discovery commands and a curated critical-suite table |
| `docs/yield-intelligence.md` | 884 lines | 650-750 lines | Split operations-only detail to `yield-intelligence-operations.md`; keep user/API methodology in the main doc |
| `docs/blacklist-tracker.md` | 847 lines | 650-750 lines | Collapse historical caveats already captured in timeline; keep current coverage/API semantics |
| `docs/architecture.md` | 716 lines | 450-550 lines | Rely on `agent-code-map.md` for exhaustive file discovery; keep only architecture-significant tree slices |
| `docs/mint-burn-flows.md` | 653 lines | 500-575 lines | Move backfill/operator minutiae to an operations subsection or script docs |

## Completeness Gaps

- There is no automated check for backtick source-file paths in `docs/`; this pass found stale paths with a one-off Node scan.
- `docs/testing.md` tries to be an exhaustive test map, but the actual test tree is much larger and changes faster than the doc. The current doc should either be generated or explicitly scoped to critical suites.
- `check-cron-connection-budget` cannot express chained jobs within one trigger. This is why the daily 08:05 runtime peak needs prose explanation even though the simple checker sums per-job metadata.
- `docs/README.md` maps public routes well, but `/admin/` is only indirectly discoverable through `status-dashboard.md`; private-route discoverability could be clearer for operators.
- Several docs are leaf nodes with no outbound "next" links. That is acceptable for timelines, but route-contract docs would be more actionable with a short "related code/checks" footer.

## Proposed Changes

Priority 1 - fixed in this pass:

1. Add `GET /api/non-usd-share` to `docs/architecture.md`.
2. Correct Telegram dispatch connection budget in `docs/worker-infrastructure.md` and `shared/lib/cron-jobs.ts`.
3. Correct daily 08:05 connection peak in `docs/worker-infrastructure.md`.
4. Add missing `alert_launch` / `global_alert_launch` fields to `docs/telegram-alerts.md`.
5. Correct pending Telegram retry semantics in `docs/telegram-alerts.md`.
6. Replace stale live-reserve store file path in `docs/live-reserves.md`.
7. Replace stale test-target source paths in `docs/testing.md`.

Priority 2 - recommended follow-up:

1. Add a repo script for source-path reference validation in docs, then wire it into `check:verified-doc-links` or the merge gate.
2. Refactor the cron connection-budget metadata/checker to model chained subgroups inside a trigger.
3. Slim `docs/testing.md` by replacing broad test inventory tables with generated discovery commands and a critical-suite reference.
4. Reduce repeated admin auth and idempotency boilerplate in `docs/api-reference.md` by linking each admin endpoint to one canonical section.
5. Move file-tree detail out of `docs/architecture.md` where `docs/agent-code-map.md` already provides generated discovery.

## Validation

Pre-fix checks:

- `npm run check:verified-doc-links` passed.
- `npm run check:doc-counts` passed.
- `npm run check:doc-sync` passed.
- `npm run check:env-contract` passed.

Post-fix checks:

- `npm run check:verified-doc-links` passed.
- `npm run check:doc-counts` passed.
- `npm run check:cron-connections` passed, now reporting `fiveMinuteTelegramAlerts` as `5/6`.
- `npm run check:doc-sync` passed.
- `npm run check:env-contract` passed.
- `npm test -- worker/src/cron/__tests__/telegram-pending-queue.test.ts` passed (11 tests).
- One-off source-path scan across Markdown backtick paths found no missing file-path references after the edits.
