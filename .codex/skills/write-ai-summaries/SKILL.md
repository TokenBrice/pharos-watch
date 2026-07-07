---
name: write-ai-summaries
description: Use when asked to write, update, or add AI editorial summaries for stablecoin detail pages. Also use when a new stablecoin is added to the tracked list and needs a summary, or when existing summaries need refreshing.
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

Each summary has three fields:

```json
{
  "ID": {
    "title": "Short Punchy Title",
    "text": "3-6 sentences of editorial narrative.",
    "updatedAt": "YYYY-MM-DD"
  }
}
```

- **title**: 2-5 word catchy label in title case (e.g., "Too Big to Depeg", "The Basis Trade, Tokenized", "Swiss Stubbornness, Tokenized"). Think newspaper column headers
- **text**: 3-6 sentences. Tell the reader what the numbers *mean*. Cover: what it is, what makes it interesting/different, what the key tension or risk is. End with a punch
- **updatedAt**: Today's date in ISO format

### Data Sources

Summaries must be grounded in Pharos's own data, not just external research. Consult these sources:

Extended reference (edge cases, history, examples): read ./reference.md when needed.

### Process

1. **Read metadata**: Find the coin's entry in `shared/data/stablecoins/coins/*.json` (or its generated runtime in `coins.generated.json`). Read all fields — classification, collateral description, pegMechanism, reserves, jurisdiction, dependencies, resilience sub-factors (custodyModel, chainTier, collateralQuality, governanceQuality, deploymentModel), notices, yield config, blacklist status, and deployment footprint. Load `data/ai-summaries.json` to see existing summaries and avoid repeating patterns
2. **Check live data** (for refreshes and high-profile coins): Open `https://pharos.watch/stablecoin/{id}` with the browser tool (claude-in-chrome or Playwright in Claude Code; `agent-browser` in Codex) to check the report card, peg score, liquidity score, redemption backstop, and DEWS band. Note anything the raw metadata doesn't capture — particularly depeg event history, safety grade trends, and exit liquidity quality
3. **Research if needed**: Use web search for recent events (depegs, regulatory actions, governance changes) that would make the summary more current and specific. Check the coin's `links` for official sources
4. **Write the summary**: Follow voice guidelines. Weave Pharos-specific insights into the narrative where they add editorial value. Don't just describe the coin generically — interpret what our data reveals about its risks, strengths, and contradictions
5. **Update the file**: Add/update entries in `data/ai-summaries.json`. Set `updatedAt` to today's date. Preserve existing entries unless explicitly asked to remove them

### What to Cover

When choosing what to highlight, consider these angles (pick the most interesting 2-3):

- **Market position**: Is it dominant, rising, declining, niche?
- **Structural novelty**: What makes its design different from competitors?
- **Key tension**: What's the central risk or trade-off? (e.g., centralization vs. decentralization, yield vs. safety, regulation vs. innovation)
- **Notable history**: Depegs, regulatory actions, governance drama, pivots
- **Competitive dynamics**: Who does it compete with and why might it win or lose?
- **Irony or contradiction**: The most interesting stablecoins contain contradictions worth pointing out
- **Safety profile**: What does the report card reveal? A strong grade with one weak dimension, a surprising F in dependency risk, or a coin that scores well despite its reputation — these are editorial gold

### Anti-Patterns

- **Don't be generic**: "A well-designed stablecoin with strong fundamentals" says nothing. Every summary should be specific enough that it couldn't describe a different coin
- **Don't repeat classification data verbatim**: The page already shows "centralized, RWA-backed, pegged to USD" — the summary should interpret, not restate
- **Don't use emoji or exclamation marks**
- **Don't hedge everything**: Take a position. "This is interesting because X" is better than "Some might argue that X could potentially be interesting"
- **Don't write marketing copy**: No "revolutionary", "game-changing", "cutting-edge"
- **Don't repeat title patterns**: If three summaries start with "The [Adjective] [Noun]", vary it
- **Don't hard-code volatile numbers**: Market caps, TVL, and APY change weekly. Frame them relatively ("one of the largest", "sub-$10M market cap", "modest circulation") unless the specific number is central to the editorial point and you've verified it today. If you do cite a number, accept it will go stale
- **Don't duplicate the dashboard**: The page already displays report card grades, peg scores, and liquidity metrics as data visualizations. The summary should *interpret* what those numbers mean in context, not restate them as raw figures. "Pharos rates it B+" is useless — "the B+ overall grade hides a D in dependency risk, which tells you everything about who's really backing this dollar" is editorial
- **Don't ignore our data**: When Pharos has scored, graded, or analyzed a stablecoin, the summary should reflect that analysis. The reader sees the scores alongside the summary — connect the dots. A summary that could appear on CoinGecko with zero modification is a wasted opportunity
- **Don't write thin summaries**: Three short, vague sentences do not meet the bar. If you can't find enough material for 3-6 substantive sentences after reading the metadata and checking the live page, the coin may need more research, not less text
