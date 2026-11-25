---
name: supply-plan-authoring
description: Author or repair reviewed on-chain supply plans, native-stock preferences, and dated perimeter changes under ADR-8. Use when a coin needs a complete native roster or cutover. Not for price sources.
---

# Supply Plan Authoring

## Trigger And Exclusions

Use when an active asset's published supply needs a reviewed native roster, a dropout-repair roster, a native-stock preference, a circulating exclusion, or a dated perimeter change: a stalled or wrong upstream cap, a chain missing from the provider, a provider perimeter redefinition, a withheld incomplete roster, or an asset that needs clocked native counts.

Not for:

- Price sources and consensus: `docs/pricing-pipeline.md`.
- Wrong or missing `contracts[]`: fix the catalog first with [stablecoin-identity-contracts](../stablecoin-identity-contracts/SKILL.md).
- A go/no-go admission verdict: [stablecoin-runtime-price-marketcap-gate](../stablecoin-runtime-price-marketcap-gate/SKILL.md).
- Score-only deployment attribution and bridge in-flight accounting: [safety-score-curation](../safety-score-curation/SKILL.md).
- Renewing carries, re-baselines or omitted-chain exclusions: [review-registry-renewal](../review-registry-renewal/SKILL.md).
- Pre-launch, quarantined, frozen or delisted rows: only active rows enter supply producers ([lifecycle policy](../../../docs/listing-policy.md#lifecycle-policy)).

## Classify The Operation

- **Complete roster:** `aggregateContracts` for zero-list repair, supplemental supply or chain partitions.
- **Dropout repair:** `repairContracts` or a deployment's `dropoutRepair`.
- **Native preference:** `preferMcap`, complete native stock ahead of an upstream cap.
- **Circulating accounting:** `excludedBalances`, `excludedRepresentations`, `escrowResidual`, `canonicalSupplyChain`, `unreadableDeployments`.
- **Perimeter change:** an entry in `SUPPLY_PERIMETER_CHANGES`.
- **Refusal:** the evidence cannot support a roster; record why.

## Mandatory Core

- Read [ADR-8](../../../docs/architecture.md#adr-8), [Supply Data Source](../../../docs/supply-snapshot.md#supply-data-source), [Reviewed supply contract hardening](../../../docs/supply-snapshot.md#reviewed-supply-contract-hardening), and `ReviewedOnchainSupplyPlan` in `shared/lib/onchain-supply-probe.ts`. The source file wins for fields and reader families.
- Unavailable is never zero. DefiLlama list `circulating` is already USD. A plan never scales, patches or tops up a provider total: it replaces the whole packet under a reviewed rule or repairs only the missing difference, through ADR-8's fail-closed paths. No manual figure, CMC or DEX override.
- Complete census: classify every issuer-native register and every catalog deployment as additive native stock, a conserved representation reallocated from the canonical chain, an escrow residual, or an unreadable deployment that stays outside the perimeter. An observed zero needs an explicit allowance. A partial sum that matches an upstream cap proves nothing.
- Evidence: the issuer's deployment list and the bridge mechanism (burn and mint versus lock and mint) from primary sources, then a pinned read of every leg (token identity, decimals, supply, each escrow, adapter or excluded balance) under [Pinned On-Chain Evidence](../../../docs/process/agent-artifacts.md#pinned-on-chain-evidence). Decimals come from `contracts[].decimals`.
- Fail closed: an unreadable leg, an unsupported pin, a decimals mismatch or a chain with no reader family withholds the whole roster. Take the refusal branch; never author a partial roster.
- Authority: research, edit and commit on the task branch without a check-in. Stop and report instead of committing when primary sources disagree on the liability perimeter, a required leg has no pin-capable reader, the change needs new reader code or a `marketWide` perimeter entry, the edit adds a `preferMcap` preference that restates an already-published supply or adds or lifts an entry in `REVIEWED_ONCHAIN_SUPPLY_HOLDS` without the owner having approved that restatement or hold in the task, or an owning check fails.

## Branch Reads And Actions

- **Roster, preference, accounting:** edit `REVIEWED_ONCHAIN_SUPPLY_PLANS`. Record the review date, accounting class and evidence in the plan comment and the matching paragraph of [Supply Data Source](../../../docs/supply-snapshot.md#supply-data-source). A failed preferred read restores or withholds; it never falls back to the cap it replaced ([Supply Pipeline](../../../docs/supply-snapshot.md#supply-pipeline)).
- **Withheld roster:** when a plan now resolves, remove its ID from `WITHHELD_INCOMPLETE_ROSTER_IDS` in `shared/lib/__tests__/onchain-supply-probe.test.ts`; add an ID only with the refusal recorded.
- **Dropout repair:** read [Chain dropout guard](../../../docs/supply-snapshot.md#chain-dropout-guard). Repair adds only the missing chain difference and never rewrites history.
- **Perimeter change:** add the entry in `shared/lib/supply-perimeter-changes.ts` whenever the published quantity is redefined. `changedAt` is the first production publication of the new quantity, never the evidence read or the merge. Author it at or after the planned deploy, then re-date it to the first released sync once observed.
- **Refusal:** record the missing registers, readers or reconciliation in [Coverage Decisions](../../../docs/supply-snapshot.md#coverage-decisions). Leave upstream admission unchanged.
- **Methodology:** a change to what a published supply counts is a Pricing methodology change: all four targets in [ADR-3](../../../docs/architecture.md#adr-3).

## Checks Owned By The Verifier

- `npx vitest run shared/lib/__tests__/onchain-supply-probe.test.ts shared/lib/__tests__/nav-supply-rosters.test.ts`, plus the suites named under `Checks to consider` by `npm run agent:route -- --file shared/lib/onchain-supply-probe.ts --file shared/lib/supply-perimeter-changes.ts`.
- `npm run check:stablecoin-data`, `npm run typecheck`, `npm run typecheck:worker`, `npm run check:doc-sync`.
- After an authorized deploy, the first production sync: the asset's `supplySource`, observation clock and chain rows in `/api/stablecoins`. A green deploy is not that observation.

## Completion Evidence

Report per asset: operation class, deployment census with each leg's accounting class, issuer sources, pins (chain, block or slot, hash, time) and native totals, published supply before and expected after, the perimeter entry and its `changedAt` basis, refusals with reasons, methodology targets touched, checks run versus not run, and whether the first production sync was observed. Publishing goes through [pharos-release-runner](../pharos-release-runner/SKILL.md) when asked.
