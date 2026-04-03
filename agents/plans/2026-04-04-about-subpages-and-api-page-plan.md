# About Subpages And API Page Plan

## Goal

Free primary-navigation space by moving low-frequency reference pages out of the main menu, then surface them together from `/about/` with a dedicated link module and a new API reference page.

## Assumptions

- Keep existing public routes `/coverage/`, `/methodology/`, and `/start/` live.
- Treat them as About-linked reference pages in the information architecture rather than physically relocating every route to `/about/*`.
- Add the new API page as `/about/api/` so the new surface clearly belongs to the About/reference cluster.

This is the least-risk path because `/methodology/` is already deeply linked across the product and docs, and `/start/` is tied to homepage onboarding state.

## Planned Changes

1. Remove `Methodology`, `Coverage`, and `Start Here` from primary navigation config so they no longer occupy sidebar/mobile-menu space.
2. Add a reusable About page module directly below the About title/lead for four reference links:
   - Methodology
   - Coverage
   - Start Here
   - API
3. Create `/about/api/` as a long-form navigable page that:
   - explains the public-vs-site-vs-ops auth model up front
   - makes the API-key requirement explicit
   - renders the checked-in `docs/api-reference.md` content in a scan-friendly, navigable format
4. Update route metadata/sitemap and docs that describe About and route inventory.

## Validation

- `npm run lint`
- `npm test`
- `npm run build`
