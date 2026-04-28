# PharosVille Research Pack

Created: 2026-04-28

Goal: plan a ClaudeVille-like Pharos special page: an old-school fantasy RPG island city where the sea is the main character, with roughly 86% water, where Pharos data becomes a readable spatial world.

## Documents

- `01-feasibility.md` — feasibility verdict, assumptions, constraints, and non-goals.
- `02-world-model-and-data-mapping.md` — semantic visual grammar and concrete Pharos data mappings.
- `03-technical-architecture.md` — proposed route, renderer, data adapter, state, accessibility, and performance architecture.
- `04-asset-pipeline.md` — Pixellab and static sprite workflow.
- `05-rollout-plan.md` — phased implementation plan with deliverables and validation.
- `06-risks-and-validation.md` — main challenges, mitigations, testing plan, and acceptance criteria.
- `07-review.md` — independent review notes and revisions.
- `08-implementation-plan.md` — precise replacement plan for shipping PharosVille at `/pharosville/`.
- `09-xhigh-review-synthesis.md` — five-agent xhigh review synthesis and plan corrections.
- `10-v1-refinement-plan.md` — refinement plan for the current barebones v1 route, informed by a six-agent follow-up exploration.
- `11-pixellab-phase-2-lighthouse-plan.md` — Pixellab MCP Phase 2 plan and Alexandria-style lighthouse proof workflow.
- `12-chain-harbor-docks-plan.md` — top-six chain harbor dock sprite replacement plan.
- `13-ship-liveliness-motion-plan.md` — deterministic ship movement, chain-presence docking cadence, and peg-risk water-zone implementation plan.
- `14-ship-liveliness-handover.md` — handover notes for ship motion implementation, runtime debug fields, and Phase 5 validation follow-up.

## Primary Inputs Inspected

Pharos:

- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/testing.md`
- `docs/worker-and-api-limits.md`
- `docs/design-context.md`
- `docs/design-language.md`
- `docs/design-tokens.md`
- `src/hooks/api-hooks.ts`
- `src/hooks/use-stablecoins.ts`
- `src/hooks/use-chains.ts`
- `shared/types/chains.ts`
- `shared/types/market.ts`
- `shared/types/stability.ts`
- `shared/types/report-cards.ts`
- `shared/types/mint-burn.ts`
- `shared/types/core.ts`
- `shared/lib/dead-stablecoins.ts`
- `shared/data/dead-stablecoins.json`

ClaudeVille:

- `/home/ahirice/Documents/git/claude-ville/docs/visual-experience-crafting.md`
- `/home/ahirice/Documents/git/claude-ville/claudeville/src/presentation/character-mode/README.md`
- `/home/ahirice/Documents/git/claude-ville/scripts/sprites/generate.md`
- `/home/ahirice/Documents/git/claude-ville/docs/pixellab-reference.md`
- `/home/ahirice/Documents/git/claude-ville/claudeville/src/presentation/character-mode/IsometricRenderer.js`
- `/home/ahirice/Documents/git/claude-ville/claudeville/src/presentation/character-mode/Camera.js`
- `/home/ahirice/Documents/git/claude-ville/claudeville/src/presentation/character-mode/AssetManager.js`
- `/home/ahirice/Documents/git/claude-ville/claudeville/src/presentation/character-mode/SceneryEngine.js`
- `/home/ahirice/Documents/git/claude-ville/claudeville/src/presentation/character-mode/HarborTraffic.js`
- `/home/ahirice/Documents/git/claude-ville/claudeville/assets/sprites/manifest.yaml`
- `/home/ahirice/Documents/git/claude-ville/docs/superpowers/specs/2026-04-25-pixel-art-baseline/overview-fresh.png`

## Summary Verdict

Feasible, but it should be treated as a product surface, not a decorative map. The current implementation target is a full visual replacement of `/pharosville/` using a new world model and renderer under `src/app/pharosville/`, inspired by ClaudeVille's Canvas 2D architecture and sprite workflow. Screens below `1280px` are a desktop-only fallback for v0.1, not a mobile/tablet canvas. Existing Pharos endpoints are sufficient without Worker changes. Pixellab is suitable for the asset pipeline after the renderer and data contract are stable.

Independent xhigh review originally returned "conditional go" and identified data-contract, accessibility, and performance gaps. Those fixes have been folded into this pack; see `07-review.md` for the review trail and final readiness notes.
