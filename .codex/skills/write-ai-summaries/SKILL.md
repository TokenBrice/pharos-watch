---
name: write-ai-summaries
description: Write, update, or refresh AI editorial summaries for stablecoin detail pages, including draining the queue from `npm run candidates:ai-summaries` after scoring changes or on a monthly cadence.
user_invocable: true
---

## AI Summary Writer

Write sardonic, data-driven editorial summaries for stablecoin detail pages on Pharos. Summaries are stored in `data/ai-summaries.json` and rendered by `src/components/ai-summary.tsx`.

The summary sits in the Overview section of the detail page alongside the reserve treemap, redemption backstop card, DEWS stress panel, and price transparency card. Above it, the hero card shows live price, market cap, peg score, liquidity score, and depeg event count. Below, the report card, charts, and depeg history provide granular data. The reader sees all of this — the summary's job is to interpret the data, not restate it.

### Voice & Tone

Match the Pharos daily digest voice — sardonic, analytical, opinionated but fair:

- **Data-driven**: Ground observations in the coin's actual metadata, reserve composition, safety grades, and scoring — not just generic characterizations
- **Sardonic, not snarky**: Wit should illuminate, not just mock. "It's a sophisticated yield product wearing a stablecoin's clothing" works; cheap shots don't
- **Opinionated but balanced**: State tensions honestly. "Whether the rebrand was genius marketing or unnecessary complexity remains the market's most polite disagreement"
- **No shilling, no FUD**: Don't promote or trash — expose the interesting contradictions and trade-offs
- **Assume an informed reader**: Skip "stablecoins are digital dollars" explanations. The reader is on a stablecoin analytics dashboard
- **Typographic dashes**: Use a real em dash (—), never a double hyphen (`--`) — the text renders in a serif editorial paragraph where `--` reads as a typo

### Structure per Summary

Each summary is a `StablecoinAiSummary` — `shared/types/editorial.ts` is the authoritative shape. AI-authored entries carry provenance alongside the editorial core:

```json
{
  "ID": {
    "title": "Short Punchy Title",
    "text": "3-6 sentences of editorial narrative.",
    "updatedAt": "YYYY-MM-DD",
    "authoredBy": "ai",
    "model": "<authoring model id>",
    "factsAsOf": "YYYY-MM-DD"
  }
}
```

`reviewedBy`/`reviewedAt` exist too but are set only after the named reviewer approves — never pre-stamp them.
Optional `sources` entries are labeled HTTP links rendered directly beneath the summary. Add them whenever a static adoption, funding, holder/address, TVL, supply, or market-cap fact is retained.

- **title**: 2-5 word catchy label in title case (e.g., "Too Big to Depeg", "The Basis Trade, Tokenized", "Swiss Stubbornness, Tokenized"). Think newspaper column headers
- **text**: 3-6 sentences. Tell the reader what the numbers _mean_. Cover: what it is, what makes it interesting/different, what the key tension or risk is. End with a punch
- **updatedAt**: Today's date in ISO format

### Data Sources

Summaries must be grounded in Pharos's own data, not just external research. The field-by-field catalog of what to read — static metadata and live analytical data — lives in ./reference.md; read it when authoring.

### Process

1. **Read metadata**: Find the coin's entry in `shared/data/stablecoins/coins/*.json` (or its generated runtime in `coins.generated.json`). Read all fields — classification, collateral description, pegMechanism, reserves, jurisdiction, dependencies, resilience sub-factors (custodyModel, collateralQuality, governanceQuality), notices, yield config, blacklist status, and deployment footprint. Load `data/ai-summaries.json` to see existing summaries and avoid repeating patterns
2. **Check live data** (for refreshes and high-profile coins): Open `https://pharos.watch/stablecoin/{id}` with the browser tool (claude-in-chrome or Playwright in Claude Code; `agent-browser` in Codex) to check the report card, peg score, liquidity score, redemption backstop, and DEWS band. Note anything the raw metadata doesn't capture — particularly depeg event history, safety grade trends, and exit liquidity quality
3. **Research if needed**: Use web search for recent events (depegs, regulatory actions, governance changes) that would make the summary more current and specific. Check the coin's `links` for official sources
4. **Write the summary**: Follow voice guidelines. Weave Pharos-specific insights into the narrative where they add editorial value. Don't just describe the coin generically — interpret what our data reveals about its risks, strengths, and contradictions
5. **Update the file**: Add/update entries in `data/ai-summaries.json`. Set `updatedAt` to today's date. Preserve existing entries unless explicitly asked to remove them

### Queue-Driven Refresh

Use the staleness producer after a methodology change, a cluster of depeg events, or on a monthly cadence:

```bash
PHAROS_API_KEY=... npm run candidates:ai-summaries
```

It writes `agents/ai-summary-candidates.{md,json}` and never edits summaries. Process `high` findings first, then `medium`; leave `low` findings for a deliberate full sweep. For each candidate:

1. Read its `findings[]`, the current summary, and `shared/data/stablecoins/coins/<id>.json`.
2. Correct each stale claim using the candidate's `current` value, then de-brittle the prose so the same volatile number does not immediately go stale again.
3. Preserve still-correct claims and the existing title unless the title itself is stale. Do not rewrite sound prose for variety.
4. Re-run the producer and confirm refreshed entries no longer appear as `high` or `medium`.

DEWS bands and exact event counts are especially volatile; describe tendencies unless the current value is the editorial point. Overall letter grades may be cited, but exact numeric scores should be exceptional. Grade vocabulary is Safety Score V9: the producer reconciles the overall grade and the three pillar grades (backing, exit, economic control) — retired V8 dimension names (peg stability, liquidity, resilience, decentralization, dependency risk) are flagged as stale on the next producer run, so never write new prose in those terms.

For AI-drafted entries set `authoredBy`, `model`, `updatedAt`, and `factsAsOf` to the actual authoring context. Set `reviewedBy` and `reviewedAt` only after the named reviewer has approved the batch; never pre-stamp owner review.

### What to Cover

When choosing what to highlight, consider these angles (pick the most interesting 2-3):

- **Market position**: Is it dominant, rising, declining, niche?
- **Structural novelty**: What makes its design different from competitors?
- **Key tension**: What's the central risk or trade-off? (e.g., centralization vs. decentralization, yield vs. safety, regulation vs. innovation)
- **Notable history**: Depegs, regulatory actions, governance drama, pivots
- **Competitive dynamics**: Who does it compete with and why might it win or lose?
- **Irony or contradiction**: The most interesting stablecoins contain contradictions worth pointing out
- **Safety profile**: What does the report card reveal? A strong grade with one weak pillar, a coin held under a binding cap ("why not higher"), an NR on missing evidence, or a coin that scores well despite its reputation — these are editorial gold

### Anti-Patterns

- **Don't be generic**: "A well-designed stablecoin with strong fundamentals" says nothing. Every summary should be specific enough that it couldn't describe a different coin
- **Don't repeat classification data verbatim**: The page already shows "centralized, RWA-backed, pegged to USD" — the summary should interpret, not restate
- **Don't use emoji or exclamation marks**
- **Don't hedge everything**: Take a position. "This is interesting because X" is better than "Some might argue that X could potentially be interesting"
- **Don't write marketing copy**: No "revolutionary", "game-changing", "cutting-edge"
- **Don't repeat title patterns**: If three summaries start with "The [Adjective] [Noun]", vary it
- **Don't hard-code volatile numbers**: Market caps, TVL, and APY change weekly. Frame them relatively ("one of the largest", "sub-$10M market cap", "modest circulation") unless the specific number is central to the editorial point and you've verified it today. If you do cite a number, accept it will go stale
- **Scope adoption claims**: Any static adoption, funding, address/holder, TVL, supply, or market-cap figure requires a displayed source and fact date. State the chain scope and denominator. Never call an address count "users" or "holders" without a defined method that distinguishes contracts and EOAs and deduplicates cross-chain controllers.
- **Keep quantities economically comparable**: Do not divide parent or project financing by one product's token supply, market cap, or circulation unless both quantities measure the same economic concept. Token supply is not capital "used."
- **Do not inherit provenance**: `factsAsOf` is the date the body was actually researched. Formatting, disclosure, or model-field edits do not justify carrying forward or adding `reviewedBy`/`reviewedAt`; those fields require approval of the exact text by the named reviewer.
- **Don't duplicate the dashboard**: The page already displays report card grades, peg scores, and liquidity metrics as data visualizations. The summary should _interpret_ what those numbers mean in context, not restate them as raw figures. "Pharos rates it B+" is useless — "the B+ overall grade hides a D in dependency risk, which tells you everything about who's really backing this dollar" is editorial
- **Don't ignore our data**: When Pharos has scored, graded, or analyzed a stablecoin, the summary should reflect that analysis. The reader sees the scores alongside the summary — connect the dots. A summary that could appear on CoinGecko with zero modification is a wasted opportunity
- **Don't write thin summaries**: Three short, vague sentences do not meet the bar. If you can't find enough material for 3-6 substantive sentences after reading the metadata and checking the live page, the coin may need more research, not less text

### Verify

Run `npm run typecheck` after editing `data/ai-summaries.json`. Queue-driven work also re-runs `npm run candidates:ai-summaries` as described above.
