# Hotspot Decomposition Backlog - 2026-04-14

Source: S-3 in `agents/audits/2026-04-14-codebase-audit-remediation-blueprint.md`.

Purpose: turn managed hotspot ratchet waivers into explicit implementation tranches without broadening the current remediation into an unnecessary rewrite.

## Triage Rules

- Keep `npm run check:hotspot-ratchet` as the enforcement gate.
- Do not increase a queued or deferred hotspot budget to land unrelated feature work.
- When touching a queued hotspot for product work, extract at least one focused helper/component if that extraction is local and low-risk.
- Treat deferred entries as acknowledged debt, not as permission to grow the file.

## Tranche 1 - Live Reserve Branch-Balance Consolidation

Scope:

- `worker/src/cron/reserve-adapters/evm-branch-balances.ts`
- `worker/src/cron/reserve-adapters/lista.ts`

Acceptance criteria:

- Shared branch-balance logic owns params reading, balance reads, price map building, fallback price behavior, zero/unreadable branch errors, slice construction, and not-applicable freshness metadata.
- Existing adapter-specific metadata remains intact.
- Relevant reserve adapter tests pass.

Status:

- In progress under `agents/plans/2026-04-14-codebase-audit-remediation-implementation-plan.md`.

## Tranche 2 - Pricing And DEX Ingestion Hotspots

Scope:

- `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`
- `worker/src/cron/dex-discovery/crawl-sources.ts`
- `worker/src/cron/dex-liquidity/challenger-persistence.ts`
- `worker/src/cron/dex-liquidity/orchestrator-metadata.ts`
- `worker/src/cron/dex-liquidity/pool-helpers.ts`

Acceptance criteria:

- Split source-family orchestration from per-source parsing/mapping.
- Keep provider throttles, circuit-breaker behavior, and partial-result semantics unchanged.
- Add characterization tests before helper extraction when provider behavior is branch-heavy.

## Tranche 3 - Alerting And Blacklist Orchestration

Scope:

- `worker/src/cron/dispatch-telegram-alerts.ts`
- `worker/src/cron/sync-blacklist.ts`

Acceptance criteria:

- Separate candidate selection, rendering, suppression, and delivery side effects in Telegram alert dispatch.
- Separate provider fetch, amount recovery, state update, and persistence steps in blacklist sync.
- Preserve existing connection-budget and subrequest-budget guards.

## Tranche 4 - Frontend Composition Surfaces

Scope:

- `src/components/contagion-graph.tsx`
- `src/components/stablecoin-table.tsx`
- `src/components/stablecoin-detail/hero-card.tsx`
- `src/components/dex-liquidity-card.tsx`
- `src/components/kpi-bar.tsx`
- `src/components/command-palette.tsx`
- `src/app/stability-index/client.tsx`
- `src/app/safety-scores/client.tsx`

Acceptance criteria:

- Extract pure model/formatting logic before moving JSX.
- Keep route clients as composition shells.
- Add or preserve focused component tests around changed behavior.

## Tranche 5 - Methodology Copy Modules

Scope:

- Large `src/app/methodology/**` section bodies and scoring changelog content modules enrolled in the ratchet.

Acceptance criteria:

- Split long table-heavy or formula-heavy blocks only when copy changes require touching them.
- Do not create abstractions that obscure static methodology content.

