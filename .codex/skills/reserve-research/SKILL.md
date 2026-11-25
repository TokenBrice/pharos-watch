---
name: reserve-research
description: Research reserve slices, provenance, custody profile and collateralQuality/custodyModel labels; edit only when approved. Use for reserve additions, renewals or custody audits. Not for mechanism overlays.
---

Read `docs/editorial-style.md`; its `technical-evidence` register governs prose.

# Reserve Research

## Trigger And Exclusions

Use for reserve composition, `reserveReview`, `custodyProfile`, reserve-linked dependencies, and the scalar `collateralQuality` / `custodyModel` labels. Research does not authorize mutations: present proposals unless edits are explicitly approved.

Not for mechanism-review overlays, `mechanismArchetype`, reserve bound facts or score replay ([safety-score-curation](../safety-score-curation/SKILL.md)); `governanceQuality`; compliance rows ([compliance-research](../compliance-research/SKILL.md)); or Dependency Map queue drains.

## Classify The Operation

- **Addition:** first reserve packet for a new or promoted coin.
- **Renewal:** re-verify an expiring or stale composition.
- **Research only:** proposals, no edits, no generation.
- **Label classification:** `collateralQuality` / `custodyModel`, standalone (Selector custody eligibility, DDR verdict audit) or alongside any of the above.

## Mandatory Core

- Read `shared/lib/methodology-versions/current-version.json`, `docs/process/stablecoin-research-sidecars.md`, `docs/report-cards.md`, the coin's base/merged entry, and its reserves sidecar. `shared/lib/stablecoins/schema.ts`, `shared/types/reserves.ts` and `shared/types/stablecoin-meta-primitives.ts` own shapes and tolerances; [Editing Rules](../../../docs/stablecoin-data.md#editing-rules) owns lockstep, observation and custody authoring rules.
- Write scope when approved: `reserves`, `reserveReview` and `custodyProfile` only in `shared/data/stablecoins/domains/reserves/<id>.json` (create when absent); `collateralQuality`, `custodyModel` and a lockstep `proofOfReserves.latestReport` in the base coin file. Preserve every other field.
- Primary evidence first: transparency dashboards, attestations, issuer/protocol docs, legal filings and fund facts. Secondary sources only fill or corroborate gaps. Never fabricate a percentage or date-bump a review.
- Read on-chain balances through pinned RPC under [Pinned On-Chain Evidence](../../../docs/process/agent-artifacts.md#pinned-on-chain-evidence), never from an explorer UI or API.
- Gated sources fail closed: never bypass a login, anti-bot or CAPTCHA gate. When no newer primary report is reachable, let the evidence lapse and report the exact portal or filing that would unblock it.
- Unknown structure stays explicit. A slice without `assetClass` or `coinId` is bounded unknown, not safe. A one-coin data update is not a methodology change.

## Branch Reads And Actions

- **Slices (addition, renewal, research):** inventory collateral, peg mechanism, backing/governance flags, proof configuration, existing slices/review and custody profile. Convert credible findings into concrete, specifically named slices totaling 100 within the source-owned tolerance. Populate `assetClass`, `issuerOrObligor`, `liquidityHorizon`, `riskFactors`, and `maturityDaysMax` only for a stated hard maximum, never a weighted average. Link tracked backing with `coinId` and a justified `depType`. Keep legacy `risk` accurate with `shared/lib/reserve-asset-risk.ts`, choosing the more conservative defensible tier for an unlisted symbol. Author `reserveReview` with sources, basis/date, reviewed scope, reviewer/date/confidence and required dispositions; add `custodyProfile` only for evidenced provider/control claims. Check the trap fields in [slice fields and renewals](references/slice-fields-and-renewals.md) before proposing JSON.
- **Renewal:** apply the lockstep, re-dating and denominator rules in [slice fields and renewals](references/slice-fields-and-renewals.md#renewal-guardrails) before changing any date.
- **Label classification:** follow [custody and collateral labels](references/custody-and-collateral-labels.md).
- **Coupled artifacts (active coin, approved edit):** when backing, dependencies or bounds change, check `shared/data/safety-score-v9/reserve-bound-facts-v1.json`, `shared/data/safety-score-v9/evidence-gap-classifications-v1.json`, the base `collateral` prose, and `docs/runbooks/artifacts/dependency-coverage-reviewed-ledger.json`. A reserve `coinId` link is also what keeps a tokenized fund listed ([Tokenized Fund Retention](../../../docs/listing-policy.md#tokenized-fund-retention)): say so before adding or removing one. Hand score verification to [safety-score-curation](../safety-score-curation/SKILL.md).
- **Coordinated addition:** return the reserve portion of the [addition/evidence handoff packet](../../../docs/process/adding-a-stablecoin.md#additionevidence-handoff-packet); generation and checks follow its [Phase 7 pass](../../../docs/process/adding-a-stablecoin.md#phase-7---validate).

## Checks Owned By The Verifier

Standalone approved edits only; research-only work generates nothing.

- `npm run bootstrap:generated`, `npm run check:stablecoin-data`, `npm run check:generated-artifacts`.
- Label edits: `npx vitest run shared/lib/__tests__/report-card-policy.test.ts`.
- Active-coin reserve edits: the replay, diff and movers gates owned by [safety-score-curation](../safety-score-curation/SKILL.md).

## Completion Evidence

Report proposed versus changed source paths, sources with retrieval/observation times, basis date, approximations, reviewed gaps and confidence, each lockstep or re-dating decision, coupled artifacts checked, issuer waits with their date or event trigger, and observed versus unexercised verification.
