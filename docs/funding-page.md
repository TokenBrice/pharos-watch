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

Row shape for donations is defined and validated by `shared/lib/funding/schema.ts` (`DonationSchema`, with the `Donation` type inferred from it). Each row carries `usd_at_receipt` priced at the transfer's block date, a `kind` field (`founder | pool | community`), and a `display` field with a forward-verified ENS name, custom/human label, or truncated-address fallback.

## Intentional simplifications

- **No cron, no D1, no API.** The page imports both JSON files at build time and renders server-side. Static export is trivially CDN-cacheable.
- **No chart.** Until ≥6 months of donation history exist, a bar chart adds visual weight without showing anything meaningful. Revisit when the trailing window is populated.
- **No historical-pricing pipeline at runtime.** The `funding-update` skill prices each donation once at append time: CoinGecko `/coins/{id}/history` applies to native ETH/WETH, native MATIC, and WBTC; stablecoins use $1 after a canonical contract check; other tokens require a user-supplied USD value and price source. The source is recorded in `price_note` on each row.
- **No ENS resolver module.** ENS reverse + forward-verify runs once per new address during the skill's run; results are frozen into `display` on the row.
- **Human spam review, no standalone runtime module.** The maintained `funding-update` workflow asks the user to confirm candidate rows, performs ERC-20 contract-address checks while pricing, and rejects familiar stablecoin tickers at unknown contracts as spoofed tokens; manual pricing is not the spam gate.

Automation is intentionally deferred while the review volume remains small. Any future runtime pipeline would require its own API, operations, and privacy contracts rather than being implied by this page doc.

## Supporter key

The page advertises the perk in two places: a `Supporter API key` note inside the `How to support` card (`SupporterKeyNote` in `src/components/funding/funding-page-sections.tsx`, wording switches on `DONOR_KEY_CLAIMS_OPEN`) and the `What do supporters get?` FAQ answer. Donations recorded here also drive supporter API key eligibility. An externally-owned EVM wallet qualifies once its stablecoin donations sum to strictly more than $10 in `usd_at_receipt`, excluding `pool` rows; founder stablecoin rows count. Exactly $10, ETH, other non-stablecoin assets, and pooled payouts do not qualify. Only stablecoins graded A+, A, A-, B+, B, or B- in the current non-held canonical accepted V9 Safety Score publication at claim time count. C/D/F/NR or missing grades do not count; an unavailable, missing, or held publication pauses claims with `503`. Values remain USD at receipt, not claim-time prices. Later grade changes do not revoke or alter an issued key. Reuse `shared/lib/funding/donor-eligibility.ts` for the reviewed stablecoin symbol-to-canonical-ID mapping (USDC, USDT, DAI, USDGLO) and threshold calculation. Token contracts are verified during ledger curation; new stablecoins require a reviewed allowlist update. The Worker reads the committed ledger, so a new donation becomes claimable only after the weekly `funding-update` reconciliation appends the row and a release ships. When removal or correction of ledger evidence invalidates a previously issued key, the operator must also deactivate its `donor` key, because the runtime never rechecks the ledger after issuance. `docs/api-reference.md` owns the claim contract.

## Ownership & cadence

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
