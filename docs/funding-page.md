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

Aligned to the redesigned-homepage canon (owner-settled 2026-07-01) while keeping the honest, prose-forward register:

- The KPI card opens on a full-width hero strip whose frost-blue "One Beam" lights the monthly running cost (`costs.json` total). Coverage % stays **neutral** — it is a directional funding-progress figure and is never recolored frost.
- Cards are flat: the `ui/card` primitive's resting `shadow-sm` was removed directly, and `pharos-card-shell` (`box-shadow: var(--card-shadow)`, none at rest) sets the flat surface at the usage level.
- Previous-month coverage chips use the pill control visual; the prominent dollar/percent figures use `.pharos-numeric`.
- The only sanctioned frost surface beyond the One Beam is the progress-bar fill (existing owner choice). See `docs/design-language.md` → Reference-group hero calls.

## Data model

Two hand-maintained JSON files:

- `shared/data/funding/costs.json` — monthly cost line items. Owned by @TokenBrice; reviewed on the 1st of each month. `last_reviewed_at` (UTC unix seconds) is surfaced in the Monthly costs card footer/details text so readers see freshness.
- `shared/data/funding/donations.json` — every inbound donation, one row each. Populated via the `funding-update` Claude skill on a ~weekly cadence.

Row shape for donations is defined in `shared/lib/funding/types.ts` (`Donation`). Each row carries `usd_at_receipt` priced at the transfer's block date, a `kind` field (`founder | pool | community`), and a `display` field with a forward-verified ENS name, custom/human label, or truncated-address fallback.

## Intentional simplifications

- **No cron, no D1, no API.** The page imports both JSON files at build time and renders server-side. Static export is trivially CDN-cacheable.
- **No chart.** Until ≥6 months of donation history exist, a bar chart adds visual weight without showing anything meaningful. Revisit when the trailing window is populated.
- **No historical-pricing pipeline at runtime.** The `funding-update` skill prices each donation once at append time using CoinGecko `/coins/{id}/history` for native assets and $1 for stablecoins; the source is recorded in `price_note` on each row.
- **No ENS resolver module.** ENS reverse + forward-verify runs once per new address during the skill's run; results are frozen into `display` on the row.
- **No spam filter module.** Unknown-token pricing requires a manual USD value from the user, which naturally gates out spoofed-ticker spam.

If donation volume grows to the point where hand-curation becomes painful, promote the skill to a worker cron (daily Alchemy scan -> D1 -> proposed `/api/funding-summary` endpoint). Everything the page renders is already derivable from what the skill writes, so the frontend does not need to change.

## Ownership & cadence

- `costs.json` — reviewed 1st of each month; bump `last_reviewed_at` every time you edit.
- `donations.json` — `funding-update` skill invoked ~weekly, or ad-hoc on alert. `last_updated_at` is bumped automatically by the skill.

## Voice

Match `/about`: honest, plain, concrete. No urgency, no banners, no modals. Keep card titles noun-led and avoid fundraising pressure copy.

## Related files

- Route: `src/app/funding/page.tsx`
- Sections: `src/components/funding/funding-page-sections.tsx`
- Helpers + types: `shared/lib/funding/`
- Data: `shared/data/funding/`
- Skill: `.claude/skills/funding-update/SKILL.md`
