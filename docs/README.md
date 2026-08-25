# Documentation Index

Verified entry point for Pharos documentation. Code, schemas, registries, and checked runtime data remain the source of truth; docs explain durable contracts, operator procedures, and public methodology.

## Start Here

- [../README.md](../README.md) - repository overview, local setup, and deployment summary
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

| Area | Read first |
| --- | --- |
| Worker, hosts, and scheduling | [architecture.md](./architecture.md), [worker-and-api-limits.md](./worker-and-api-limits.md), matched section of [worker-infrastructure.md](./worker-infrastructure.md) |
| API endpoint work | [api-endpoint-authoring.md](./api-endpoint-authoring.md), affected section of [api-reference.md](./api-reference.md) |
| CI, tests, and releases | [deployment-process.md](./deployment-process.md) release snapshot state machine, then matched sections of [testing.md](./testing.md) and [scripts.md](./scripts.md) |
| Stablecoin metadata | [stablecoin-data.md](./stablecoin-data.md), [listing-policy.md](./listing-policy.md), [classification.md](./classification.md), [process/adding-a-stablecoin.md](./process/adding-a-stablecoin.md) |
| Pricing and supply | [data-pipeline.md](./data-pipeline.md), [pricing-pipeline.md](./pricing-pipeline.md), [supply-snapshot.md](./supply-snapshot.md) |
| Reserves and exits | [live-reserves.md](./live-reserves.md), [redemption-backstops.md](./redemption-backstops.md) |
| Risk methodology | [report-cards.md](./report-cards.md), [depeg-detection.md](./depeg-detection.md), [dews.md](./dews.md), [dex-liquidity.md](./dex-liquidity.md) |
| Flow and freeze monitoring | [mint-burn-flows.md](./mint-burn-flows.md), [blacklist-tracker.md](./blacklist-tracker.md) |
| Safety Score V9 operations | [process/safety-score-equivalence-harness.md](./process/safety-score-equivalence-harness.md), [process/safety-score-curation-expiry-sweep.md](./process/safety-score-curation-expiry-sweep.md), [process/protocol-api-mechanism-refresh.md](./process/protocol-api-mechanism-refresh.md) |
| Yield | [yield-intelligence.md](./yield-intelligence.md), [yield-intelligence-operations.md](./yield-intelligence-operations.md) |
| Telegram | [telegram-architecture.md](./telegram-architecture.md), [telegram-alerts.md](./telegram-alerts.md), [telegram-mini-app.md](./telegram-mini-app.md) |
| Design and visualization | [design-context.md](./design-context.md), [design-language.md](./design-language.md), [design-tokens.md](./design-tokens.md), [data-visualization.md](./data-visualization.md), [process/font-assets.md](./process/font-assets.md) |

Route-specific contracts use descriptive filenames such as `homepage.md`, `*-page.md`, `stablecoin-detail-page.md`, and `status-dashboard.md`. Find the owning route doc from the task router or with:

```bash
rg -n '/route-name/|src/app/route-name' docs
```

## Methodology History

Versioned methodology history is authored once under `shared/data/methodology-changelogs/`. The registry in `shared/lib/methodology-versions/registry.ts` powers public changelog routes and Markdown exports. ADR-3 in [architecture.md](./architecture.md#architectural-decision-records) owns the list of what a methodology change must update, including the runtime version source.

Historical Markdown timeline files are intentionally not maintained.

## Documentation Rules

- Keep durable behavior and non-obvious invariants; omit restatements of component trees and implementation order that source makes obvious.
- Do not hardcode volatile inventory counts or exhaustive file lists. Link to the owning registry or generate the view.
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
