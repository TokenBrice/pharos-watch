# Documentation Index

Verified entry point for Pharos documentation. Code, schemas, registries, and checked runtime data remain the source of truth; docs explain durable contracts, operator procedures, and public methodology.

## Start Here

- [../README.md](../README.md) - repository overview, local setup, and deployment summary
- [process/agent-start-here.md](./process/agent-start-here.md) - canonical routing, harness workflow, and handoff guidance
- [architecture.md](./architecture.md) - runtime boundaries, host model, and architectural decisions
- [data-flow-map.md](./data-flow-map.md) - source-to-cron-to-API-to-page flow map
- [process/agent-artifacts.md](./process/agent-artifacts.md) - durable documentation versus temporary research

## Audiences

Pharos keeps four kinds of documentation:

| Audience | Content | Source of inventory |
| --- | --- | --- |
| Public readers and integrators | Public architecture, methodology, design, and API reference rendered at `/docs/` | `shared/lib/public-docs.ts` |
| Maintainers | Engineering and route contracts in `docs/*.md` | [doc-ownership.json](./doc-ownership.json) and source entrypoints |
| Operators | Repeatable policies in `docs/process/` | The owning process file |
| Incident responders | Symptom-led procedures in `docs/runbooks/` and `docs/incident-response/` | The relevant status surface or feature doc |

Public and internal material can share a source file only when the public text remains useful without exposing operator-only detail. Prefer a public methodology contract plus a focused internal operations document when those audiences diverge.

## Engineering Entry Points

Use [Agent Start Here](./process/agent-start-here.md), the canonical source-to-document routing guide for engineering changes. The [Audiences](#audiences) section above provides the audience-level entry points.

Route-specific contracts use descriptive filenames such as `homepage.md`, `*-page.md`, `stablecoin-detail-page.md`, and `status-dashboard.md`. Find the owning route doc from Agent Start Here or with:

```bash
rg -n '/route-name/|src/app/route-name' docs
```

## Route Contracts

- [api-page.md](./api-page.md) - public API access and reference pages
- [cemetery-and-compare.md](./cemetery-and-compare.md) - cemetery and compare surfaces
- [depeg-page.md](./depeg-page.md) - depeg and recovery incident board, hero contract, and event archive routing
- [portfolio-page.md](./portfolio-page.md) - personal stablecoin risk workspace
- [upcoming-page.md](./upcoming-page.md) - pre-launch stablecoin tracker
- [homepage.md](./homepage.md) and [about-page.md](./about-page.md) - dashboard and product/source overview
- [coverage-page.md](./coverage-page.md), [start-page.md](./start-page.md), and [feedback-pipeline.md](./feedback-pipeline.md) - coverage availability, onboarding, and feedback delivery
- [compliance-page.md](./compliance-page.md) - compliance workbench; regime evidence is owned by [mica-tracker.md](./mica-tracker.md) and [genius-tracker.md](./genius-tracker.md)

## Cross-Cutting Contracts

- [api-reference.md](./api-reference.md) - public integration routes, schemas, authentication, and cache policy; [api-reference-admin.md](./api-reference-admin.md) is the internal operator-route companion and is not published through `/docs/`
- [One-shot historical backfills](./runbooks/one-shot-backfills.md#operator-contract) - operator-only CLI rebuilds and staged captures, atomic-import availability consent, interrupted-run reconciliation and receipt cleanup
- [pharos-urn.md](./pharos-urn.md) - stable citation identifiers and JSON-LD integration
- [telegram-architecture.md](./telegram-architecture.md) - Telegram seam index; routes ingress/storage to Architecture, commands/dispatch/delivery to Alerts, and client/auth/state to the Mini App contract
- [pricing-pipeline.md](./pricing-pipeline.md), [supply-snapshot.md](./supply-snapshot.md), [stability-index.md](./stability-index.md), [depeg-detection.md](./depeg-detection.md), and [blacklist-tracker.md](./blacklist-tracker.md) - authoritative data-pipeline feature contracts; [data-flow-map.md](./data-flow-map.md) remains the routing diagram
- [design-language.md](./design-language.md#context) - design context and reusable UI rules; [design-tokens.md](./design-tokens.md) owns implementation tokens
- [live-reserves.md](./live-reserves.md#registry-defined-adapter-classes) and [yield-intelligence.md](./yield-intelligence.md#engineering-contract) - reserve evidence admission and yield publication contracts

## Stale Output Diagnosis

Start with the producing job and the affected publication, not a successful deploy or a healthy-looking latest attempt. Choose the symptom owner from the complete [Runbook Index](#runbook-index). For reserve snapshot versus latest-attempt semantics, use the [Live Reserve API Contract](./live-reserves.md#api-contract).

Follow [Monitoring Without Model Polling](./deployment-process.md#monitoring-without-model-polling) for `ops:watch-worker-cron` / `ops:night-watch-worker`: capture the affected generation, job, activation and observation window. A single snapshot or watcher exit zero does not certify the next execution or publication health. Remote D1 inspection uses read-only `SELECT` with `--command`, never `--file`; see [Remote D1 Inspection](./worker-infrastructure.md#remote-d1-inspection) for the import-lock hazard.

## Runbook Index

<!-- GENERATED-START: runbook-index -->
<!-- Generated by scripts/maintenance/generate-runbook-index.ts from docs/doc-ownership.json. Do not edit by hand. -->

Complete coverage of `docs/runbooks/` and `docs/incident-response/`. Labels and applicability are curated in existing ownership references, not inferred from filenames. **Symptom** pages diagnose an observed failure; **procedure** pages guide an operator task; **reference** pages provide queries or configuration. Follow each page's prerequisites, authority and stop conditions before acting.

| Applicability | Runbook |
| --- | --- |
| symptom | [Blacklist gap checks](./runbooks/blacklist-sync.md) |
| symptom | [Blocked digest edition](./runbooks/blocked-digest-edition.md) |
| symptom | [Scheduled delivery stall](./runbooks/cron-delivery-stall.md) |
| symptom | [Cron slot abandonment](./runbooks/cron-slot-abandonment.md) |
| symptom | [D1 connectivity failure](./runbooks/db-connectivity.md) |
| symptom | [Mint/burn integrity diagnosis](./runbooks/mint-burn-integrity.md) |
| symptom | [Stablecoin cache or publication failure](./runbooks/stablecoins-cache.md) |
| symptom | [Telegram backlog and expiration risk](./runbooks/telegram-backlog-expiration.md) |
| symptom | [Telegram bot-wide delivery outage](./runbooks/telegram-bot-wide-outage.md) |
| symptom | [Telegram digest outbox recovery](./runbooks/telegram-digest-outbox.md) |
| symptom | [Telegram Mini App auth failures](./runbooks/telegram-mini-app-auth-failures.md) |
| symptom | [Telegram alerts not delivering](./runbooks/telegram-no-delivery.md) |
| symptom | [Telegram preset resolution failure](./runbooks/telegram-preset-resolution-failure.md) |
| symptom | [Telegram rate-limit storm](./runbooks/telegram-rate-limit-storm.md) |
| symptom | [Telegram setup wizard stuck](./runbooks/telegram-setup-wizard-stuck.md) |
| symptom | [Telegram webhook retry and dedupe](./runbooks/telegram-webhook-retry-dedupe.md) |
| symptom | [Yield benchmark fallback or stale state](./runbooks/yield-benchmark-fallback-stale.md) |
| symptom | [Yield deterministic all-fail cooldown](./runbooks/yield-deterministic-cooldown.md) |
| symptom | [Yield rankings stale or missing](./runbooks/yield-rankings-stale-or-missing.md) |
| symptom | [Yield supplemental snapshot failure](./runbooks/yield-supplemental-snapshot.md) |
| procedure | [Safe Browsing flag response](./incident-response/safe-browsing-flag.md) |
| procedure | [D1 capacity pressure and runtime experiments](./runbooks/d1-capacity-and-runtime-experiments.md) |
| procedure | [D1 telemetry kill switch](./runbooks/d1-telemetry-kill-switch.md) |
| procedure | [Dated-source scheduled renewal boundaries](./runbooks/dated-source-age-caps.md#scheduled-boundaries) |
| procedure | [Reviewed depeg artifact removal](./runbooks/depeg-artifact-removal.md) |
| procedure | [Depeg lifecycle review](./runbooks/depeg-lifecycle-review.md) |
| procedure | [Dependency coverage audit commands](./runbooks/dependency-network.md#scope-and-commands) |
| procedure | [Lease and circuit-breaker recovery](./runbooks/lease-and-breaker-recovery.md) |
| procedure | [One-shot historical backfill contract](./runbooks/one-shot-backfills.md#operator-contract) |
| procedure | [Scoped review renewal](./runbooks/review-renewal.md) |
| procedure | [Telegram broadcast preflight](./runbooks/telegram-admin-broadcast-safety.md) |
| procedure | [Telegram group-admin gating rollback](./runbooks/telegram-group-admin-gating-rollback.md) |
| procedure | [Telegram BotFather configuration](./runbooks/telegram-mini-app-botfather.md) |
| procedure | [Telegram secret rotation](./runbooks/telegram-secret-rotation.md) |
| procedure | [Yield history cleanup and writer pause](./runbooks/yield-history-cleanup-writer-pause.md) |
| reference | [Telegram adoption report queries](./runbooks/telegram-adoption-report.md) |
| reference | [Telegram ingress abuse-control contract](./runbooks/telegram-ingress-abuse-controls.md) |
| reference | [Telegram read-only operator queries](./runbooks/telegram-operator-queries.md#read-only-incident-entry) |
| reference | [Telegram webhook flood-control contract](./runbooks/telegram-webhook-ingress.md) |
| reference | [Workflow failure reporting contract](./runbooks/workflow-incidents.md) |
| reference | [Yield health diagnostics](./runbooks/yield-health.md) |

<!-- GENERATED-END: runbook-index -->

## Process Index

This process index is curated, not a complete inventory. Start with [Agent Start Here](./process/agent-start-here.md), then open only the process owner needed for the task. Skill wrappers below are task-specific `.codex/skills/` workflows that directly reference the page; `none` means no dedicated wrapper.

| Process document | Kind | Skill wrapper | Primary command | Verification command |
| --- | --- | --- | --- | --- |
| [Adding a Stablecoin](./process/adding-a-stablecoin.md) | runbook | `stablecoin-addition-orchestrator`, `resilience-classify`, `pre-launch-update`, `write-ai-summaries` | `npm run bootstrap:generated` | `npm run check:stablecoin-data` |
| [Agent Artifacts](./process/agent-artifacts.md) | convention | `pharos-docs-sync-audit`, `pharos-release-runner` | none | `npm run check:agent-skills` |
| [Blog Publishing](./process/blog-publishing.md) | runbook | `changelog-collect` | edit the post body and registry | `npx vitest run src/data/blog src/app/feed src/app/__tests__/sitemap-frozen.test.ts` |
| [Worker Import Boundary Waivers](./process/boundary-waivers.md) | policy | none | none; review and document the waiver | `npx vitest run scripts/__tests__/eslint-import-boundaries.test.ts` |
| [Cron Trigger Budget Policy](./process/cron-trigger-policy.md) | policy | `worker-cron-change` | `npm run check:cron-connections` | `npm run check:cron-sync` |
| [D1 Baseline Squash Policy](./process/d1-baseline-squash-plan.md) | runbook | `d1-migration-rollout` | rehearse against two fresh D1 databases | `npm run check:migrations` |
| [D1 Migration Authoring](./process/d1-migrations.md) | policy | `d1-migration-rollout` | add migration SQL and manifest evidence | `npm run check:migrations` |
| [DDRR Calibration](./process/ddrr-calibration.md) | methodology | `safety-score-curation` | `npm run calibrate:ddrr -- --prod --report agents/ddrr-calibration-report.md` | semantic review; no pass/fail gate |
| [Feature Flags](./process/feature-flags.md) | policy | none | `NEXT_PUBLIC_PHAROS_<NAME>=true npm run dev` | `npm run check:stale-flags` |
| [Font Assets](./process/font-assets.md) | runbook | none | `npm run subset:fonts` | `npm run subset:fonts -- --check` |
| [Mechanism-overlay Evidence Standard](./process/mechanism-overlay-evidence-standard.md) | methodology | `safety-score-curation` | none; apply the evidence standard | pinned-envelope replay and attributed mover review |
| [Protocol API Mechanism Refresh](./process/protocol-api-mechanism-refresh.md) | runbook | `safety-score-curation` | `npx tsx scripts/maintenance/measure-protocol-api-mechanism-metrics.ts --asset <asset>` | `npx tsx scripts/maintenance/measure-protocol-api-mechanism-metrics.ts --replay-all` — strict original-byte readback; unavailable bodies fail (local/cache or signed R2 reads) |
| [Safety Score Curation-Expiry Sweep](./process/safety-score-curation-expiry-sweep.md) | runbook | `safety-score-curation` | `npm run safety-score-v9:replay -- --input <capture> --output <replay> --published-at <clock>` | complete the [closeout gates](./process/safety-score-curation-expiry-sweep.md#6-close-the-weekly-sweep) |
| [Safety Score Equivalence Harness](./process/safety-score-equivalence-harness.md) | methodology | `safety-score-curation` | `npm run safety-score-v9:replay -- --input <capture> --output <replay> --published-at <clock>` | `npm run safety-score-v9:diff -- --baseline <baseline> --candidate <candidate> --assert-empty` |
| [CDP Shock-Coverage Refresh](./process/shock-coverage-refresh.md) | runbook | `safety-score-curation` | `npx tsx scripts/maintenance/measure-cdp-shock-coverage.ts --asset <asset>` | `node --import tsx scripts/ci/check-shock-coverage-freshness.ts` |
| [Stablecoin Research Sidecars](./process/stablecoin-research-sidecars.md) | runbook | `compliance-research`, `reserve-research`, `stablecoin-addition-orchestrator` | `npx tsx scripts/maintenance/generate-stablecoin-per-coin-asset.ts` | `npm run check:stablecoin-data` |
| [Worker Runtime Experiments](./process/worker-runtime-experiments.md) | runbook | `worker-cron-change` | `npm run ops:benchmark-worker-compatibility -- --candidate-date YYYY-MM-DD` (permanent tooling; replication benchmark retired) | all four role/date bundle/startup/smoke outcomes; future replication evaluation separately approved |

## Methodology History

Versioned methodology history is authored once under `shared/data/methodology-changelogs/`. The registry in `shared/lib/methodology-versions/registry.ts` powers public changelog routes and Markdown exports. ADR-3 in [architecture.md](./architecture.md#architectural-decision-records) owns the list of what a methodology change must update, including the runtime version source.

Historical Markdown timeline files are intentionally not maintained.

## Documentation Rules

- Keep durable behavior and non-obvious invariants; omit restatements of component trees and implementation order that source makes obvious.
- Do not hardcode volatile inventory counts or exhaustive file lists. Link to the owning registry or generate the view.
- Give any doc at or above roughly 50 KB or 400 lines a top `Agent navigation` block (short heading list with grep hints) so agents section-read instead of loading it wholesale; the ~1,500-line rule for `docs/api-reference.md` stays the hard case.
- Keep temporary audits, calibration captures, screenshots, and handoffs under ignored `/agents/` paths.
- Put repeatable operating policy in `docs/process/` and incident remediation in `docs/runbooks/`.
- Runbook navigation is generated from curated `runbook` labels and applicability (`symptom`, `procedure`, or `reference`) on existing `docs`/`background` references in [doc-ownership.json](./doc-ownership.json). Label each new incident page there and regenerate with `node --import tsx scripts/maintenance/generate-runbook-index.ts`; the generator rejects missing or stale coverage.
- Add a new document only when no existing owner can hold the durable material cleanly.

## Validation

Use the checks relevant to the change:

```bash
npm run check:verified-doc-links
npm run check:doc-source-paths
npm run check:doc-sync
npm run check:generated-artifacts -- --only=agents-doc
```

Generated API and public artifacts have their own checks in `package.json` and `scripts/lib/automation-registry.mjs`.
