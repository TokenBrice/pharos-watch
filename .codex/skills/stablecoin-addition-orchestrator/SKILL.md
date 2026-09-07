---
name: stablecoin-addition-orchestrator
description: Coordinate a Pharos stablecoin addition or pre-launch promotion by enforcing prerequisites and routing each research domain to its specialist skill.
user_invocable: true
---

Read `docs/editorial-style.md` before writing and the current version from `shared/lib/methodology-versions/current-version.json` before using methodology terms.

# Stablecoin Addition Orchestrator

`docs/process/adding-a-stablecoin.md` is the workflow and completion contract. This skill supplies prerequisite checks, generic metadata research, and specialist routing; it does not restate the phases.

## Prerequisites

1. Route the planned files and classify the asset as active or pre-launch under [Phase 0](../../../docs/process/adding-a-stablecoin.md#phase-0---decide-what-you-are-adding).
2. Confirm listing eligibility. Before creating or promoting an active entry, run `stablecoin-runtime-price-marketcap-gate`; stop if either price or market-cap/circulating-supply admission is unavailable. Pre-launch drafts are exempt until promotion.
3. Choose the canonical `ticker-issuer` ID, base file, canonical-order position, and listing decision before edits.

## Research And Routing

- Gather generic base metadata from structured APIs and primary issuer material: identity, collateral, peg mechanism, jurisdiction, official links, `llamaId`, `geckoId`, `cmcSlug`, proof-of-reserves configuration, and lifecycle fields. Treat existing values as hypotheses; do not guess or replace stronger curated evidence.
- Use `stablecoin-identity-contracts` (`verify`, then `populate` or `discover`) for CoinGecko identity and `contracts[]`.
- Use `reserve-research` for reserve composition/review, `resilience-classify` for explicit overrides, and `compliance-research` for `genius`, `mica`, or both.
- Use `issuer-questionnaire` only for issuer-only unknowns, `write-ai-summaries` for editorial copy, and `pre-launch-update` for milestone/date maintenance.
- Route reserves, mint authority, compliance, and risk-review fields to their sidecars per `docs/process/stablecoin-research-sidecars.md`. Generic scalar metadata remains in the base file.
- Follow [Phase 5](../../../docs/process/adding-a-stablecoin.md#phase-5---evaluate-downstream-coverage-branches) for Mint Authority, blacklistability, bridge routes, yield, reserves, redemption, mint/burn, Bluechip, history, and current Safety Score coverage. Record every branch as added, not applicable, or an intentional gap.

## Apply And Finish

Edit only after the research packet and required approvals are complete. Follow [Phase 4](../../../docs/process/adding-a-stablecoin.md#phase-4---edit-the-registry) for registry/generated artifacts, [Phase 7](../../../docs/process/adding-a-stablecoin.md#phase-7---validate) for checks, and Phases 8–9 for protected release, backfill, and runtime verification.

Do not claim completion without reporting lifecycle, admitted runtime path or exemption, source/sidecar files, canonical order/listing decision, identity/contracts, editorial and downstream coverage decisions, generated artifacts, validation, and post-deploy backfill/verification status.
