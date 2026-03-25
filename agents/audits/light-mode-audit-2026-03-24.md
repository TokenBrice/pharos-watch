# Light mode audit plan

- Date: 2026-03-24
- Scope: product-facing routes and representative dynamic templates in light mode
- Method: route-family sampling plus direct visual inspection of critical pages/components
- Deliverable: concrete issues found, targeted fixes, validation status

## Findings

- Confirmed: PSI history chart event labels were too low-contrast in light mode over lower-risk bands.
- Confirmed: `/status/` used dark-only presentation styles inside the light theme, especially in `public-status-hero.tsx` and the priority-lane links in `page-primitives.tsx`.
- Spot-checked route families on the live site in light mode: home dashboard, analytics pages, methodology/about/start, and representative dynamic templates. No broader cross-site light-mode regression was confirmed from those checks.

## Changes made

- Updated PSI history event labels to use theme-aware text plus a surface-color halo for legibility.
- Rethemed the public status hero for light mode while preserving the existing dark-mode treatment.
- Fixed the status priority-lane link divider/index styling so it remains visible in light mode.

## Validation

- `npm run lint`
- `npm run build`
- `npm test`

## Mobile follow-up scope

- Focus: mobile viewport (`390x844`) in light mode
- Route families: home, analytics, detail/template pages, longform pages, public status, alerts landing page

## Mobile follow-up findings

- Spot-checked mobile light mode on live route families: homepage, Start Here, stability-index, Telegram alerts, and a representative stablecoin detail page.
- No additional concrete mobile-light regressions were confirmed from those checks.
- The public `/status/` route remains the main light-mode outlier on mobile as well, matching the local fix already applied in this branch.

## Mobile follow-up validation

- `npm run lint`
- `npm test`
