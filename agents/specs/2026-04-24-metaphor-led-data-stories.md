# Metaphor-Led Data Stories

Date: 2026-04-24

## Assumptions

- Ship this as focused product work in the existing dashboard, not as a detached research memo.
- Avoid new Worker cron jobs, D1 tables, or external providers.
- Use metaphor to frame the decision, while keeping the evidence numeric, sourced, and inspectable.
- Do not change methodology, scoring, or data-source semantics.

## Research Takeaways

- Start from the decision users need to make, then choose the chart.
- Layer story surfaces as headline, evidence, caveat, and source.
- Keep encodings familiar where trust matters; metaphor should not replace direct labels, values, or thresholds.
- Show uncertainty, coverage, freshness, and missingness prominently.
- Use absolute values and comparable denominators, especially for risk and market exposure.
- Reduce cognitive load with a strong scan order and a small number of views per story.
- Keep accessibility independent from color: labels, icons, text, and tables must carry meaning too.
- Treat risk dashboards as living systems with visible freshness and methodology/version context.

## Reference Sources

- ONS data visualisation guidance: https://service-manual.ons.gov.uk/data-visualisation/guidance
- USWDS data visualization accessibility guidance: https://designsystem.digital.gov/components/data-visualizations/
- Office for Statistics Regulation dashboard guidance: https://osr.statisticsauthority.gov.uk/guidance/regulatory-guidance-dashboards/
- Government Analysis Function dashboard guidance: https://analysisfunction.civilservice.gov.uk/policy-store/data-visualisation-dashboards/
- International Business Communication Standards: https://www.ibcs.com/IBCS/
- Basel Committee BCBS 239 risk-data principles: https://www.bis.org/publ/bcbs239.htm
- Franconeri, Padilla, Shah, Zacks, and Hullman, The Science of Visual Data Communication: https://par.nsf.gov/servlets/purl/10350294

## Opportunity Scan

1. Liquidity as exit routes: DEX TVL, volume, protocol spread, chain spread, concentration, balance, and organic liquidity already exist in `/api/dex-liquidity`.
2. Chains as harbors: chain supply, health, concentration, top stablecoin, and supply deltas already exist in `/api/chains`.
3. Safety Scores as structural inspection: report-card dimensions and market-cap weights already exist across `/api/report-cards` and `/api/stablecoins`.
4. Mint/burn as press vs shredder: already implemented strongly in the flow machine scene.
5. Stability Index as market weather: already has lighthouse, arc, event timeline, contributors, and component history.
6. Dependency Map as contagion wiring: strong fit, but less immediately understandable on mobile without deeper graph work.
7. Alt-pegs as atlas/constellation: already has a bespoke world/sky treatment.
8. Depeg as incident command: already has DEWS radar, alerts, leaderboard, feed, and heatmap.

## Selected Three

### 1. Liquidity Exit Route Map

Decision: can market participants exit through durable, diversified DEX liquidity?

Data used:

- `DexLiquidityData.__global__.totalTvlUsd`
- `totalVolume24hUsd`
- `protocolTvl`
- `chainTvl`
- `poolCount`
- `concentrationHhi`
- `weightedBalanceRatio`
- `organicFraction`

Implementation:

- Add a route-level storytelling card to `src/components/liquidity-stats.tsx`.
- Derive top protocol doors and chain lanes from the global deduped DEX row.
- Explicit caveat: DEX exit depth is not issuer redemption capacity.

### 2. Chain Harbor Map

Decision: where is stablecoin supply actually docked, and are the largest ports healthy or concentrated?

Data used:

- `ChainSummary.totalUsd`
- `dominanceShare`
- `healthScore` / `healthBand`
- `dominantStablecoin`
- `change7dPct`
- `stablecoinCount`

Implementation:

- Add `src/app/chains/harbor-map.tsx`.
- Render top chains by supply as harbor lanes with health, dominant cargo, and share.
- Keep the existing sortable table as the full evidence layer.

### 3. Safety Inspection Board

Decision: which risk dimensions are carrying the weakest load across the stablecoin universe?

Data used:

- `ReportCard.dimensions`
- `ReportCard.overallGrade`
- `StablecoinData.circulating` market-cap map

Implementation:

- Extend `src/app/safety-scores/view-model.ts` with a pure inspection-board model.
- Render dimension panels through `src/app/safety-scores/inspection-board.tsx`.
- Clicking a dimension sorts the existing card grid by that inspection axis.

## Success Criteria

- No new API endpoints, cron jobs, migrations, or external data providers.
- Tailwind classes remain static strings.
- Values are mono/tabular where numeric.
- Each metaphor has explicit caveat/source wording.
- Derivation logic is covered by focused Vitest tests.
- Targeted lint/type/test validation passes.
