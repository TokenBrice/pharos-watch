---
name: stablecoin-addition-orchestrator
description: Coordinate the full Pharos stablecoin addition process from eligibility through validation. Use when adding a new tracked stablecoin, promoting a pre-launch asset, or auditing whether an addition is complete.
user_invocable: true
---
Read `docs/editorial-style.md` before writing. Its universal rules and the named `profile-reference`, `technical-evidence`, `coin-summary`, and `pre-launch` registers govern all Pharos-owned prose; this skill adds only factual, sourcing, schema, and format requirements.

# Stablecoin Addition Orchestrator

Run the complete workflow in `docs/process/adding-a-stablecoin.md`. This skill does not replace the specialist skills; it makes sure they are used in the right order and that completion is not claimed while required artifacts or gates are missing. Before using methodology terminology, read `shared/lib/methodology-versions/current-version.json`; this skill defers to the current Safety Score methodology.

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
- **Field routing:** research domains live in sidecars under `shared/data/stablecoins/domains/` (reserves, mint-authority, compliance, risk-review). Author domain-owned fields there from the start, creating the sidecar when absent; they must not enter the base file. Route per `docs/process/stablecoin-research-sidecars.md`.
- Resolve the current specialist skill for each responsibility from the `.codex/skills/` directory listing. This sequence is responsibility-based, not an exhaustive roster; `docs/process/adding-a-stablecoin.md` is authoritative for the current steps and gates.
- Identity, collateral, peg mechanism, jurisdiction, links, IDs, proof of reserves, and basic contracts come first.
- Verify the CoinGecko ID before saving or changing it.
- Populate verified contract coverage.
- Curate `reserves[]`.
- Add only resilience overrides that differ from defaults.
- Author the `blacklistabilityReview`: required on **every** coin, including pre-launch; `check:stablecoin-data` fails without it (see the Phase 3 field rules in `docs/process/adding-a-stablecoin.md`).
- Research the compliance fields when the coin is plausibly in EU or U.S. GENIUS scope; leave them undefined for the clearly out-of-scope long tail.
- For Mint Authority, use Phase 5f in `docs/process/adding-a-stablecoin.md`; the local scanner (`tsx scripts/maintenance/audit-mint-authority.ts --coin <id>`) is a candidate producer only and must not be copied directly into metadata.
- Maintain `data/ai-summaries.json`.
- Handle pre-launch milestones, phase, featured content, and promotion checks.

3.5. **Editorial coverage gate**: before Phase 4 saves the per-coin JSON, run the required-or-waived gate from Phase 3.5 of `docs/process/adding-a-stablecoin.md`. The field table there (`oneLiner`, `mechanismArchetype`, `proofOfReserves.attestorTier`, the `mintAuthority` coverage decision, `data/ai-summaries.json`) and the CI backstop list are canonical. Read the doc rather than relying on any copy here.

Each missing field must either be filled (by re-calling the appropriate specialist skill from step 3) or recorded as an intentional gap in the Phase 5 coverage notes with a one-line reason. Do not declare success while a required field is missing without a recorded gap. The CI backstops cover the non-Mint-Authority editorial fields; the Mint Authority coverage decision itself is manual.

4. **Apply registry and generated artifacts**
- Add/update exactly one per-coin JSON file under `shared/data/stablecoins/coins/`.
- Update `shared/data/stablecoins/canonical-order.json`.
- Add the ID and derived class to `shared/data/stablecoins/listing-decisions.json`.
- Run `npm run bootstrap:generated` to regenerate `shared/data/stablecoins/coins.generated.json` and the client projections. Do not hand-edit the stable re-export boundaries; follow the current Phase 4b test tripwires and Phase 4c checked-in artifact checklist in `docs/process/adding-a-stablecoin.md`.
- Add `data/logos.json` and `data/ai-summaries.json` entries, or record explicit skipped reasons.

5. **Record downstream coverage decisions**
- For each branch, mark `added`, `not applicable`, or `intentional gap`: logo/summary, live reserves, yield, redemption backstop, mint/burn, Mint Authority, Bluechip, price/discovery, history backfill.
- **Current Safety Score methodology scoreability:** a bare new coin publishes as NR, not low-scored. Mechanism components and mint facts stay `missing` until a hand-authored mechanism review overlay exists (`docs/process/mechanism-overlay-evidence-standard.md`); nothing auto-picks a new coin up, the measurement producers iterate curated allowlists. Record the outcome as overlay authored or an intentional NR-until-overlay gap. Caution: `shared/data/safety-score-v9/mechanism-review-overlays-v1.json` is identity-bound. Authoring an overlay rotates the evaluation-build identity, so land it as a deliberate, reviewed change.
- If a new data source is added, update the about page and relevant methodology/docs.
- If the coin is active and entered Pharos via a recent launch (status transitioned from `pre-launch` within the last 90 days, or DefiLlama first observation is within 90 days), append a `launch` candidate row to `agents/annotation-candidates.md` so the chart-annotation editorial loop catches it.

6. **Validate**
- At minimum for normal additions, follow Phase 7 in `docs/process/adding-a-stablecoin.md`.
- Do not treat `npm run build` alone as sufficient.
- If the user asked for research only, stop before edits and present the missing artifact/gate checklist.

7. **After merge and deploy**: follow Phases 8-9 in `docs/process/adding-a-stablecoin.md`: run the history backfill (`POST /api/backfill-supply-history` for coins with `llamaId`; `POST /api/backfill-cg-prices` for geckoId-only coins) or record it as explicitly deferred. Without it an active coin ships with an empty market-cap chart. Then do the post-deploy verification.

## Completion Checklist

Before saying the addition is complete, report:

- canonical ID and target per-coin file
- active/pre-launch status
- price path and market-cap path, or pre-launch exemption
- generated aggregate status
- canonical-order and listing-decisions status
- generated projections materialized, with the Phase 4b test tripwires and Phase 4c checked-in artifacts handled
- `blacklistabilityReview` present with matching reviewed status
- compliance fields (`mica`/`genius`) authored or intentionally left undefined
- logo and summary status
- editorial coverage decisions per the Phase 3.5 field table (the doc is canonical): each marked filled or recorded intentional gap with reason
- Mint Authority status: reviewed `mintAuthority` profile, intentional gap with reason, or not applicable
- Current Safety Score methodology scoreability outcome: mechanism overlay authored, or intentional NR-until-overlay gap
- downstream coverage decision notes
- post-deploy backfill run or explicitly deferred
- `agents/annotation-candidates.md` updated for recent-launch coins (or marked N/A)
- validation commands run or intentionally not run
