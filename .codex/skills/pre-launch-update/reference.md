## Pre-Launch Update — Extended Reference

Material moved verbatim from `SKILL.md`: field-level scope table, promotion rationale, the optional new-candidate sweep, the date-history example, and image conventions.

### Scope of Updates — field table

| Field | What to update | Source priority |
|---|---|---|
| `launchPhase` | Advance only on evidence; `LAUNCH_PHASE_VALUES` in `shared/types/core.ts` owns the vocabulary (the source file wins) | Official announcements, docs, testnet/mainnet explorers |
| `expectedLaunchDate` | Update if shifted; `FuzzyDateSchema` in `shared/types/stablecoin-meta-schemas.ts` owns the supported date formats | Official comms, news articles |
| `announcedDate` | Backfill only when missing and a credible first-announcement date surfaces; never overwrite an existing value | Original press release, first official tweet |
| `launchPhaseDetail` | Refresh free-text status line | Latest official communication |
| `milestones[]` | Add new events with date, type, title, description, sourceUrl | Twitter/X, official blog, news, regulatory filings |
| `dateHistory[]` | Append an existing old date before changing `expectedLaunchDate`; do not fabricate history for an initial date (see Date History Protocol) | (mechanical) |
| `featuredContent[]` | Add notable new tweets, articles, blog posts, videos | Twitter/X, news, official blog |
| `contracts[]` | Add when a testnet/mainnet contract address is announced (rendered as "Target Chains" on the detail page) | Official deployment announcements, block explorers |
| `jurisdiction.regulator` | Fill when a named regulator, charter, or licensing body is confirmed (e.g., NYDFS, Anchorage Digital Bank, OCC) | Official comms, regulatory filings |
| AI summaries | Update in `data/ai-summaries.json` only on material changes defined in [Apply Approved Changes](SKILL.md#apply-approved-changes) | Research + editorial judgment (follow `write-ai-summaries` voice) |

### Step 5 promotion — preview-listing rationale

Listing existence alone is not enough — CoinGecko accepts issuer-submitted preview listings with zero supply before a token is deployed, and those produce false positives.

### Step 6 — Propose new candidates (optional)

After updating existing coins, sweep for pre-launch stablecoins we don't yet track. Use all three lanes:

- **DefiLlama diff**: Fetch `https://stablecoins.llama.fi/stablecoins`. Surface entries with near-zero `circulating` or with "preview" / "upcoming" / "testnet" markers in name or description.
- **News sweep**: use web search for recent stablecoin announcements and pilots. Filter out issuers already tracked across `shared/data/stablecoins/coins.generated.json` and `shared/data/stablecoins/canonical-order.json`.
- **Regulatory sweep**: use web search for stablecoin licenses, charters, EMI/MiCA approvals, and comparable primary regulator signals. Jurisdictional first-movers often foreshadow tracked-worthy launches.

For each candidate, report: name, symbol, issuer, peg currency, backing type, and a 1-line "why notable" (issuer size, novel mechanism, jurisdictional significance). Let the user decide whether to add. Do **NOT** add coins without user approval.

### Date History Protocol — rationale and example

Upcoming cards and stablecoin detail pages use `getDriftStatus` in `src/lib/pre-launch.ts`. Revision history drives the pushed-date badges; an elapsed current target becomes overdue even without history. Preserve old dates so the revision count and detail-page date trail remain accurate.

Example: If `expectedLaunchDate` is `"2026-Q2"` and it shifts to `"2026-Q4"`:
```json
"dateHistory": [{ "date": "2026-Q2", "setOn": "2026-03-22" }],
"expectedLaunchDate": "2026-Q4"
```

### Featured content — blog image downloads

- For blog images: download notable cover images to `public/featured/` using the naming convention `{coin-id}-{short-source}.{jpg|png|webp}` (e.g., `usdpt-coindesk.jpg`). Keep files ≤200KB where possible; prefer WebP or optimized JPEG over PNG for photos.
