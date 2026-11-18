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
3. Report sourced phase/date/milestone/content changes, dead links, conflicts, no-change coins, `launched` candidates (publicly issued but gate-failing), and promotion candidates. Do not infer a launch date or phase from promotional language.

Discovery of untracked candidates runs daily: search recent issuer, regulator and bank announcements and near-zero external listings, and de-duplicate against the registry. A candidate with a primary-source announcement goes to the stub lane below; any other candidate is reported, not added.

Weekly, include GSC unmatched-query discovery: pull three months of Search Console queries (`npm run fetch:gsc-search-analytics`, or a UI export) and take each query with 50+ impressions that matches no registry `id`, `name` or `symbol`. Research each under [Stablecoin Listing Policy](../../../docs/listing-policy.md): a qualifying pre-launch or active asset becomes an addition candidate; an alias of a tracked coin is recorded only once a primary source ties the name to it; anything else is reported with its reason. Never create a page, redirect or metadata for an untracked or out-of-scope coin to capture its searches.

## 72-Hour Stub Lane

For a credible primary-source announcement of an in-scope stablecoin, propose a pre-launch stub within 72 hours under the [72-hour pre-launch stub lane](../../../docs/process/adding-a-stablecoin.md#72-hour-pre-launch-stub-lane): identity, flags, a `oneLiner`, one dated milestone sourced to the announcement, and a `blacklistabilityReview` with `sourceFreeRationale` when no control evidence exists yet. A stub that meets that lane's minimum content from a primary source is covered by the maintainer's standing approval (2026-11-14, recorded in that section): ship it as a stub-only pull request, at most one open at a time. A candidate known only from secondary reporting gets no stub; report it and wait for the maintainer. Queue the coin for full research at the next review instead of blocking the stub on it.

## Apply Approved Changes

Approval must cover each coin and action; an earlier explicit cohort instruction covering those coins remains valid, and the standing stub approval covers primary-source stubs only. Ask again for any other addition, a promotion, or another scope change. Preserve canonical identity, flags, and historical milestones. Add milestones oldest-first with a primary `sourceUrl`; add only notable featured content.

When changing an existing `expectedLaunchDate`, first append its old value to `dateHistory` as `{ "date": "<old>", "setOn": "<today>" }`. An initial date has no prior value to append; never reconstruct guessed history.

Set `launchPhase: "launched"` only on primary evidence of public on-chain issuance (explorer, issuer mainnet post) for a coin that fails the promotion gate; a pilot or closed platform stays in its earlier phase. Follow [Launched, awaiting data](../../../docs/process/adding-a-stablecoin.md#launched-awaiting-data): add `launchDate`, a sourced launch milestone, and a `listingStatusReview` naming the missing lane with `reviewBy` at most 60 days out. Each review, report launched rows near or past `reviewBy` with a proposed decision: promotion, listing decision, or a renewed dated review backed by new evidence.

Refresh an AI summary only for a material change: phase advance, launch-date shift of at least a quarter, named regulator/custodian/major partner, completed reputable audit, approval/charter/license decision, or confirmed mainnet date. Use `write-ai-summaries` for the editorial contract.

For standalone approved edits and coordinated additions, keep the research and promotion-evidence duties here, return evidence, changed source paths, and observed versus unexercised checks in the [addition/evidence handoff packet](../../../docs/process/adding-a-stablecoin.md#additionevidence-handoff-packet), and follow its [Phase 7 generation/check pass](../../../docs/process/adding-a-stablecoin.md#phase-7---validate). Do not treat a build alone as schema validation.

## Promotion Handoff

Never execute promotion here. Recommend it only when `stablecoin-runtime-price-marketcap-gate` proves both current price and circulating/market-cap paths, identity matches by contract or issuer domain, and the listing has non-zero live supply rather than preview-only zeros. Hand the evidence to `stablecoin-addition-orchestrator`, including current methodology consequences and unresolved coverage.

Report changes/approvals, no-change coins, deferred conflicts, promotion evidence, and validation. File anything still pending, including a discovery backlog, as a [follow-up issue](../../../docs/process/agent-artifacts.md#follow-up-issues) and report its number. Use ignored `agents/` scratch only for a campaign ledger with an owner/retention contract; do not create a durable shadow registry.
