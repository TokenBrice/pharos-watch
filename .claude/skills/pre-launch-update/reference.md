## Pre-Launch Update — Extended Reference

Material moved verbatim from `SKILL.md`: field-level scope table, promotion rationale, the optional new-candidate sweep, the date-history example, and image conventions.

### Scope of Updates — field table

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

### Step 5 promotion — preview-listing rationale

Listing existence alone is not enough — CoinGecko accepts issuer-submitted preview listings with zero supply before a token is deployed, and those produce false positives.

#### Step 6 — Propose new candidates (optional)

After updating existing coins, sweep for pre-launch stablecoins we don't yet track. Use all three lanes:

- **DefiLlama diff**: Fetch `https://stablecoins.llama.fi/stablecoins`. Surface entries with near-zero `circulating` or with "preview" / "upcoming" / "testnet" markers in name or description.
- **News sweep**: `WebSearch` for phrases in the last 14 days — `"announces stablecoin"`, `"launches stablecoin"`, `"unveils stablecoin"`, `"stablecoin pilot"`. Filter out issuers already tracked across `shared/data/stablecoins/coins.generated.json` and `shared/data/stablecoins/canonical-order.json`.
- **Regulatory sweep**: `WebSearch` for `"stablecoin license"`, `"stablecoin charter"`, `"BitLicense"`, `"EMI license stablecoin"`, `"MiCA stablecoin approval"`. Jurisdictional first-movers often foreshadow tracked-worthy launches.

For each candidate, report: name, symbol, issuer, peg currency, backing type, and a 1-line "why notable" (issuer size, novel mechanism, jurisdictional significance). Let the user decide whether to add. Do **NOT** add coins without user approval.

### Date History Protocol — rationale and example

The `/upcoming` detail page renders a drift badge (`on-time` / `slipped` / `accelerated`) that depends entirely on this data; skipping the append silently breaks the UI feature.

Example: If `expectedLaunchDate` is `"2026-Q2"` and it shifts to `"2026-Q4"`:
```json
"dateHistory": [{ "date": "2026-Q2", "setOn": "2026-03-22" }],
"expectedLaunchDate": "2026-Q4"
```

### Featured content — blog image downloads

- For blog images: download notable cover images to `public/featured/` using the naming convention `{coin-id}-{short-source}.{jpg|png|webp}` (e.g., `usdpt-coindesk.jpg`). Keep files ≤200KB where possible; prefer WebP or optimized JPEG over PNG for photos.
