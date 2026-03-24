# Documentation Verification Audit

Date: 2026-03-24
Scope: `README.md`, `/docs/**`, `/about`, `/methodology`

Verification run on the main workspace:
- `npm run check:doc-counts`
- `npm run check:doc-sync`
- `npm run check:cron-sync`
- `npm run check:redemption-backstops`
- `npm run lint`
- `npm test`
- `npm run build`
- `cd worker && npx tsc --noEmit`

## High

1. Scheduled-job counts are stale across the worker docs.
Docs: `docs/worker-infrastructure.md:3`, `docs/worker-infrastructure.md:941`, `docs/worker-and-api-limits.md:37-38`
Code: `shared/lib/cron-jobs.ts:313`, `shared/lib/cron-jobs.ts:365`, `worker/src/lib/status-evaluation.ts:186`
Why: the shared cron registry and `/api/status` now track 26 jobs, not 25. The extra job is `sync-kinesis-supply`.

2. The README redemption-backstop headline is badly out of date.
Docs: `README.md:23`
Code: `shared/lib/redemption-backstop-configs/index.ts:8`, `scripts/check-redemption-backstops.ts:67`, `scripts/check-redemption-backstops.ts:86`
Why: the live registry contains 141 configured IDs, not 66.

3. The Telegram bot doc says `/unsubscribe all` clears every alert type, but launch alerts survive it.
Docs: `docs/telegram-alerts.md:83-84`
Code: `worker/src/api/telegram-webhook.ts:362-380`, `worker/src/api/telegram-webhook-shared.ts:88-107`
Why: the unsubscribe-all update clears `dews`, `depeg`, and `safety` flags, but not `alert_launch` or `global_alert_launch`.

## Medium

4. Migration counts are stale in both the README and architecture doc.
Docs: `README.md:163`, `docs/architecture.md:421`
Code: `worker/migrations/MANIFEST.md:1-85`, `worker/migrations/0077_blacklist_amount_recovery_telemetry.sql:1`
Why: the repo currently contains 83 checked-in SQL migrations; the docs still say 80 and 76.

5. The README opening count sentence conflates tracked assets with shadow assets.
Docs: `README.md:3`
Code: `shared/lib/stablecoins/index.ts:47-75`, `shared/lib/shadow-stablecoins.ts:3-11`
Why: 169 tracked stablecoins already split into 161 active and 8 pre-launch. The 2 PSI-only shadow assets are additional, not included in the 169.

6. The About page points users to the wrong route for the peg-stress surface.
Docs/Page: `src/app/about/page.tsx:262-266`
Code: `src/app/depeg/page.tsx:15-21`, `src/app/depeg/page.tsx:55-76`, `src/app/depeg/client.tsx:245-259`
Why: the live heatmap and depeg-history surface lives on `/depeg/`, but the `Peg Tracker` card links to `/`.

7. The About page still describes PSI using an obsolete formula and cadence.
Docs/Page: `src/app/about/page.tsx:311-316`
Code: `shared/lib/cron-jobs.ts:148-163`, `worker/src/lib/stability-index.ts:19-24`, `worker/src/lib/stability-index.ts:44-66`
Why: PSI is recomputed every 30 minutes from severity, breadth, DEWS stress breadth, and 7-day trend. The page still says it is a daily score built from peg integrity, supply growth, and liquidity depth.

8. The About doc’s section contract is stale.
Docs: `docs/about-page.md:27-41`
Code: `src/app/about/page.tsx:405-540`
Why: the page now renders a dedicated `Who Is Building Pharos?` section between `Why Pharos?` and `What Pharos Tracks`, and the contributor/logo strip is no longer part of the intro section described in the doc.

9. The About doc misclassifies crvUSD as a protocol-redeem override example.
Docs: `docs/about-page.md:62`
Code: `worker/src/lib/authoritative-price-sources.ts:18-20`, `worker/src/lib/authoritative-price-sources.ts:327-349`
Why: the authoritative override path only covers Cap cUSD and infiniFi iUSD. crvUSD is sourced via the Curve price aggregator as a regular consensus source.

10. The About doc lists Origin Protocol as a current live-reserve example, but OUSD is not live-enabled.
Docs: `docs/about-page.md:63`
Code: `shared/lib/live-reserve-adapters.ts:3-31`, `shared/data/stablecoins/usd-minor.json`
Why: there is no Origin live-reserve adapter, and OUSD has curated reserve metadata rather than `liveReservesConfig`.

11. The Telegram doc omits the launch-alert surface entirely.
Docs: `docs/telegram-alerts.md:45-52`, `docs/telegram-alerts.md:76-103`
Code: `worker/src/api/telegram-webhook-shared.ts:4-35`, `worker/src/lib/telegram-alerts.ts:29`, `worker/src/cron/dispatch-telegram-alerts.ts:78-90`, `worker/src/cron/dispatch-telegram-alerts.ts:508-547`
Why: the runtime supports `launch` commands, `alert_launch` flags, `global_alert_launch`, and launch-promotion dispatch, but the doc only describes `dews`, `depeg`, and `safety`.

12. The API reference overstates `Cache-Control: no-store` behavior for non-GET endpoints.
Docs: `docs/api-reference.md:84-92`
Code: `worker/src/api/feedback.ts`, `worker/src/api/telegram-webhook.ts:53-64`, `worker/src/handlers/http/edge-cache.ts:8-12`
Why: `feedback` and `telegram-webhook` bypass edge caching because they are non-GET, but the handlers do not emit `Cache-Control: no-store`.

13. The worker-infrastructure idempotent-route list is incomplete.
Docs: `docs/worker-infrastructure.md:214-225`
Code: `worker/src/route-registry.ts:236-240`, `docs/api-reference.md:150-162`
Why: `POST /api/remediate-blacklist-amount-gaps` is also wrapped in `runIdempotentAdminAction(...)` but is omitted from the worker-infrastructure doc.

14. The operator/admin proxy failure docs omit the live 504 timeout path.
Docs: `docs/operator-origin-access.md:93-97`, `docs/status-dashboard.md:91`
Code: `functions/api/admin/[[path]].ts:153-167`
Why: upstream timeouts now return 504; only non-timeout upstream fetch failures stay 502.

15. The data-flow map still says the five-minute Telegram lane includes cemetery announcements.
Docs: `docs/data-flow-map.md:35-44`
Code: `worker/src/handlers/scheduled/five-minute-telegram.ts:1-23`, `worker/src/cron/daily-digest.ts:765-813`
Why: the five-minute slot only dispatches subscriber alerts. Cemetery and related appendices are prepared during daily digest delivery.

16. The architecture doc understates what `dispatch-telegram-alerts` does.
Docs: `docs/architecture.md:71-75`
Code: `worker/src/cron/dispatch-telegram-alerts.ts:508-658`
Why: the dispatcher also detects and fans out launch-promotion alerts for coins moving from pre-launch to active.

17. The methodology-page contract is missing the dedicated pricing-section source file and gives an incomplete edit path.
Docs: `docs/methodology-page.md:12`, `docs/methodology-page.md:49`
Code: `src/app/methodology/sections/core-sections.tsx:22-28`, `src/app/methodology/sections/core-sections-pricing.tsx:9`
Why: the first public methodology section is authored in `core-sections-pricing.tsx`, not just `core-sections.tsx` / `monitoring-sections.tsx`.

18. The methodology-page cross-app linking note overstates what is hard-coded.
Docs: `docs/methodology-page.md:22`
Code: `src/lib/methodology-context.ts:1-29`, `src/lib/methodology-context.ts:71-117`, `src/components/methodology-hint.tsx:29-53`
Why: anchor paths live in `METHODOLOGY_CONTEXT`, but changelog paths are imported shared constants and `methodology-hint.tsx` only renders resolved values.

19. The methodology and liquidity-timeline docs describe the v3.3 discovery split with the wrong cadence and budget.
Docs: `docs/methodology-page.md:102`, `docs/liquidity-score-timeline.md:93`
Code: `shared/lib/liquidity-score-version.ts:133-140`, `worker/src/cron/dex-discovery/orchestrator.ts:40`
Why: the canonical version source says v3.3 was an independent 20-minute cron with an approximately 15-minute crawl budget; the live discovery run budget is now 12 minutes.

20. The pricing/data-pipeline docs drift on fetch semantics and the CMC fallback endpoint.
Docs: `docs/data-pipeline.md:18-25`, `docs/data-pipeline.md:120`, `docs/pricing-pipeline.md:162-165`
Code: `worker/src/lib/constants.ts:124-165`, `worker/src/lib/fetch-retry.ts:23-41`, `worker/src/cron/enrich-prices-passes.ts:409-418`
Why: the circuit-breaker inventory is stale, `fetchWithRetry()` does not passthrough 404 by default, and the CMC fallback uses the stablecoins category endpoint rather than `listings/latest`.

21. The digest-pipeline doc misses the archive cache profile used by `digest-snapshot`.
Docs: `docs/digest-pipeline.md:120-129`
Code: `worker/src/api/digest-snapshot.ts:148-154`
Why: `GET /api/digest-snapshot` uses `Cache-Control: public, s-maxage=86400, max-age=3600`, not the 5-minute or 60-minute edge profiles described in the doc.

22. The stablecoin-detail route doc omits the live `CollateralUsageSection`.
Docs: `docs/stablecoin-detail-page.md:66-81`
Code: `src/app/stablecoin/[id]/client.tsx:83`, `src/app/stablecoin/[id]/client.tsx:210-212`, `src/app/stablecoin/[id]/client.tsx:291`, `src/components/stablecoin-detail/collateral-usage-section.tsx:70`
Why: the scrollspy/nav and render order now include a `collateral-usage` section before yield when dependencies exist.

23. The homepage doc has the bottom-of-page section order wrong.
Docs: `docs/homepage.md:143-152`
Code: `src/components/homepage-client.tsx:434-493`
Why: the live order is `MarketHighlights`, `Key Stablecoin Data`, `DailyDigest`, then `UpcomingStablecoinsSection`, not `DailyDigest` before `Key Stablecoin Data`.

24. The coverage-page doc no longer matches the live explainer layout.
Docs: `docs/coverage-page.md:128`
Code: `src/app/coverage/client.tsx:651`, `src/components/coverage-lens-summary.tsx:36-52`
Why: the page now renders a dedicated `CoverageLensSummary` block above the status legend instead of keeping all coverage notes in a single inline disclosure.

25. The compare-route doc omits the persisted `range` query parameter.
Docs: `docs/cemetery-and-compare.md:79-89`
Code: `src/hooks/use-compare-selection.ts:31-42`, `src/app/compare/client.tsx:337-342`
Why: the live compare route persists both `coins` and `range`.

26. The dependency-map doc says edges are built from `TRACKED_STABLECOINS`, but the code uses `ACTIVE_STABLECOINS`.
Docs: `docs/dependency-map.md:29`
Code: `src/lib/contagion-layout.ts:11`, `src/lib/contagion-layout.ts:213`
Why: pre-launch entries are excluded from the graph build.

27. The status-dashboard doc documents `/admin/` as noindex but misses the same robots policy on `/status/`.
Docs: `docs/status-dashboard.md:34-53`
Code: `src/app/status/page.tsx:4-8`
Why: the public status page also sets `robots: { index: false, follow: false }`.

28. The README source inventories are stale in multiple places.
Docs: `README.md:45-72`, `README.md:205`, `README.md:263`
Code: `worker/src/lib/cex-tickers.ts:1-4`, `worker/src/lib/cex-tickers.ts:45-85`, `worker/src/cron/sync-fx-rates.ts:19-30`, `worker/src/cron/sync-fx-rates.ts:61-63`, `worker/src/lib/chainlink-feeds.ts:39-71`, `worker/src/cron/dex-liquidity/fetch-fluid.ts:11`, `worker/src/cron/dex-liquidity/fetch-balancer.ts:4`, `worker/src/cron/dex-liquidity/fetch-raydium.ts:9`, `worker/src/cron/dex-liquidity/fetch-orca.ts:10`, `worker/src/cron/dex-liquidity/constants.ts:125-128`, `worker/src/lib/fetch-retry.ts:23-41`, `worker/src/cron/dex-liquidity/fetch-balancer.ts:55-75`, `worker/src/lib/cex-tickers.ts:92-100`
Why: the Data Sources table omits active sources such as Kraken, Bitstamp, ExchangeRate-API, Chainlink feed overlays, and direct DEX APIs; the `dex_prices` table row understates current protocol coverage; and the retry bullet incorrectly says all external API fetches use the retry helper.

## Low

29. The methodology docs still describe `core-sections.tsx` / `monitoring-sections.tsx` as the complete authored split, which is now incomplete even if most other behavior is correct.
Docs: `docs/methodology-page.md:12`
Code: `src/app/methodology/sections/core-sections-pricing.tsx:9`
Why: the pricing section lives in its own authored module.

## Non-Code-Backed Claims

Some README/About statements are not meaningfully verifiable from code alone and should be treated as editorial rather than code-backed documentation:
- project intent and monetization claims
- team-role descriptions
- public-good / mission statements
- external media/live walkthrough framing

If those should be held to the same audit bar as system docs, they need a separate non-code source of truth.
