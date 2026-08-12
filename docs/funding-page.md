# Funding Page

Public ledger of Pharos's running costs, donations, and sustainability path. The route is public and indexable with canonical `/funding/`, sitemap coverage, Reference navigation, footer navigation, and a `/llms.txt` entry.

## Route and crawlability

- `src/app/funding/page.tsx` renders through `FeaturePageShell` and uses `buildPageMetadata(...)`.
- `src/app/sitemap.ts` includes `/funding/`; `lastModified` uses the latest of the route edit date, `costs.last_reviewed_at`, and `donations.last_updated_at`.
- `src/lib/nav-config.ts` places Funding in the `Reference` group.
- `src/components/footer.tsx` includes Funding in the footer route list.
- `scripts/maintenance/generate-llms-txt.ts` includes Funding in the public LLM-facing index.
- `public/_headers` must not emit `X-Robots-Tag: noindex` for `/funding/*`.

## Layout

The page keeps an honest, prose-forward register:

- The KPI card opens on a full-width hero strip whose frost-blue "One Beam" lights the monthly running cost (`costs.json` total). Coverage % stays **neutral** — it is a directional funding-progress figure and is never recolored frost.
- Cards use the shared flat `pharos-card-shell` treatment.
- Previous-month results use a compact comparison table with month, community funding, and coverage columns. Neutral inline bars reinforce the coverage percentage on wider screens; exact dollar and percentage figures remain visible at every viewport and use `.pharos-numeric`.
- The only sanctioned frost surface beyond the One Beam is the progress-bar fill (existing owner choice); this is the route-specific exception to the shared [Feature-page heroes](./design-language.md#feature-page-heroes) rule.

## Data model

Two hand-maintained JSON files:

- `shared/data/funding/costs.json` — monthly cost line items. Owned by @TokenBrice; the 1st of each month is the review target. `last_reviewed_at` (UTC unix seconds) is surfaced in the Monthly costs card footer/details text so readers can see a missed review instead of the page implying freshness.
- `shared/data/funding/donations.json` — every inbound donation, one row each. Populated via the Pharos `funding-update` skill on a ~weekly cadence.

The Monthly costs card separately discloses $5,800 in exceptional, one-time design expenses for the full website redesign and logo. TokenBrice paid and sponsored those expenses, so they are not included in the recurring monthly total.

Row shape for donations is defined in `shared/lib/funding/types.ts` (`Donation`). Each row carries `usd_at_receipt` priced at the transfer's block date, a `kind` field (`founder | pool | community`), and a `display` field with a forward-verified ENS name, custom/human label, or truncated-address fallback.

## Intentional simplifications

- **No cron, no D1, no API.** The page imports both JSON files at build time and renders server-side. Static export is trivially CDN-cacheable.
- **No chart.** Until ≥6 months of donation history exist, a bar chart adds visual weight without showing anything meaningful. Revisit when the trailing window is populated.
- **No historical-pricing pipeline at runtime.** The `funding-update` skill prices each donation once at append time using CoinGecko `/coins/{id}/history` for native assets and $1 for stablecoins; the source is recorded in `price_note` on each row.
- **No ENS resolver module.** ENS reverse + forward-verify runs once per new address during the skill's run; results are frozen into `display` on the row.
- **No spam filter module.** Unknown-token pricing requires a manual USD value from the user, which naturally gates out spoofed-ticker spam.

Automation is intentionally deferred while the review volume remains small. Any future runtime pipeline would require its own API, operations, and privacy contracts rather than being implied by this page doc.

## Ownership & cadence

- `costs.json` — target review date is the 1st of each month; if it is missed, leave the stale `last_reviewed_at` visible and complete the review before describing costs as current. Bump the timestamp every time you edit.
- `donations.json` — `funding-update` skill invoked ~weekly, or ad-hoc on alert. `last_updated_at` is bumped automatically by the skill.

## Voice

Match `/about`: honest, plain, concrete. No urgency, no banners, no modals. Keep card titles noun-led and avoid fundraising pressure copy.

## Related files

- Route: `src/app/funding/page.tsx`
- Sections: `src/components/funding/funding-page-sections.tsx`
- Helpers + types: `shared/lib/funding/`
- Data: `shared/data/funding/`
- Skill: `.codex/skills/funding-update/SKILL.md`
