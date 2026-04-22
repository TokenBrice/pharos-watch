# Frontend Hotspot Follow-Up

Date: 2026-04-22
Owner: Codex
Source plan: `agents/plans/2026-04-22-full-audit-remediation-implementation-plan.md`

## Implemented In This Branch

- `src/components/contagion-graph.tsx`
- `src/hooks/use-contagion-graph-drag.ts`
- `src/components/contagion-graph-tooltips.tsx`
- `src/lib/stablecoin-detail-view-model.ts`
- `src/hooks/use-stablecoin-detail-view-model.ts`
- public status route shell split under `src/app/status/client.tsx`

## Remaining waived hotspots

| File | Reason it remains tracked | Next intended lane |
| --- | --- | --- |
| `src/app/stability-index/client.tsx` | broad route composition surface untouched by this branch | dedicated PSI frontend decomposition |
| `src/app/safety-scores/client.tsx` | broad route composition surface untouched by this branch | dedicated safety-score frontend decomposition |
| `src/components/stablecoin-detail/hero-card.tsx` | large presentation hotspot not required for the current stablecoin-detail boundary cleanup | stablecoin-detail presentation pass |
| `src/components/status/api-keys-panel.tsx` | operator panel still mixes row editing, validation, and mutation flow | ops UI cleanup tranche |
| `src/components/status/cron-metadata-summary.ts` | status summarization helper remains large but stable after the route-shell split | status metadata cleanup tranche |
| `src/lib/contagion-layout.ts` | graph layout engine still combines simulation and heuristics even after the graph shell split | contagion layout engine cleanup |

## Exit condition

Remove each matching waiver from `scripts/lib/hotspot-ratchet-waivers.json` only when the corresponding slice lands with focused tests and `npm run check:hotspot-ratchet` stays green.
