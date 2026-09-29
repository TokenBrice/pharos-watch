# Funding Page

Public ledger of Pharos's running costs, donations, and sustainability path. The route is public and indexable with canonical `/funding/`, sitemap coverage, Reference navigation, footer navigation, and a `/llms.txt` entry.

## Route and crawlability

- `src/app/funding/page.tsx` renders through `FeaturePageShell` and uses `buildPageMetadata(...)`.
- `src/app/sitemap.ts` includes `/funding/`; `lastModified` uses the latest of the route edit date, `costs.last_reviewed_at`, and `donations.last_updated_at`.
- `src/lib/nav-config.ts` no longer lists Funding: it is reachable from the global footer meta row, the about page, and the homepage donate card.
- `src/components/footer.tsx` includes Funding in the footer route list.
- `scripts/maintenance/generate-llms-txt.ts` includes Funding in the public LLM-facing index.
- `public/_headers` must not emit `X-Robots-Tag: noindex` for `/funding/*`.

## Layout

The page uses a prose-forward layout:

- The KPI card opens on a full-width hero strip whose frost-blue "One Beam" lights the monthly running cost (`costs.json` total). Coverage % stays **neutral** — it is a directional funding-progress figure and is never recolored frost.
- Cards use the shared flat `pharos-card-shell` treatment.
- Previous-month results use a compact comparison table with month, community funding, and coverage columns. Neutral inline bars reinforce the coverage percentage on wider screens; exact dollar and percentage figures remain visible at every viewport and use `.pharos-numeric`.
- The only sanctioned frost surface beyond the One Beam is the progress-bar fill (existing owner choice); this is the route-specific exception to the shared [Feature-page heroes](./design-language.md#feature-page-heroes) rule.

## Data model

Two hand-maintained JSON files:

- `shared/data/funding/costs.json` — monthly cost line items. Owned by @TokenBrice; the 1st of each month is the review target. `last_reviewed_at` (UTC unix seconds) is surfaced in the Monthly costs card footer/details text so readers can see a missed review instead of the page implying freshness. Both funding files are parsed with strict build-time schemas; invalid shapes, timestamps, or amounts fail the static build.
- `shared/data/funding/donations.json` — every inbound donation, one row each. Populated via the Pharos `funding-update` skill on a ~weekly cadence.

The Monthly costs card separately discloses $5,800 in exceptional, one-time design expenses for the full website redesign and logo. TokenBrice paid and sponsored those expenses, so they are not included in the recurring monthly total.

The same card carries Pharos's single in-kind sponsorship row: `Dwellir` (`category: "infra"`, `usd_per_month: 0`, note "Multi-chain RPC; 1-year Developer plan sponsored in kind"). The zero keeps the sponsored plan visible in the ledger without inflating the monthly running cost, and `CostBreakdown` renders an acknowledgment paragraph beside the TokenBrice one-time note — "Dwellir sponsors Pharos's multi-chain RPC access with a free one-year Developer plan (about $40/month in kind). Thank you, Dwellir." — with the vendor name linking to `https://www.dwellir.com`. Keep that wording aligned with whatever disclosure the sponsorship requires, and treat the row as disclosure rather than revenue: it is never repriced to a market rate unless the sponsorship actually becomes a paid line item.

Row shape for donations is defined and validated by `shared/lib/funding/schema.ts` (`DonationSchema`, with the `Donation` type inferred from it). Each row carries `usd_at_receipt` priced at the transfer's block date, a `kind` field (`founder | pool | community`), a `display` field with a forward-verified ENS name, custom/human label, or truncated-address fallback, and a required `token_address` field stored immediately after `asset_symbol`: the ERC-20 token contract as lowercase `0x` + 40 hex, or `null` for native assets (ETH on any chain, POL/MATIC, xDAI). Donor-key eligibility resolves the asset by `(chain, token_address)`; `asset_symbol` is display-only.

## Intentional simplifications

- **No cron, no D1, no API.** The page imports both JSON files at build time and renders server-side. Static export is trivially CDN-cacheable.
- **No chart.** Until ≥6 months of donation history exist, a bar chart adds visual weight without showing anything meaningful. Revisit when the trailing window is populated.
- **No historical-pricing pipeline at runtime.** The `funding-update` skill prices each donation once at append time: CoinGecko `/coins/{id}/history` applies to native ETH/WETH, native MATIC, and WBTC; qualifying USD-pegged stablecoins use $1 only after the contract-keyed qualifying check; EURC uses the ECB EUR/USD reference rate for the receipt date (Frankfurter), never 1:1; other tokens require a user-supplied USD value and price source. The source is recorded in `price_note` on each row.
- **No ENS resolver module.** ENS reverse + forward-verify runs once per new address during the skill's run; results are frozen into `display` on the row.
- **Human spam review, no standalone runtime module.** The maintained `funding-update` workflow asks the user to confirm candidate rows, performs ERC-20 contract-keyed identity checks while pricing (a qualifying ledger symbol is written only when the token contract matches the reviewed deployment for that chain, and a same-ticker impostor is suffixed with contract hex), and rejects familiar stablecoin tickers at unknown contracts as spoofed tokens; manual pricing is not the spam gate.

Automation is intentionally deferred while the review volume remains small. Any future runtime pipeline would require its own API, operations, and privacy contracts rather than being implied by this page doc.

## Supporter key

The page advertises the perk in the `How to support` card and the FAQ, all in `src/components/funding/funding-page-sections.tsx`. The `Supporter API key` note (`SupporterKeyNote`, directly under the donation tiles, wording switches on `DONOR_KEY_CLAIMS_OPEN`) names the qualifying stablecoins from the labels of `DONOR_KEY_QUALIFYING_STABLECOINS` in `shared/lib/funding/donor-eligibility.ts` — enumerating them while the list holds at most six entries, and switching to `one of {n} reviewed stablecoins` (with `n` the current list length) once it exceeds six — states that the key takes a direct transfer from a wallet the donor can sign with (not an exchange withdrawal or a Giveth stream), and deep-links `/api/#supporter-key` (`API_PAGE_ANCHORS.supporterKey`). The Giveth tile states that Giveth streams do not unlock the key, and the direct-wallet tile carries a one-line pointer to the same anchor. The `What do supporters get?` FAQ answer stays at three sentences, links `/api/#supporter-key`, and points teams that need higher limits to partner keys at `/api/#partner-access` (`API_PAGE_ANCHORS.partnerAccess`). `DonorList` renders with `id="supporters"` so `/api/` can deep-link the ledger (`/funding/#supporters`). Threshold, rate limit, and coin names always come from `DONOR_API_KEY_MIN_USD`, `DONOR_API_KEY_RATE_LIMIT_PER_MINUTE`, and `DONOR_KEY_QUALIFYING_STABLECOINS`; never hard-code them in copy. Donations recorded here also drive supporter API key eligibility. An externally-owned EVM wallet qualifies once its qualifying stablecoin donations sum to at least $10 in `usd_at_receipt`, excluding `pool` rows; founder stablecoin rows count. The threshold is inclusive, so exactly $10 qualifies; ETH, other non-stablecoin assets, and pooled payouts do not. Only stablecoins graded A+, A, A-, B+, B, or B- in the current non-held canonical accepted V9 Safety Score publication at claim time count. C/D/F/NR or missing grades do not count; an unavailable, missing, or held publication pauses claims with `503`. Values remain USD at receipt, not claim-time prices. Later grade changes do not revoke or alter an issued key. Eligibility is contract-keyed over the reviewed list in `DONOR_KEY_QUALIFYING_STABLECOINS` in `shared/lib/funding/donor-eligibility.ts` (that source file wins over any summary of it): a donation counts when `resolveDonorKeyQualifyingStablecoin` resolves its `(chain, token_address)`, with `asset_symbol` display-only. The five coins grandfathered from symbol-keyed eligibility count on every catalog contract on the six funding chains; coins added with contract keying count only on issuer-documented deployments, so bridged or same-ticker tokens never qualify. Adding a coin or deployment needs curation review plus the ledger-consistency drift-test update in the `shared/lib/funding` suite. The Worker reads the committed ledger, so a new donation becomes claimable only after the weekly `funding-update` reconciliation (run every Sunday) appends the row and a release ships. Every public mention of the perk (funding note, funding FAQ, API page terms, claim 403 message) states that the donor list is updated every Sunday, so a donation becomes claimable only after it appears on the funding page. When removal or correction of ledger evidence invalidates a previously issued key, the operator must also deactivate its `donor` key, because the runtime never rechecks the ledger after issuance. `docs/api-reference.md` owns the claim contract.

## Ownership & cadence

Donation-ledger changes select both Worker and Pages deployment through `scripts/lib/automation-registry.mjs`: the Worker embeds the eligibility ledger, while Pages publishes the funding view. Cost-only edits remain Pages-only.

- `costs.json` — target review date is the 1st of each month; if it is missed, leave the stale `last_reviewed_at` visible and complete the review before describing costs as current. Bump the timestamp every time you edit.
- `donations.json` — `funding-update` skill invoked ~weekly, or ad-hoc on alert. `last_updated_at` is bumped automatically by the skill.

## Editorial and presentation contract

Page prose follows the `brand` register in `docs/editorial-style.md`; this document does not define a second voice. Funding-specific presentation constraints: the page has no urgency banners or modals, and card titles are noun-led.

## Related files

- Route: `src/app/funding/page.tsx`
- Sections: `src/components/funding/funding-page-sections.tsx`
- Helpers + types: `shared/lib/funding/`
- Data: `shared/data/funding/`
- Skill: `.codex/skills/funding-update/SKILL.md`
