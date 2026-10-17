# Funding Page

Public `/funding/` is the static, indexable ledger of running costs and approved donations. `src/app/funding/page.tsx` and `src/components/funding/funding-page-sections.tsx` render build-time JSON; there is no page-specific cron, D1 or API. Preserve canonical/sitemap/navigation/footer/LLM-index discovery and no noindex header.

## Route and crawlability

Sitemap modification time is the newest route edit, cost review or ledger reconciliation time. Copy never implies real-time reconciliation. Funding follows the editorial brand register. Monthly running cost is the hero's One Beam; coverage remains neutral. Progress-bar frost is an explicit route exception to [feature-page heroes](./design-language.md#feature-page-heroes). No urgency banners/modals; titles are noun-led.

## Data model

`shared/lib/funding/schema.ts` owns strict build-time validation. Invalid shapes, times or amounts fail the build; never hide them with defaults.

- `shared/data/funding/costs.json`: recurring monthly line items, owner TokenBrice, review target first of month. `last_reviewed_at` remains visibly stale when missed; advance on edits only after review. Exceptional one-time sponsored design costs stay separately disclosed, outside recurring total.
- `shared/data/funding/donations.json`: human-approved inbound rows after self/spam rejection, reconciled roughly weekly/every Sunday for public claim timing. `last_updated_at` advances with approved rows; no approvals leaves the file unchanged.

A zero-dollar in-kind sponsorship stays a disclosure, not revenue or imputed market-rate cost. Dwellir's confirmed Growth-plan sponsorship has no invented valuation/term; only actual paid conversion permits repricing. Keep acknowledgment aligned with confirmed terms.

Donation identity is `(chain, token_address)`, not `asset_symbol`. Store ERC-20 addresses normalized lowercase; native assets use null. Symbol is display-only. Receipt USD is priced once at the transfer's block date, not current quote. Qualifying USD stablecoin parity requires contract-keyed admission; EURC uses receipt-date ECB EUR/USD, never 1:1. Unsupported tokens need user-provided USD/source. Record provenance in price_note; pricing is not spam approval.

The [funding-update workflow](../.codex/skills/funding-update/SKILL.md) owns reconciliation, receipt-date pricing and explicit candidate approval. ENS display requires reverse plus forward verification once per new address; freeze verified name/custom label/truncated fallback into the row. Unmatched same-ticker tokens get contract-distinct labels and cannot qualify by symbol. Do not imply an automated ENS or historical-pricing runtime pipeline.

## Supporter key

[API claim contract](./api-page.md#supporter-key-claim-contract) and [API reference](./api-reference.md) own eligibility, current-grade admission, key lifecycle/auth and private recovery. Funding only owns the evidence ledger and disclosure links. Use shared minimum/rate/qualifying-deployment constants, not repeated terms or hardcoded token lists.

`SupporterKeyNote` derives coin names from reviewed eligibility registry, respects paused claims, and links `/api/#supporter-key`. Direct-transfer/Giveth copy must distinguish signable donating wallets from exchange withdrawals/streams. Team access points to `/api/#partner-access`; `#supporters` remains the inbound API ledger anchor. Public mentions state donations become claimable only after the Sunday reconciliation appears on Funding and ships.

Worker embeds the same committed ledger used by Pages. Donation edits require both deployments through the automation registry; cost-only edits remain Pages-only. If ledger removal/correction invalidates evidence behind an issued donor key, the operator must also deactivate it: runtime does not recheck the ledger after issuance. Adding eligible coins/deployments requires curation and funding drift-test updates, not changing a display symbol.

## Ownership & cadence

Cost review and approved ledger updates retain original review/receipt clocks. A missed review stays visible until completed; no timestamp-only freshness claim. Any future automated pipeline requires its own operations/privacy/API contracts, not an implied extension of this static page.

## Editorial and presentation contract

Ledger totals and supporter counts use the full accepted dataset, not visible donor rows. Historic month comparisons expose exact values alongside neutral bars; unavailable evidence is not a zero donation/cost. Shared helpers/schema under `shared/lib/funding/` remain the numerical authority.
