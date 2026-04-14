# Agent Task Router

Fast path for agents to identify the smallest useful context set before editing. This complements, but does not replace, the verified docs index in [README.md](./README.md).

Use this order:

1. Match the user request to the closest task family below.
2. Read only the listed docs needed for that family.
3. Inspect the listed source entrypoints, then follow local imports only as needed.
4. Use [doc-ownership.json](./doc-ownership.json) to check which docs may need updates.

## Task Families

| Task family | Read first | Runtime entrypoints | Targeted checks to consider | Docs usually affected | Agent gotchas |
| --- | --- | --- | --- | --- | --- |
| Stablecoin metadata or registry | [classification.md](./classification.md), [shadow-stablecoins.md](./shadow-stablecoins.md), `shared/data/stablecoins/AGENTS.md` | `shared/data/stablecoins/*.json`, `shared/lib/stablecoins/index.ts`, `shared/lib/stablecoins/schema.ts`, `shared/lib/stablecoin-id-registry.ts` | `npm run check:stablecoin-data`, stablecoin registry tests | [about-page.md](./about-page.md), [classification.md](./classification.md), feature methodology docs if behavior changes | Do not add manual/on-chain/CMC/DEX supply overrides. Keep canonical order and data schema aligned. |
| Pricing pipeline or source roster | [pricing-pipeline.md](./pricing-pipeline.md), [data-pipeline.md](./data-pipeline.md), [pricing-pipeline-timeline.md](./pricing-pipeline-timeline.md) | `worker/src/cron/sync-stablecoins/*`, `worker/src/lib/price-consensus.ts`, `worker/src/lib/price-validation.ts`, `worker/src/lib/authoritative-price-sources.ts`, `shared/lib/pricing-provider-config.ts` | `npm run audit:pricing-providers`, relevant pricing/depeg tests | [pricing-pipeline.md](./pricing-pipeline.md), [pricing-pipeline-timeline.md](./pricing-pipeline-timeline.md), [data-pipeline.md](./data-pipeline.md), [about-page.md](./about-page.md) | Consume/cancel failed fetch bodies before opening more Worker fetches. DefiLlama list supply is already USD-denominated. |
| Public or admin API endpoint | [api-reference.md](./api-reference.md), [architecture.md](./architecture.md), [worker-infrastructure.md](./worker-infrastructure.md) | `shared/lib/api-endpoints/*`, `worker/src/routes/*`, `worker/src/router.ts`, `worker/src/api/*`, `src/hooks/api-hooks.ts` | Handler contract tests, `npm run test:critical-contracts` when endpoint is critical | [api-reference.md](./api-reference.md), route/page contract doc, [data-flow-map.md](./data-flow-map.md) if pipeline-facing | Route flags, site-data allowlists, cache profiles, and auth lane behavior are centralized. Do not hand-roll local route metadata. |
| Worker cron or scheduled pipeline | [worker-infrastructure.md](./worker-infrastructure.md), [worker-and-api-limits.md](./worker-and-api-limits.md), [data-flow-map.md](./data-flow-map.md) | `shared/lib/cron-jobs.ts`, `shared/lib/scheduled-runner-registry.ts`, `worker/src/handlers/scheduled/*`, `worker/src/cron/*` | `npm run check:cron-sync`, `npm run check:cron-connections`, targeted cron tests | [worker-infrastructure.md](./worker-infrastructure.md), [worker-and-api-limits.md](./worker-and-api-limits.md), feature methodology docs | Cron jobs share Cloudflare's per-trigger connection pool. Pick the trigger slot before adding fetch-heavy work. |
| D1 schema or migration | [deployment-process.md](./deployment-process.md), [worker-infrastructure.md](./worker-infrastructure.md), `worker/migrations/MANIFEST.md` | `worker/migrations/*.sql`, `worker/src/lib/db*.ts`, feature store modules | `npm run check:migrations`, focused API/cron tests | [worker-infrastructure.md](./worker-infrastructure.md), [api-reference.md](./api-reference.md) if response shape changes | Standard deploy applies migrations before the new Worker is live. New migrations must be backward-compatible. |
| Frontend page or route behavior | Route-specific doc from [README.md](./README.md), [architecture.md](./architecture.md), `src/AGENTS.md` | `src/app/**/page.tsx`, `src/app/**/client.tsx`, `src/components/**`, `src/hooks/**`, `src/lib/page-metadata.ts` | Relevant component/page tests, `npm run build`, `npm run seo:check` for Pages-impacting work | Route contract doc, [architecture.md](./architecture.md), [design-language.md](./design-language.md) for UI changes | Static export means route metadata, sitemap, and crawlability can matter even when UI behavior is simple. |
| Design or UI polish | [design-context.md](./design-context.md), [design-language.md](./design-language.md), [design-tokens.md](./design-tokens.md) | `src/app/globals.css`, `src/styles/tokens/*`, `src/components/**`, route client modules | Relevant component/page tests, visual/browser smoke if requested | Design docs when deployed class/token patterns change | Preserve existing Pharos design language. Do not edit `src/components/ui/` shadcn primitives unless explicitly required. |
| Methodology/scoring change | [methodology-page.md](./methodology-page.md), specific methodology doc and timeline doc | `shared/lib/*-version.ts`, scoring module in `shared/lib/**` or `worker/src/**`, `src/app/methodology/sections/**` | Focused scoring tests, `npm run check:doc-sync` | Runtime methodology doc, timeline doc, `/methodology` section module | Methodology versions increase numerically: after `v5.9`, use `v5.91` or `v6.0`, not `v5.10`. |
| Pages Functions or host split | [architecture.md](./architecture.md), [worker-infrastructure.md](./worker-infrastructure.md), [operator-origin-access.md](./operator-origin-access.md), `functions/AGENTS.md` | `functions/**`, `shared/lib/site-data-routes.ts`, `shared/lib/runtime-origins.ts`, `src/lib/api.ts` | Pages Functions tests, smoke transport/UI if requested | [architecture.md](./architecture.md), [worker-infrastructure.md](./worker-infrastructure.md), [deployment-process.md](./deployment-process.md) | `site-api.pharos.watch` is internal. Browser reads should go through same-origin `/_site-data/*` unless explicitly exempt. |
| Validation, CI, or repo policy | [testing.md](./testing.md), [deployment-process.md](./deployment-process.md), [scripts.md](./scripts.md) | `scripts/**`, `.github/workflows/**`, `package.json` scripts | The changed script's own test if present, merge-gate dry run when requested | [testing.md](./testing.md), [deployment-process.md](./deployment-process.md), [scripts.md](./scripts.md) | Keep deploy-surface classification and local merge gate behavior aligned. |

## Generated Map

Use [agent-code-map.md](./agent-code-map.md) when the task is not obvious from the table above. It is generated by:

```bash
node scripts/generate-agent-code-map.mjs
```

The map is intentionally compact. Use it to choose files to inspect, not as a replacement for reading the implementation you will edit.
