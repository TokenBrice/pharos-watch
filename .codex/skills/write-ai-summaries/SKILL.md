---
name: write-ai-summaries
description: Write or refresh Pharos-sourced stablecoin detail summaries and drain the AI-summary candidate queue. Use for additions or post-scoring refreshes. Not for frozen coins, changelogs, or annotations.
---

Read `docs/editorial-style.md`; the `coin-summary` register owns voice, title style, length, and closing structure. Follow [Adding a Stablecoin §6b](../../../docs/process/adding-a-stablecoin.md#6b-editorial-summary) for addition-time coverage.

# AI Summary Writer

Write `StablecoinAiSummary` entries in `data/ai-summaries.json`; `shared/types/editorial.ts` owns the schema. Read the base coin, all sidecars for that ID, and the field catalog in [reference.md](reference.md). For new/high-profile/refresh work, inspect the live detail page with browser inspection when the session has it; otherwise report that the live page was not inspected.

Never write or regenerate the summary of a frozen coin ([Leave the AI summary alone](../../../docs/freezing-stablecoins.md#5b-leave-the-ai-summary-alone)). Refresh a pre-launch summary only on a material change. Not for changelog entries or chart annotations.

## Editorial Contract

- Interpret the central design trade-off and what Pharos evidence reveals; do not repeat classification badges or dashboard numbers.
- Pharos is the summary's only source: summaries carry no `sources` field. Every claim must be backed by the base coin, a sidecar, or live analytics shown on the page, each of which carries its own provenance. Evidence that exists only outside Pharos goes into the owning sidecar first (with its dated sources) or the claim is dropped; a summary is never the sole home of a fact.
- Prefer durable relative wording for market cap, APY, TVL, event counts, and stress bands. A retained static adoption/funding/holder/TVL/supply/market-cap fact needs a backing Pharos module, fact date, chain scope, and denominator.
- Never call addresses users/holders without a defined method, compare unlike financing and token-supply quantities, or invent certainty for missing evidence.
- Read `shared/lib/methodology-versions/current-version.json` for the current methodology and `ReportCardGradeSchema` in `shared/types/report-card-grade.ts` for grade vocabulary; `V9_QUALITY_PILLARS` in `shared/types/safety-score-v9-quality-pillars.ts` owns pillar keys. Missing reviewed evidence is NR, not safety. A coin whose class in `shared/data/stablecoins/listing-decisions.json` is `tokenized-fund` publishes NR by design and sits outside stablecoin totals ([listing classes](../../../docs/listing-policy.md#listing-classes)): describe it as a tracked fund, with no grade or score claim and no share-of-stablecoin-supply framing.
- AI drafts set actual `authoredBy`, `model`, `updatedAt`, and `factsAsOf`; only a named reviewer may add `reviewedBy`/`reviewedAt` after approving the exact text.
- Live dashboard values the prose must cite (overall/pillar/peg grade, score, circulating USD) go in as registered claim tokens, never literals; each token occurs exactly once in `text` with a matching `claimTokens` entry. Only active coins carry tokens. [Claim tokens](reference.md#claim-tokens) owns the field rules and failure behavior.
- Glossary links use `{{term:<slug>}}…{{/term}}` markup with an existing glossary slug.

## Queue And Workflow

The permanent QA producer reads four live endpoint families (report cards, stress signals, peg summary, stablecoins). Its detectors are heuristic and skip summaries without a current card; absence from the queue does not verify the prose. Findings never approve exact text or manufacture reviewer provenance.

1. Run `npm run candidates:ai-summaries` for queue work; prioritize `high`, then `medium`. It needs `PHAROS_API_KEY` (ignored root `.env.local`) or `--fixtures <dir>`, and writes `agents/ai-summary-candidates.md` and `agents/ai-summary-candidates.json`. `.github/workflows/agent-maintenance-candidates.yml` retains the same queue weekly.
2. For each coin, inventory current prose claims against static metadata and current live analytics. Preserve sound text/title; correct stale facts and de-brittle volatile wording rather than rewriting for variety.
3. Draft the schema-valid entry and present it for review when approval is requested. Keep one main claim per sentence and close on the durable constraint.
4. After edits, run `npm run typecheck` and `npx vitest run shared/lib/__tests__/ai-summary-claims.test.ts`; the latter validates the actual edited data file, including claim tokens and calendar dates. Also run `npx vitest run src/lib/__tests__/term-markup.test.ts` and `npm run check:stablecoin-data`. For queue work, rerun `npm run candidates:ai-summaries` and confirm refreshed entries leave the selected severity bands.

Report changed IDs, backing Pharos evidence and dates, review state, remaining candidates, and validation.
