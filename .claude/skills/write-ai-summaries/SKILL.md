---
name: write-ai-summaries
description: Use when asked to write, update, or add AI editorial summaries for stablecoin detail pages. Also use when a new stablecoin is added to the tracked list and needs a summary, or when existing summaries need refreshing.
user_invocable: true
---

## AI Summary Writer

Write sardonic, data-driven editorial summaries for stablecoin detail pages on Pharos. Summaries are stored in `data/ai-summaries.json` and rendered by `src/components/ai-summary.tsx`.

### Voice & Tone

Match the Pharos daily digest voice — sardonic, analytical, opinionated but fair:

- **Data-driven**: Ground observations in facts (market cap, backing type, governance model, notable events like depegs or regulatory actions)
- **Sardonic, not snarky**: Wit should illuminate, not just mock. "It's a sophisticated yield product wearing a stablecoin's clothing" works; cheap shots don't
- **Opinionated but balanced**: State tensions honestly. "Whether the rebrand was genius marketing or unnecessary complexity remains the market's most polite disagreement"
- **No shilling, no FUD**: Don't promote or trash — expose the interesting contradictions and trade-offs
- **Assume an informed reader**: Skip "stablecoins are digital dollars" explanations. The reader is on a stablecoin analytics dashboard

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

### Process

1. **Read context**: Load `src/lib/stablecoins.ts` to get the coin's classification (backing, governance, peg, collateral, pegMechanism). Load `data/ai-summaries.json` to see existing summaries and avoid repeating patterns
2. **Research if needed**: Use web search for recent events (depegs, regulatory actions, governance changes) that would make the summary more current and specific. Check the coin's links in `stablecoins.ts` for official sources
3. **Write the summary**: Follow voice guidelines above. Reference the coin's actual classification data — don't contradict what's in `stablecoins.ts`
4. **Update the file**: Add/update entries in `data/ai-summaries.json`. Set `updatedAt` to today's date. Preserve existing entries unless explicitly asked to remove them
5. **Verify**: Run `npm run build` to confirm the JSON is valid and the build passes

### What to Cover

When choosing what to highlight, consider these angles (pick the most interesting 2-3):

- **Market position**: Is it dominant, rising, declining, niche?
- **Structural novelty**: What makes its design different from competitors?
- **Key tension**: What's the central risk or trade-off? (e.g., centralization vs. decentralization, yield vs. safety, regulation vs. innovation)
- **Notable history**: Depegs, regulatory actions, governance drama, pivots
- **Competitive dynamics**: Who does it compete with and why might it win or lose?
- **Irony or contradiction**: The most interesting stablecoins contain contradictions worth pointing out

### Anti-Patterns

- **Don't be generic**: "A well-designed stablecoin with strong fundamentals" says nothing. Every summary should be specific enough that it couldn't describe a different coin
- **Don't repeat classification data verbatim**: The page already shows "centralized, RWA-backed, pegged to USD" — the summary should interpret, not restate
- **Don't use emoji or exclamation marks**
- **Don't hedge everything**: Take a position. "This is interesting because X" is better than "Some might argue that X could potentially be interesting"
- **Don't write marketing copy**: No "revolutionary", "game-changing", "cutting-edge"
- **Don't repeat title patterns**: If three summaries start with "The [Adjective] [Noun]", vary it