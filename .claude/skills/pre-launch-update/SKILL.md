---
name: pre-launch-update
description: Use when asked to update pre-launch stablecoin data, add milestones, refresh launch phases, or check for promotions. Runs weekly to keep the upcoming stablecoins module current.
user_invocable: true
---

## Pre-Launch Module Update

Weekly full-lifecycle update of all pre-launch stablecoins tracked by Pharos. Updates milestones, launch phases, expected dates, featured content, and AI summaries.

### Scope of Updates

| Field | What to update | Source priority |
|---|---|---|
| `launchPhase` | Advance when evidence supports (announced → testnet → auditing → beta → launching-soon) | Official announcements, docs, testnet/mainnet explorers |
| `expectedLaunchDate` | Update if shifted; format: `YYYY`, `YYYY-MM`, or `YYYY-QN` | Official comms, news articles |
| `launchPhaseDetail` | Refresh free-text status line | Latest official communication |
| `milestones[]` | Add new events with date, type, title, description, sourceUrl | Twitter/X, official blog, news, regulatory filings |
| `dateHistory[]` | Auto-append old date before changing `expectedLaunchDate` | (mechanical — see Date History Protocol) |
| `featuredContent[]` | Add notable new tweets, articles, blog posts, videos | Twitter/X, news, official blog |
| AI summaries | Update in `data/ai-summaries.json` when material changes occur | Research + editorial judgment (follow `write-ai-summaries` voice) |

### Data Locations

Pre-launch coins live in `shared/data/stablecoins/pre-launch.json`.

AI summaries: `data/ai-summaries.json`

### Process

#### Step 1 — Read current state

1. Read `shared/data/stablecoins/pre-launch.json` and list every pre-launch coin with its current `launchPhase`, `expectedLaunchDate`, `launchPhaseDetail`, milestone count, and `featuredContent` count
2. Read `data/ai-summaries.json` to see which pre-launch coins have summaries and when they were last updated
3. Present a summary table to the user: coin name, phase, expected date, milestones count, last summary update

#### Step 2 — Research each coin

For each pre-launch coin, run these searches **in parallel** where possible:

- **Twitter/X**: Check the coin's Twitter handle (from `links[]` entries labeled "Twitter"). Look for tweets about: launch dates, milestones, partnerships, regulatory approvals, testnet/mainnet activity, delays
  - Use `WebFetch` on `https://x.com/{handle}` or `agent-browser` if 403'd
  - Look for tweets from the last 7-14 days
- **Official website**: `WebFetch` the coin's website (from `links[]` entries labeled "Website") for press releases, blog posts, status updates
- **Web search**: `WebSearch` for `"{coin name}" stablecoin` to find: news articles, regulatory filings, partnership announcements
- **DefiLlama/CoinGecko**: Check if the coin has appeared on either platform (search by name/symbol). If found, it may be ready for promotion
  - DefiLlama: `WebFetch` `https://stablecoins.llama.fi/stablecoins` and search response for the coin name/symbol
  - CoinGecko: `WebFetch` `https://api.coingecko.com/api/v3/search?query={symbol}`

#### Step 3 — Present findings

For each coin with updates, present:

```
## {Name} ({Symbol}) — {current phase}

### Changes found
- **launchPhase**: {old} → {new} (source: {URL})
- **expectedLaunchDate**: {old} → {new} (source: {URL})
- **New milestones**:
  - {date} | {type} | {title} (source: {URL})
- **New featuredContent**:
  - {type} | {title} | {URL}

### Promotion candidate?
{Yes/No — explain why}

### No changes
{List coins where nothing new was found}
```

**Important**: Flag any conflicts between sources. If unsure about a value, say so explicitly.

#### Step 4 — Apply changes (after user approval)

1. Edit the coin's entry in the appropriate JSON file using the `Edit` tool
2. When updating `expectedLaunchDate`, ALWAYS follow the Date History Protocol (below) first
3. Add new milestones to the `milestones[]` array, sorted oldest-first by date
4. Add new featured content to `featuredContent[]`
5. Update AI summaries in `data/ai-summaries.json` for coins with material changes (follow `write-ai-summaries` voice guidelines)
6. Run `npm run build` to verify clean compilation

#### Step 5 — Flag promotions

If a coin appears on DefiLlama or CoinGecko with live supply data, flag it for promotion:
- Report: "**{Name} appears ready for promotion** — found on {source} with {details}"
- Do **NOT** execute the promotion (removing `status: "pre-launch"`, adding `llamaId`, etc.) — this is a manual process requiring additional configuration

#### Step 6 — Propose new candidates (optional)

If during research you discover new pre-launch stablecoins that aren't tracked, briefly mention them:
- Name, symbol, issuer, peg type, backing type
- Why they're notable (major issuer, novel mechanism, regulatory significance)
- Let the user decide whether to add them

### Date History Protocol

When `expectedLaunchDate` changes:

1. Read the current `expectedLaunchDate` value
2. Append `{ "date": "{current value}", "setOn": "{today YYYY-MM-DD}" }` to the `dateHistory[]` array (create the array if it doesn't exist)
3. Then update `expectedLaunchDate` to the new value

Example: If `expectedLaunchDate` is `"2026-Q2"` and it shifts to `"2026-Q4"`:
```json
"dateHistory": [{ "date": "2026-Q2", "setOn": "2026-03-22" }],
"expectedLaunchDate": "2026-Q4"
```

### Milestone Guidelines

Each milestone entry:
```json
{
  "date": "2026-03-22",
  "type": "milestone",
  "title": "Private testnet goes live",
  "description": "Optional longer description",
  "sourceUrl": "https://example.com/announcement"
}
```

- **date**: Always `YYYY-MM-DD` format
- **type**: One of: `announcement`, `milestone`, `delay`, `partnership`, `regulatory`, `audit`, `testnet`
- **title**: Short factual description (not marketing language)
- **sourceUrl**: Always include when available — milestones without sources are less trustworthy
- **description**: Optional, only when the title alone is insufficient

### Featured Content Guidelines

```json
{
  "type": "tweet",
  "url": "https://x.com/handle/status/123456",
  "title": "Short description of the tweet",
  "source": "@handle"
}
```

- **type**: One of: `tweet`, `blog`, `video`, `article`
- For tweets: include the `source` as `@handle`
- For articles/blogs: include `description` and `image` (relative path `/featured/*.{jpg,png}`) when available
- For blog images: download notable cover images to `public/featured/` if they add visual value
- Don't add routine promotional tweets — only significant announcements, milestones, or technical updates

### Quality Standards

- Phase advances require evidence (a tweet saying "coming soon" is not enough for `launching-soon`)
- Do not speculate on launch dates — only update when officially communicated
- Milestones should be factual events, not predictions
- AI summary updates follow the `write-ai-summaries` voice: sardonic, data-driven, opinionated but fair

### What NOT to Do

- Do **NOT** execute promotions from pre-launch to active
- Do **NOT** remove existing milestones (they're historical records)
- Do **NOT** backdate milestone entries — use the date the event actually occurred
- Do **NOT** change `flags` (backing, pegCurrency, governance) — these are set intentionally
- Do **NOT** change `id`, `name`, `symbol` — canonical identifiers
- Do **NOT** add coins to the pre-launch tracker without user approval
