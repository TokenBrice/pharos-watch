---
name: pre-launch-update
description: Use when asked to update pre-launch stablecoin data, add milestones, refresh launch phases, or check for promotions. Runs weekly to keep the upcoming stablecoins module current.
user_invocable: true
---

## Pre-Launch Module Update

Weekly full-lifecycle update of all pre-launch stablecoins tracked by Pharos. Updates milestones, launch phases, expected dates, featured content, and AI summaries.

### Scope of Updates

Valid enum values for `launchPhase`, milestone `type`, and `featuredContent.type` live in `shared/types/core.ts` as `LAUNCH_PHASE_VALUES`, `LAUNCH_MILESTONE_TYPE_VALUES`, and `FEATURED_CONTENT_TYPE_VALUES`. Read that file for the authoritative list — this document may drift.

| Field | What to update | Source priority |
|---|---|---|
| `launchPhase` | Advance when evidence supports (ordering: `announced` → `testnet` → `auditing` → `beta` → `launching-soon`, per `LAUNCH_PHASE_VALUES`) | Official announcements, docs, testnet/mainnet explorers |
| `expectedLaunchDate` | Update if shifted; format: `YYYY`, `YYYY-MM`, or `YYYY-QN` | Official comms, news articles |
| `announcedDate` | Backfill only when missing and a credible first-announcement date surfaces; never overwrite an existing value | Original press release, first official tweet |
| `launchPhaseDetail` | Refresh free-text status line | Latest official communication |
| `milestones[]` | Add new events with date, type, title, description, sourceUrl | Twitter/X, official blog, news, regulatory filings |
| `dateHistory[]` | Auto-append old date before changing `expectedLaunchDate` — **mandatory** (see Date History Protocol) | (mechanical) |
| `featuredContent[]` | Add notable new tweets, articles, blog posts, videos | Twitter/X, news, official blog |
| `contracts[]` | Add when a testnet/mainnet contract address is announced (rendered as "Target Chains" on the detail page) | Official deployment announcements, block explorers |
| `jurisdiction.regulator` | Fill when a named regulator, charter, or licensing body is confirmed (e.g., NYDFS, Anchorage Digital Bank, OCC) | Official comms, regulatory filings |
| AI summaries | Update in `data/ai-summaries.json` **only** on material changes (see "Material Change Definition" below) | Research + editorial judgment (follow `write-ai-summaries` voice) |

### Data Locations

Pre-launch coins live in `shared/data/stablecoins/pre-launch.json`.

AI summaries: `data/ai-summaries.json`

Canonical types & enums: `shared/types/core.ts`.

### Material Change Definition

Update the AI summary in `data/ai-summaries.json` only when any of these occur:

- `launchPhase` advances
- `expectedLaunchDate` shifts by ≥1 quarter (forward or backward)
- New named regulator, custodian, or major partner (bank, exchange, chain infra, payments network)
- Audit completed by a reputable firm
- Regulatory approval, charter, or license granted or denied (e.g., BitLicense, EMI, MiCA, state charter)
- Public announcement of a confirmed mainnet deployment date

Skip cosmetic updates: single promotional tweets, blog restyles, minor PR mentions, secondary partnerships. When in doubt, do not rewrite.

### Process

#### Step 0 — Staleness radar

Rank coins by staleness before researching so attention lands on the most-outdated entries.

1. For each coin, find the most recent `milestones[].date` (or the coin's last edit via `git log -1 --format="%cs" -- shared/data/stablecoins/pre-launch.json` if milestones are empty)
2. Present a sorted list (oldest first) with days-since-last-milestone
3. Do deep research (Twitter fetch, full web search, browser fallback) on the top 5 stalest coins; lighter-touch checks on the rest

Any coin with no milestones, or with a latest milestone older than 8 weeks, is an automatic deep-research candidate and also a stall-flag candidate (the issuer may have quietly delayed or abandoned the project).

#### Step 1 — Read current state

1. Read `shared/data/stablecoins/pre-launch.json` and list every pre-launch coin with its current `launchPhase`, `expectedLaunchDate`, `launchPhaseDetail`, milestone count, and `featuredContent` count
2. Read `data/ai-summaries.json` to see which pre-launch coins have summaries and when they were last updated
3. Present a summary table to the user: coin name, phase, expected date, milestones count, last summary update

#### Step 2 — Research each coin

For each pre-launch coin, run these searches **in parallel** where possible. Prioritize depth on coins flagged stalest in Step 0.

- **Twitter/X**: Check the coin's Twitter handle (from `links[]` entries labeled "Twitter"). Look for tweets about: launch dates, milestones, partnerships, regulatory approvals, testnet/mainnet activity, delays
  - Fallback order: `WebFetch https://x.com/{handle}` first. On 403, **only** escalate to `agent-browser` if the coin is in the top-5 stalest from Step 0 or if another source already indicates fresh signal. Do not burn browser sessions on all 10 coins.
  - Look for tweets from the last 7-14 days
- **Official website**: `WebFetch` the coin's website (from `links[]` entries labeled "Website") for press releases, blog posts, status updates
- **Web search**: `WebSearch` for `"{coin name}" stablecoin` to find: news articles, regulatory filings, partnership announcements
- **Link liveness**: HEAD-check (or GET-and-check-status) every entry in `links[]` plus the top 3 `featuredContent[].url` values. Flag any non-2xx responses in the findings report so dead references can be fixed or replaced in Step 4.
- **DefiLlama/CoinGecko**: Check if the coin has appeared on either platform (search by name/symbol). If found, evaluate against promotion criteria in Step 5 — do not flag based on listing existence alone
  - DefiLlama: `WebFetch` `https://stablecoins.llama.fi/stablecoins` and search response for the coin name/symbol
  - CoinGecko: `WebFetch` `https://api.coingecko.com/api/v3/search?query={symbol}` — then fetch the detail endpoint to read `market_data.market_cap.usd` and `circulating_supply`

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

#### Step 4 — Apply changes (after per-coin user approval)

Approval is **per coin**, not bulk. For each coin with proposed changes, wait for explicit user confirmation (e.g., "yes / approved / go") before editing that coin's entry.

1. Edit the coin's entry in the appropriate JSON file using the `Edit` tool
2. When updating `expectedLaunchDate`, you **must** follow the Date History Protocol (below) first — no exceptions, even for minor shifts inside the same year
3. Add new milestones to the `milestones[]` array, sorted oldest-first by date
4. Add new featured content to `featuredContent[]`
5. Update AI summaries in `data/ai-summaries.json` only for coins that meet the Material Change Definition (follow `write-ai-summaries` voice guidelines)
6. Verify:
   - `npm run check:stablecoin-data` — validates the zod schema for `pre-launch.json` (catches missing required fields, bad enum values, malformed dates). **Required.**
   - `npm run test:merge-gate` — project pre-push gate (per CLAUDE.md). **Required before the session ends or a commit is made.**
   - `npm run build` alone is not sufficient — it does not enforce the pre-launch schema.

#### Step 5 — Flag promotions (with explicit evidence)

A coin is ready-to-promote only if **all three** of the following hold. Listing existence alone is not enough — CoinGecko accepts issuer-submitted preview listings with zero supply before a token is deployed, and those produce false positives.

1. **Listed externally with real supply:**
   - DefiLlama: entry on `https://stablecoins.llama.fi/stablecoins` with non-zero `circulating`, **OR**
   - CoinGecko: entry reachable via `https://api.coingecko.com/api/v3/search?query={symbol}` whose detail endpoint returns non-zero `market_data.market_cap.usd` **and** non-zero `circulating_supply`
2. **Identity match:**
   - If `geckoId` is already set on the pre-launch entry, the discovered CoinGecko id must match.
   - If not set, cross-verify symbol **plus** issuer domain (match `links[]` Website host against the issuer link on the listing page). Symbol-only matches are unsafe (e.g., generic tickers collide).
3. **Not a preview listing:** market cap, circulating supply, and 24h volume are **all** zero → it's a preview, not a live listing. Flag for tracking, not promotion.

Report format:

- Ready: `**{Name} ready for promotion** — {source}, circulating=${X}, geckoId={id}, identity match confirmed`
- Preview only: `**{Name} has a preview listing, not ready** — CoinGecko entry exists but circulating/market-cap are zero; keep tracking`
- Ambiguous: `**{Name} possible match, unverified** — {reason}; recommend manual confirmation before next run`

Do **NOT** execute the promotion (removing `status: "pre-launch"`, adding `llamaId`, normalizing across chains, moving the entry out of `pre-launch.json`, etc.) — that's a manual, coordinated process that requires schema changes beyond the scope of this skill.

#### Step 6 — Propose new candidates (optional)

After updating existing coins, sweep for pre-launch stablecoins we don't yet track. Use all three lanes:

- **DefiLlama diff**: Fetch `https://stablecoins.llama.fi/stablecoins`. Surface entries with near-zero `circulating` or with "preview" / "upcoming" / "testnet" markers in name or description.
- **News sweep**: `WebSearch` for phrases in the last 14 days — `"announces stablecoin"`, `"launches stablecoin"`, `"unveils stablecoin"`, `"stablecoin pilot"`. Filter out issuers already tracked across all `shared/data/stablecoins/*.json` files.
- **Regulatory sweep**: `WebSearch` for `"stablecoin license"`, `"stablecoin charter"`, `"BitLicense"`, `"EMI license stablecoin"`, `"MiCA stablecoin approval"`. Jurisdictional first-movers often foreshadow tracked-worthy launches.

For each candidate, report: name, symbol, issuer, peg currency, backing type, and a 1-line "why notable" (issuer size, novel mechanism, jurisdictional significance). Let the user decide whether to add. Do **NOT** add coins without user approval.

### Date History Protocol

**Mandatory.** Every change to `expectedLaunchDate` — including minor shifts inside the same year (e.g., `2026-Q2` → `2026-Q3`) — must append a `dateHistory` entry before the new value is written. The `/upcoming` detail page renders a drift badge (`on-time` / `slipped` / `accelerated`) that depends entirely on this data; skipping the append silently breaks the UI feature.

When `expectedLaunchDate` changes:

1. Read the current `expectedLaunchDate` value
2. Append `{ "date": "{current value}", "setOn": "{today YYYY-MM-DD}" }` to the `dateHistory[]` array (create the array if it doesn't exist)
3. Then update `expectedLaunchDate` to the new value

Do **not** backfill `dateHistory` from guessed prior values. Only the first shift observed under this protocol gets recorded — if a coin has no `dateHistory` today, leave it empty until an actual live shift is observed.

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
- **type**: Must be one of the values in `LAUNCH_MILESTONE_TYPE_VALUES` (`shared/types/core.ts`). Read that file for the authoritative list — current values are `announcement`, `milestone`, `delay`, `partnership`, `regulatory`, `audit`, `testnet`, but do not trust this document as the source of truth.
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

- **type**: Must be one of the values in `FEATURED_CONTENT_TYPE_VALUES` (`shared/types/core.ts`). Current values are `tweet`, `blog`, `video`, `article` — read the type file for the authoritative list.
- For tweets: include the `source` as `@handle`
- For articles/blogs: include `description` and `image` (relative path `/featured/*.{jpg,png}`) when available
- For blog images: download notable cover images to `public/featured/` using the naming convention `{coin-id}-{short-source}.{jpg|png|webp}` (e.g., `usdpt-coindesk.jpg`). Keep files ≤200KB where possible; prefer WebP or optimized JPEG over PNG for photos.
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
