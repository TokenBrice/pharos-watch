# Documentation Index

Verified entry point for Pharos documentation. Code, schemas, registries, and checked runtime data remain the source of truth; docs explain durable contracts, operator procedures, and public methodology.

## Start Here

- [../README.md](../README.md) - repository overview, local setup, and deployment summary
- [process/agent-start-here.md](./process/agent-start-here.md) - compact, harness-neutral agent workflow from routing through handoff
- [agent-task-router.md](./agent-task-router.md) - find the smallest relevant docs and checks for a change
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

Use the [Agent Task Router](./agent-task-router.md), the canonical source-to-document routing guide for engineering changes. The [Audiences](#audiences) section above provides the audience-level entry points.

Route-specific contracts use descriptive filenames such as `homepage.md`, `*-page.md`, `stablecoin-detail-page.md`, and `status-dashboard.md`. Find the owning route doc from the task router or with:

```bash
rg -n '/route-name/|src/app/route-name' docs
```

## Route Contracts

- [api-page.md](./api-page.md) - public API access and reference pages
- [cemetery-and-compare.md](./cemetery-and-compare.md) - cemetery and compare surfaces
- [portfolio-page.md](./portfolio-page.md) - personal stablecoin risk workspace
- [upcoming-page.md](./upcoming-page.md) - pre-launch stablecoin tracker

## Cross-Cutting Contracts

- [pharos-urn.md](./pharos-urn.md) - stable citation identifiers and JSON-LD integration
- [telegram-architecture.md](./telegram-architecture.md) - Telegram seam index; routes ingress/storage to Architecture, commands/dispatch/delivery to Alerts, and client/auth/state to the Mini App contract
- [pricing-pipeline.md](./pricing-pipeline.md), [supply-snapshot.md](./supply-snapshot.md), [stability-index.md](./stability-index.md), [depeg-detection.md](./depeg-detection.md), and [blacklist-tracker.md](./blacklist-tracker.md) - authoritative data-pipeline feature contracts; [data-flow-map.md](./data-flow-map.md) remains the routing diagram
- [design-language.md](./design-language.md#context) - design context and reusable UI rules; [design-tokens.md](./design-tokens.md) owns implementation tokens

## Process Index

Start with [Agent Start Here](./process/agent-start-here.md), then open only the process owner needed for the task. Skill wrappers below are the `.codex/skills/` workflows that directly reference the page; `none` means the page is used directly.

| Process document | Kind | Skill wrapper | Primary command | Verification command |
| --- | --- | --- | --- | --- |
| [Adding a Stablecoin](./process/adding-a-stablecoin.md) | runbook | `stablecoin-identity-contracts`, `compliance-research`, `resilience-classify`, `reserve-research`, `stablecoin-addition-orchestrator` | `npm run bootstrap:generated` | `npm run check:stablecoin-data` |
| [Agent Artifacts](./process/agent-artifacts.md) | convention | `pharos-docs-sync-audit`, `pharos-release-runner` | none | `npm run check:agent-skills` |
| [Blog Publishing](./process/blog-publishing.md) | runbook | none | edit the post body and registry | `npx vitest run src/data/blog src/app/feed src/app/__tests__/sitemap-frozen.test.ts` |
| [Worker Import Boundary Waivers](./process/boundary-waivers.md) | policy | none | none; review and document the waiver | `npx vitest run scripts/__tests__/eslint-import-boundaries.test.ts` |
| [Cron Trigger Budget Policy](./process/cron-trigger-policy.md) | policy | none | `npm run check:cron-connections` | `npm run check:cron-sync` |
| [D1 Baseline Squash Policy](./process/d1-baseline-squash-plan.md) | runbook | none | rehearse against two fresh D1 databases | `npm run check:migrations` |
| [DDRR Calibration](./process/ddrr-calibration.md) | methodology | none | `npm run calibrate:ddrr -- --prod --report agents/ddrr-calibration-report.md` | semantic review; no pass/fail gate |
| [Feature Flags](./process/feature-flags.md) | policy | none | `NEXT_PUBLIC_PHAROS_<NAME>=true npm run dev` | `npm run check:stale-flags` |
| [Font Assets](./process/font-assets.md) | runbook | none | `npm run subset:fonts` | `npm run subset:fonts -- --check` |
| [Mechanism-overlay Evidence Standard](./process/mechanism-overlay-evidence-standard.md) | methodology | `stablecoin-addition-orchestrator` | none; apply the evidence standard | pinned-envelope replay and attributed mover review |
| [Protocol API Mechanism Refresh](./process/protocol-api-mechanism-refresh.md) | runbook | none | `npx tsx scripts/maintenance/measure-protocol-api-mechanism-metrics.ts --asset <asset>` | `npx tsx scripts/maintenance/measure-protocol-api-mechanism-metrics.ts --replay-all` |
| [Safety Score Curation-Expiry Sweep](./process/safety-score-curation-expiry-sweep.md) | runbook | none | `npm run safety-score-v9:replay -- --input <capture> --output <replay> --published-at <clock>` | complete the five closeout gates in the runbook |
| [Safety Score Equivalence Harness](./process/safety-score-equivalence-harness.md) | methodology | none | `npm run safety-score-v9:replay -- --input <capture> --output <replay> --published-at <clock>` | `npm run safety-score-v9:diff -- --baseline <baseline> --candidate <candidate> --assert-empty` |
| [CDP Shock-Coverage Refresh](./process/shock-coverage-refresh.md) | runbook | `pharos-ci-failure-triage` | `npx tsx scripts/maintenance/measure-cdp-shock-coverage.ts --asset <asset>` | `node --import tsx scripts/ci/check-shock-coverage-freshness.ts` |
| [Stablecoin Research Sidecars](./process/stablecoin-research-sidecars.md) | runbook | `compliance-research`, `reserve-research`, `stablecoin-addition-orchestrator` | `npx tsx scripts/maintenance/generate-stablecoin-per-coin-asset.ts` | `npm run check:stablecoin-data` |
| [Worker Runtime Experiments](./process/worker-runtime-experiments.md) | runbook | none | `npm run ops:benchmark-worker-compatibility -- --candidate-date YYYY-MM-DD` | compare both bundle/startup checks and local smoke runs |

## Methodology History

Versioned methodology history is authored once under `shared/data/methodology-changelogs/`. The registry in `shared/lib/methodology-versions/registry.ts` powers public changelog routes and Markdown exports. ADR-3 in [architecture.md](./architecture.md#architectural-decision-records) owns the list of what a methodology change must update, including the runtime version source.

Historical Markdown timeline files are intentionally not maintained.

## Documentation Rules

- Keep durable behavior and non-obvious invariants; omit restatements of component trees and implementation order that source makes obvious.
- Do not hardcode volatile inventory counts or exhaustive file lists. Link to the owning registry or generate the view.
- Give any doc at or above roughly 50 KB or 400 lines a top `Agent navigation` block (short heading list with grep hints) so agents section-read instead of loading it wholesale; the ~1,500-line rule for `docs/api-reference.md` stays the hard case.
- Keep temporary audits, calibration captures, screenshots, and handoffs under ignored `/agents/` paths.
- Put repeatable operating policy in `docs/process/` and incident remediation in `docs/runbooks/`.
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
