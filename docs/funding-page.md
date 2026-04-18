# Funding page

Public ledger of Pharos's running costs and the donations that cover them. Stealth-released — `robots: noindex` and no navigation entry in v1.

## Data model

Two hand-maintained JSON files:

- `shared/data/funding/costs.json` — monthly cost line items. Owned by @TokenBrice; reviewed on the 1st of each month. `last_reviewed_at` (UTC unix seconds) is surfaced on the page footer so readers see freshness.
- `shared/data/funding/donations.json` — every inbound donation, one row each. Populated via the `funding-update` Claude skill on a ~weekly cadence.

Row shape for donations is defined in `shared/lib/funding/types.ts` (`Donation`). Each row carries `usd_at_receipt` priced at the transfer's block date, a `kind` field (`founder | pool | community`), and a `display` field with either a forward-verified ENS name or a human label.

## Intentional simplifications

- **No cron, no D1, no API.** The page imports both JSON files at build time and renders server-side. Static export is trivially CDN-cacheable.
- **No chart.** Until ≥6 months of donation history exist, a bar chart adds visual weight without showing anything meaningful. Revisit when the trailing window is populated.
- **No historical-pricing pipeline at runtime.** The `funding-update` skill prices each donation once at append time using CoinGecko `/coins/{id}/history` for native assets and $1 for stablecoins; the source is recorded in `price_note` on each row.
- **No ENS resolver module.** ENS reverse + forward-verify runs once per new address during the skill's run; results are frozen into `display` on the row.
- **No spam filter module.** Unknown-token pricing requires a manual USD value from the user, which naturally gates out spoofed-ticker spam.

If donation volume grows to the point where hand-curation becomes painful, promote the skill to a worker cron (daily Alchemy scan → D1 → `/api/funding-summary` endpoint). Everything the page renders is already derivable from what the skill writes, so the frontend does not need to change.

## Ownership & cadence

- `costs.json` — reviewed 1st of each month; bump `last_reviewed_at` every time you edit.
- `donations.json` — `funding-update` skill invoked ~weekly, or ad-hoc on alert. `last_updated_at` is bumped automatically by the skill.

## Voice

Match `/about`: honest, plain, concrete. No urgency, no banners, no modals. See the design spec at `agents/plans/2026-04-18-funding-page-design.md` for voice substitutions and the "nouns not verbs in card titles" rule.

## Related files

- Route: `src/app/funding/page.tsx`
- Sections: `src/components/funding/funding-page-sections.tsx`
- Helpers + types: `shared/lib/funding/`
- Data: `shared/data/funding/`
- Skill: `.claude/skills/funding-update/SKILL.md`
