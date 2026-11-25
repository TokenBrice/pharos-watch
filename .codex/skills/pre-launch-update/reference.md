## Pre-Launch Update — Extended Reference

Field scope, discovery lanes and noise filters, the date-history example, and image conventions. [SKILL.md](SKILL.md) owns every approval, scope and cadence rule; nothing here grants authority to add or change a coin.

### Scope of updates — field table

| Field | What to update | Source priority |
|---|---|---|
| `launchPhase` | Advance only on evidence; `LAUNCH_PHASE_VALUES` in `shared/types/stablecoin-lifecycle.ts` owns the vocabulary (the source file wins). `launched` also needs `launchDate`, a sourced launch milestone and a `listingStatusReview` naming the missing lane | Official announcements, docs, mainnet explorers |
| `expectedLaunchDate` | Update if shifted; `FuzzyDateSchema` in `shared/types/stablecoin-meta-primitives.ts` owns the supported date formats | Official comms, news articles |
| `announcedDate` | Backfill only when missing and a credible first-announcement date surfaces; never overwrite an existing value | Original press release, first official post |
| `launchPhaseDetail` | Refresh the free-text status line; testnet deployments and addresses belong here or in a milestone | Latest official communication |
| `milestones[]` | Add new events with date, type, title, description, sourceUrl | Official blog, X, news, regulatory filings |
| `dateHistory[]` | Append an existing old date before changing `expectedLaunchDate`; do not fabricate history for an initial date (see the example below) | (mechanical) |
| `featuredContent[]` | Add notable new posts, articles, blog posts, videos | X, news, official blog |
| `contracts[]` | Verified mainnet deployments only, through `stablecoin-identity-contracts`. Never a testnet address: the detail page links every row to a mainnet explorer. The profile labels them "Target chains" until the row is `launched`, then "Chains" | Official deployment announcements, block explorers |
| `jurisdiction.regulator` | Fill when a named regulator, charter, or licensing body is confirmed | Official comms, regulatory filings |
| AI summaries | Update in `data/ai-summaries.json` only on the material changes listed under [Apply approved changes](SKILL.md#apply-approved-changes) | Research + editorial judgment (follow `write-ai-summaries`) |

### Promotion — preview-listing rationale

A listing’s existence is not enough: CoinGecko accepts issuer-submitted preview listings with zero supply before a token is deployed, and those produce false positives. Require non-zero live supply.

### Discovery lanes

- **DefiLlama diff**: fetch `https://stablecoins.llama.fi/stablecoins` and surface entries with near-zero `circulating` or with "preview", "upcoming" or "testnet" markers in the name or description.
- **News sweep**: search recent stablecoin announcements and pilots; filter out issuers already tracked in `shared/data/stablecoins/coins.generated.json` and `shared/data/stablecoins/canonical-order.json`.
- **Regulatory sweep**: search stablecoin licenses, charters, EMI and MiCA approvals and comparable primary regulator signals. Jurisdictional first-movers often foreshadow launches worth tracking.

For each candidate report name, symbol, issuer, peg currency, backing type, the primary source or its absence, and one line on why it is notable.

### Search Console noise

Drop these before researching unmatched queries: Pharos brand and navigational queries, ISINs and other security identifiers, chain and testnet names, and former symbols of coins already tracked or retired.

### Date history — rationale and example

Upcoming cards and stablecoin detail pages use `getDriftStatus` in `src/lib/pre-launch.ts`. Revision history drives the pushed-date badges; an elapsed current target becomes overdue even without history. Preserve old dates so the revision count and detail-page date trail remain accurate.

Example: if `expectedLaunchDate` is `"2026-Q2"` and it shifts to `"2026-Q4"`:
```json
"dateHistory": [{ "date": "2026-Q2", "setOn": "2026-03-22" }],
"expectedLaunchDate": "2026-Q4"
```

### Featured content — blog image downloads

Download notable cover images to `public/featured/` as `{coin-id}-{short-source}.{jpg|png|webp}` (for example `usdpt-coindesk.jpg`). Keep files ≤200KB where possible; prefer WebP or optimized JPEG over PNG for photos.
