---
name: pre-launch-update
description: Refresh tracked pre-launch stablecoin milestones, dates, launch phases, featured content, and promotion evidence. Use for the recurring upcoming-assets review.
user_invocable: true
---

Read `docs/editorial-style.md`; its `pre-launch` and `coin-summary` registers govern prose.

# Pre-Launch Update

`docs/process/adding-a-stablecoin.md` owns lifecycle fields, schemas, promotion requirements, edits, and validation. Read [Phase 0](../../../docs/process/adding-a-stablecoin.md#phase-0---decide-what-you-are-adding), [Phase 1](../../../docs/process/adding-a-stablecoin.md#phase-1---eligibility-check), and [Phase 7](../../../docs/process/adding-a-stablecoin.md#phase-7---validate); use `shared/types/core.ts` for live enum values. This skill adds the recurring research and approval loop.

## Triage And Research

1. Read every `shared/data/stablecoins/coins/*.json` entry with `status: "pre-launch"`, its current milestone/date/phase/content state, and `data/ai-summaries.json`. Rank by newest milestone or last file edit; entries with no milestone or no update for eight weeks receive deeper review.
2. Use web search, primary-source fetches, link-status checks, and browser inspection only where fetches are blocked or stronger inspection is needed. See `docs/process/agent-artifacts.md#harness-configuration`. Check official issuer posts/docs first, then regulator material and reputable reporting. Check DefiLlama and CoinGecko structured data for activation evidence.
3. Report sourced phase/date/milestone/content changes, dead links, conflicts, no-change coins, and promotion candidates. Do not infer a launch date or phase from promotional language.

Optional discovery of untracked candidates is research-only: search recent issuer/regulatory announcements and near-zero external listings, de-duplicate against the registry, and ask before adding anything.

## Apply Approved Changes

Approval must cover each coin and action; an earlier explicit cohort instruction covering those coins remains valid. Ask again only for an uncovered addition, promotion, or other scope change. Preserve canonical identity, flags, and historical milestones. Add milestones oldest-first with a primary `sourceUrl`; add only notable featured content.

Before every `expectedLaunchDate` change, append the old value to `dateHistory` as `{ "date": "<old>", "setOn": "<today>" }`; never reconstruct guessed history.

Refresh an AI summary only for a material change: phase advance, launch-date shift of at least a quarter, named regulator/custodian/major partner, completed reputable audit, approval/charter/license decision, or confirmed mainnet date. Use `write-ai-summaries` for the editorial contract.

Run `npm run bootstrap:generated` and `npm run check:stablecoin-data` after approved edits. Do not treat a build alone as schema validation.

## Promotion Handoff

Never execute promotion here. Recommend it only when `stablecoin-runtime-price-marketcap-gate` proves both current price and circulating/market-cap paths, identity matches by contract or issuer domain, and the listing has non-zero live supply rather than preview-only zeros. Hand the evidence to `stablecoin-addition-orchestrator`, including current methodology consequences and unresolved coverage.

Report changes/approvals, no-change coins, deferred conflicts, promotion evidence, and validation. Use ignored `agents/` scratch only for a campaign ledger with an owner/retention contract; do not create a durable shadow registry.
