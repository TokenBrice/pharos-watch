---
name: stablecoin-addition-orchestrator
description: Coordinate the full Pharos stablecoin addition process from eligibility through validation. Use when adding a new tracked stablecoin, promoting a pre-launch asset, or auditing whether an addition is complete.
user_invocable: true
---

# Stablecoin Addition Orchestrator

Run the complete workflow in `docs/process/adding-a-stablecoin.md`. This skill does not replace the specialist skills; it makes sure they are used in the right order and that completion is not claimed while required artifacts or gates are missing.

## Core Rule

For every active addition or pre-launch promotion, Pharos must be able to fetch both:

- a current price
- a circulating supply / market-cap value

Use `stablecoin-runtime-price-marketcap-gate` before editing active metadata. Pre-launch entries are exempt until promotion.

## Workflow

1. **Classify the request**
- Determine active vs pre-launch.
- Pick the canonical `ticker-issuer` ID and target `shared/data/stablecoins/coins/<id>.json` file.
- Do not create the registry file until eligibility and research are complete unless the user explicitly asked for a draft.

2. **Run eligibility and runtime gate**
- Apply Phase 1 eligibility from `docs/process/adding-a-stablecoin.md`.
- For active assets, run `stablecoin-runtime-price-marketcap-gate` and record the accepted path.
- Stop if no price + market-cap path exists.

3. **Build the research packet**
- Use `stablecoin-info-fetch` for identity, collateral, peg mechanism, jurisdiction, links, IDs, PoR, and basic contracts.
- Use `coingecko-id-verif` before saving or changing `geckoId`.
- Use `contract-populate` or `contract-enrich` for verified contract coverage.
- Use `reserve-research` for curated `reserves[]`.
- Use `resilience-classify` for only the resilience overrides that differ from defaults.
- Use `write-ai-summaries` for `data/ai-summaries.json`.
- Use `pre-launch-update` only for pre-launch milestones, phase, featured content, and promotion checks.

4. **Apply registry and static edits**
- Add/update exactly one per-coin JSON file under `shared/data/stablecoins/coins/`.
- Update `shared/data/stablecoins/canonical-order.json`.
- Regenerate `shared/data/stablecoins/coins.generated.json`.
- Add `data/logos.json` and `data/ai-summaries.json` entries, or record explicit skipped reasons.

5. **Record downstream coverage decisions**
- For each branch, mark `added`, `not applicable`, or `intentional gap`: logo/summary, live reserves, yield, redemption backstop, mint/burn, Bluechip, price/discovery, history backfill.
- If a new data source is added, update the about page and relevant methodology/docs.

6. **Validate**
- At minimum for normal additions, follow Phase 7 in `docs/process/adding-a-stablecoin.md`.
- Do not treat `npm run build` alone as sufficient.
- If the user asked for research only, stop before edits and present the missing artifact/gate checklist.

## Completion Checklist

Before saying the addition is complete, report:

- canonical ID and target per-coin file
- active/pre-launch status
- price path and market-cap path, or pre-launch exemption
- generated aggregate status
- canonical-order status
- logo and summary status
- downstream coverage decision notes
- validation commands run or intentionally not run

