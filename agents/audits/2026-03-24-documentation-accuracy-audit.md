# Documentation Accuracy Audit — 2026-03-24

Scope:
- `README.md`
- `/docs/**`
- `/about` route contract + implementation
- `/methodology` route contract + methodology timelines

Verification run:
- `npm run check:doc-counts`
- `npm run check:doc-sync`
- `npm run check:redemption-backstops`
- `npm run check:cron-sync`
- `npm run lint`
- `npm test`
- `cd worker && npx tsc --noEmit`
- `npm run build`

All verification commands above passed on this checkout.

## Findings

### Medium — About page contract omits the live team section and lists the wrong section order

- Doc claim: the `/about/` page sections are, in order, `Why Pharos?`, `What Pharos Tracks`, `What Pharos Computes`, `Live Walkthrough`, `Classification`, `Data Pipeline`, `Methodology`, `Disclaimer`, `Get in Touch`.
- Doc refs:
  - `docs/about-page.md:27`
  - `docs/about-page.md:37`
- Code refs:
  - `src/app/about/page.tsx:411`
  - `src/app/about/page.tsx:437`
  - `src/app/about/page.tsx:540`
- Why inaccurate: the actual page inserts `Who Is Building Pharos?` between `Why Pharos?` and `What Pharos Tracks`, so the documented section inventory and order are stale.

### Medium — Migration-file counts are stale in both top-level architecture inventories

- Doc claim: the worker has `80` migration files in `README.md` and `76` migration files in `docs/architecture.md`.
- Doc refs:
  - `README.md:163`
  - `docs/architecture.md:421`
- Code/config refs:
  - `worker/migrations/0077_blacklist_amount_recovery_telemetry.sql:1`
  - repo file count: `83` SQL files under `worker/migrations/`
- Why inaccurate: the checked-in migration directory currently contains 83 SQL migrations, so both inventory counts are stale.

### Medium — The v3.3 liquidity/discovery changelog entry is wrong on both trigger cadence and budget

- Doc claim: v3.3 moved discovery sources to a dedicated `30-minute` cron with a `20-minute` crawl budget.
- Doc refs:
  - `docs/methodology-page.md:102`
  - `docs/liquidity-score-timeline.md:93`
- Code/version refs:
  - `shared/lib/liquidity-score-version.ts:133`
  - `shared/lib/liquidity-score-version.ts:140`
  - `worker/src/cron/dex-discovery/orchestrator.ts:40`
- Why inaccurate: the canonical methodology-version entry says v3.3 was an independent `20-minute` cron with `~15 min` budget, while the live code now enforces a `12-minute` run budget. The docs currently describe neither the historical version metadata nor the live implementation correctly.

### Low — Methodology route-structure doc omits an authored section module that now owns the Pricing Pipeline section

- Doc claim: authored methodology section content lives in `core-sections.tsx` and `monitoring-sections.tsx`.
- Doc ref:
  - `docs/methodology-page.md:12`
- Code refs:
  - `src/app/methodology/sections/core-sections.tsx:22`
  - `src/app/methodology/sections/core-sections-pricing.tsx:9`
- Why inaccurate: the Pricing Pipeline section now lives in its own authored module, `core-sections-pricing.tsx`, imported by `core-sections.tsx`. The route-structure doc no longer reflects the actual file split.

### Low — README understates the current `dex_prices` source set

- Doc claim: `dex_prices` stores DEX-implied prices from `Curve, Uni V3, Aerodrome, DexScreener`.
- Doc ref:
  - `README.md:205`
- Code refs:
  - `worker/src/cron/dex-liquidity/constants.ts:125`
  - `worker/src/cron/dex-liquidity/constants.ts:128`
  - `worker/src/cron/dex-liquidity/fetch-fluid.ts:173`
  - `worker/src/cron/dex-liquidity/fetch-balancer.ts:126`
  - `worker/src/cron/dex-liquidity/fetch-raydium.ts:76`
  - `worker/src/cron/dex-liquidity/fetch-orca.ts:108`
- Why inaccurate: the current DEX price pipeline also persists direct-price observations from Fluid, Balancer, Raydium, and Orca. The README table is now an incomplete description of that table’s live source coverage.
