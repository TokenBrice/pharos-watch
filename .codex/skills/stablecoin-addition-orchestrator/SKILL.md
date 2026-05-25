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
- For Mint Authority, use Phase 5f in `docs/process/adding-a-stablecoin.md`; the local scanner (`tsx scripts/maintenance/audit-mint-authority.ts --coin <id>`) is a candidate producer only and must not be copied directly into metadata.
- Use `write-ai-summaries` for `data/ai-summaries.json`.
- Use `pre-launch-update` only for pre-launch milestones, phase, featured content, and promotion checks.

3.5. **Editorial coverage gate** — before Phase 4 saves the per-coin JSON, verify all editorial fields are filled or explicitly waived:
- `oneLiner` (required for all active/pre-launch coins; tense matches `status`; ≤160 chars).
- `mechanismArchetype` (required when the coin enters the editorial cohort — top-60 by canonical rank or market cap ≥ $50M; otherwise may be null with a recorded "intentional gap" note).
- `proofOfReserves.attestorTier` (required when `proofOfReserves.type === "independent-audit"`).
- `mintAuthority` coverage decision (required for new high-value active additions or pre-launch promotions: top-60 canonical rank, market cap ≥ $50M, or obvious issuer/operator mint control). Mark as reviewed profile or intentional gap with reason.
- `data/ai-summaries.json` entry exists (or skip reason is recorded).

Each missing field must either be filled (by re-calling the appropriate specialist skill from step 3) or recorded as an intentional gap in the Phase 5 coverage notes with a one-line reason. Do not declare success while a required field is missing without a recorded gap. CI backstops (`check:one-liner-coverage`, `check:mechanism-archetype-coverage`, `check:attestor-tier-coverage`, `check:glossary-coverage`) cover the non-Mint-Authority editorial fields; `check:stablecoin-data` validates any authored `mintAuthority` profile, but the coverage decision itself is manual.

4. **Apply registry and static edits**
- Add/update exactly one per-coin JSON file under `shared/data/stablecoins/coins/`.
- Update `shared/data/stablecoins/canonical-order.json`.
- Regenerate `shared/data/stablecoins/coins.generated.json`.
- Add `data/logos.json` and `data/ai-summaries.json` entries, or record explicit skipped reasons.

5. **Record downstream coverage decisions**
- For each branch, mark `added`, `not applicable`, or `intentional gap`: logo/summary, live reserves, yield, redemption backstop, mint/burn, Mint Authority, Bluechip, price/discovery, history backfill.
- If a new data source is added, update the about page and relevant methodology/docs.
- If the coin is active and entered Pharos via a recent launch (status transitioned from `pre-launch` within the last 90 days, or DefiLlama first observation is within 90 days), append a `launch` candidate row to `agents/annotation-candidates.md` so the chart-annotation editorial loop catches it.

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
- editorial coverage decisions: `oneLiner`, `mechanismArchetype`, `proofOfReserves.attestorTier`, `mintAuthority`, AI summary — each marked filled or recorded intentional gap with reason
- Mint Authority status: reviewed `mintAuthority` profile, intentional gap with reason, or not applicable
- downstream coverage decision notes
- `agents/annotation-candidates.md` updated for recent-launch coins (or marked N/A)
- validation commands run or intentionally not run
