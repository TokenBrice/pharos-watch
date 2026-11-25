---
name: pre-launch-update
description: Refresh tracked pre-launch stablecoins, ship primary-source 72-hour stubs, and run weekly Search Console discovery. Use for upcoming-assets reviews and daily discovery. Not for executing promotions.
---

Read `docs/editorial-style.md`; its `pre-launch` and `coin-summary` registers govern prose.

# Pre-Launch Update

`docs/process/adding-a-stablecoin.md` owns lifecycle fields, schemas, promotion requirements, edits, and validation. Read [Phase 0](../../../docs/process/adding-a-stablecoin.md#phase-0---decide-what-you-are-adding), [Phase 1](../../../docs/process/adding-a-stablecoin.md#phase-1---eligibility-check), and [Phase 7](../../../docs/process/adding-a-stablecoin.md#phase-7---validate). [Stablecoin Listing Policy](../../../docs/listing-policy.md) owns scope and listing classes; `LAUNCH_PHASE_VALUES` in `shared/types/stablecoin-lifecycle.ts` owns the phase vocabulary. The field table, date-history example, discovery lanes and image conventions are in [reference.md](reference.md).

## Trigger And Exclusions

Use for the recurring review of `status: "pre-launch"` rows and for discovery of untracked candidates. This skill never executes a promotion, never edits an active row, and never creates a page, redirect or metadata for an untracked or out-of-scope coin to capture its searches.

## Classify The Operation

| Cadence | Work | Approval |
| --- | --- | --- |
| Tracked refresh, weekly | Milestones, dates, phases, featured content, dead links, `launched` and promotion candidates | Each coin and action; an earlier explicit cohort instruction covering those coins stays valid |
| Discovery, daily | Recent issuer, regulator and bank announcements and near-zero external listings | Standing approval for a primary-source stub only; every other candidate is reported |
| Search Console discovery, weekly | Unmatched queries with real demand | Reported; an addition needs approval unless it meets the stub lane |

Ask again for any other addition, a promotion, or another scope change.

## Mandatory Core

- Screen every candidate against [Instrument Eligibility](../../../docs/listing-policy.md#instrument-eligibility) before proposing it. Investment-fund shares, NAV-priced claims, exchange earn products and account-only balances are out of scope and get no stub; a fund enters only as a `tokenized-fund` linked by an active stablecoin, which is an orchestrator addition, not a stub.
- De-duplicate before proposing: `shared/data/stablecoins/coins/*.json` including `delisted` rows, `shared/data/dead-stablecoins.json`, `excluded` rows in `shared/data/stablecoins/listing-decisions.json`, and prior owner rulings (`gh issue list --state all --search "<name or issuer>"`). A ruling on the issuer or the instrument class binds; do not re-propose it.
- Fail closed on sources. A candidate whose primary source could not be fetched this run is reported with the failed host, never stubbed or updated from secondary copy.
- Never infer a launch date or phase from promotional language.

## Branch Reads And Actions

### Tracked refresh

1. Read every pre-launch entry, its milestone, date, phase and content state, and `data/ai-summaries.json`. Run `npm run check:stablecoin-data` to surface `listingStatusReview.reviewBy` warnings. Rank by newest milestone or last file edit; entries with no milestone or no update for eight weeks receive deeper review.
2. Check official issuer posts and docs first, then regulator material and reputable reporting, then DefiLlama and CoinGecko structured data for activation evidence. Use web search, primary-source fetches and link-status checks; open a browser only where a fetch is blocked or the page needs inspection.
3. When a base-file link is dead, search that coin’s sidecars under `shared/data/stablecoins/domains/` for the same URL and repair them in the same change.
4. Report sourced phase, date, milestone and content changes, dead links, conflicts, no-change coins, `launched` candidates (publicly issued but gate-failing) and promotion candidates.

### Daily discovery and the 72-hour stub lane

A credible primary-source announcement of an in-scope stablecoin gets a pre-launch stub within 72 hours under the [72-hour pre-launch stub lane](../../../docs/process/adding-a-stablecoin.md#72-hour-pre-launch-stub-lane), which owns the minimum content and records the maintainer’s standing approval. Ship it as a stub-only pull request, at most one open at a time: confirm none is open first. A candidate known only from secondary reporting gets no stub; report it and wait. Queue the coin for full research at the next tracked refresh instead of blocking the stub on it.

A stub is a normal pre-launch addition and carries its coupled files:

- Headroom under `SAFETY_SCORE_V9_CATALOG_MAX_ASSETS` in `shared/lib/safety-score-v9-capacity-limits.ts`.
- The coin file, its `blacklistabilityReview` sidecar, `shared/data/stablecoins/canonical-order.json`, and an authored class in `shared/data/stablecoins/listing-decisions.json` (`core-stablecoin` for a fixed-par stub, `stablecoin-variant` with `variantOf`).
- A `data/ai-summaries.json` entry that states only what the announcement supports, and a logo when one exists; `npm run logos:compact` for an oversized raster ([6a](../../../docs/process/adding-a-stablecoin.md#6a-logos)).
- `npm run bootstrap:generated`, then commit the regenerated tracked artifacts with the stub.

### Weekly Search Console discovery

Pull three months of queries with `npm run fetch:gsc-search-analytics -- --out agents/<dir>` (needs `GOOGLE_APPLICATION_CREDENTIALS`, loaded from the ignored `.env.local`), or use a UI export. Take each query with 50+ impressions that matches no registry `id`, `name` or `symbol`, drop the noise classes in the reference, and research the rest under the listing policy: a qualifying asset becomes an addition candidate; an alias of a tracked coin is recorded only once a primary source ties the name to it; anything else is reported with its reason.

### Apply approved changes

- Preserve canonical identity, flags, and historical milestones. Add milestones oldest-first with a primary `sourceUrl`; add only notable featured content.
- Before changing an existing `expectedLaunchDate`, append its old value to `dateHistory` as `{ "date": "<old>", "setOn": "<today>" }`. An initial date has no prior value; never reconstruct guessed history.
- Set `launchPhase: "launched"` only on primary evidence of public on-chain issuance (explorer, issuer mainnet post) for a coin that fails the promotion gate; a pilot or closed platform stays in its earlier phase. Follow [Launched, awaiting data](../../../docs/process/adding-a-stablecoin.md#launched-awaiting-data) for the required fields. Each review, report launched rows near or past `reviewBy` with a proposed decision: promotion, a listing decision, or a renewed dated review backed by new evidence.
- A tracked row that turns out to be out of scope follows the delisting path in [Lifecycle Policy](../../../docs/listing-policy.md#lifecycle-policy); propose it, do not apply it unasked.
- Refresh an AI summary only for a material change: phase advance, launch-date shift of at least a quarter, named regulator, custodian or major partner, completed reputable audit, approval, charter or license decision, or confirmed mainnet date. [write-ai-summaries](../write-ai-summaries/SKILL.md) owns the editorial contract.

### Promotion handoff

Recommend promotion only when [stablecoin-runtime-price-marketcap-gate](../stablecoin-runtime-price-marketcap-gate/SKILL.md) proves both current price and circulating or market-cap paths, identity matches by contract or issuer domain, and the listing has non-zero live supply rather than preview-only zeros. Hand the evidence to [stablecoin-addition-orchestrator](../stablecoin-addition-orchestrator/SKILL.md) with the methodology consequences and unresolved coverage.

## Checks Owned By The Verifier

A stub or standalone approved edit has no coordinator: its author owns the [Phase 7 pass](../../../docs/process/adding-a-stablecoin.md#phase-7---validate), at minimum `npm run bootstrap:generated`, `npm run check:stablecoin-data` and `npm run check:generated-artifacts`. Inside a coordinated addition, return evidence, changed source paths, and observed versus unexercised checks in the [addition/evidence handoff packet](../../../docs/process/adding-a-stablecoin.md#additionevidence-handoff-packet) and leave generation to the coordinator. A build alone is not schema validation.

## Completion Evidence

Report changes and the approval each rests on, no-change coins, deferred conflicts, candidates rejected with the scope or ruling that excludes them, unfetched primary sources, the discovery backlog, promotion evidence, and validation as observed or unexercised. Use ignored `agents/` scratch only for a campaign ledger with an owner and retention contract; do not create a durable shadow registry.
