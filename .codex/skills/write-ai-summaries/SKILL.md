---
name: write-ai-summaries
description: Write or refresh evidence-grounded editorial summaries for stablecoin detail pages, including draining the AI-summary candidate queue after scoring changes.
user_invocable: true
---

Read `docs/editorial-style.md`; the `coin-summary` register owns voice, title style, length, and closing structure. Follow [Adding a Stablecoin §6b](../../../docs/process/adding-a-stablecoin.md#6b-editorial-summary) for addition-time coverage.

# AI Summary Writer

Write `StablecoinAiSummary` entries in `data/ai-summaries.json`; `shared/types/editorial.ts` owns the schema. Read the base coin, all sidecars for that ID, and the field catalog in [reference.md](reference.md). For new/high-profile/refresh work, inspect the live detail page with available browser capability; see `docs/process/agent-artifacts.md#harness-configuration`.

## Editorial Contract

- Interpret the central design trade-off and what Pharos evidence reveals; do not repeat classification badges or dashboard numbers.
- Prefer durable relative wording for market cap, APY, TVL, event counts, and stress bands. A retained static adoption/funding/holder/TVL/supply/market-cap fact needs a displayed source, fact date, chain scope, and denominator.
- Never call addresses users/holders without a defined method, compare unlike financing and token-supply quantities, or invent certainty for missing evidence.
- Use current pillar/grade vocabulary only after reading `shared/lib/methodology-versions/current-version.json`. Missing reviewed evidence is NR, not safety.
- AI drafts set actual `authoredBy`, `model`, `updatedAt`, and `factsAsOf`; only a named reviewer may add `reviewedBy`/`reviewedAt` after approving the exact text.
- Live dashboard values the prose must cite (overall/pillar/peg grade, score, circulating USD) go in as registered claim tokens, never literals: put exactly one `{{grade}}`, `{{score}}`, or `{{supplyUsd}}` placeholder in `text` and register it in `claimTokens` with a `source` from `AI_SUMMARY_CLAIM_REGISTRY` (`shared/types/editorial.ts`) and a calendar-valid `factsAsOf` day (`shared/lib/__tests__/ai-summary-claims.test.ts` fails the whole data file otherwise). The detail page resolves tokens from the same live data the hero renders and prints `N/A` when the value is unavailable (including the build-time static fallback); an unregistered or malformed token also resolves to `N/A`, never raw `{{...}}` syntax. Only active coins carry tokens; pre-launch summaries render literally.

## Queue And Workflow

1. Run `npm run candidates:ai-summaries` for queue work; prioritize `high`, then `medium`.
2. For each coin, inventory current prose claims against static metadata and current live analytics. Preserve sound text/title; correct stale facts and de-brittle volatile wording rather than rewriting for variety.
3. Draft the schema-valid entry and present it for review when approval is requested. Keep one main claim per sentence and close on the durable constraint.
4. After edits, run `npm run typecheck` and `npx vitest run shared/lib/__tests__/ai-summary-claims.test.ts`; the latter validates the actual edited data file, including claim tokens and calendar dates. Run the existing term-markup tests when changing markup behavior. For queue work, rerun `npm run candidates:ai-summaries` and confirm refreshed entries leave the selected severity bands.

Report changed IDs, evidence dates/sources, review state, remaining candidates, and validation.
