# Privacy Page

Route contract for `/privacy/`, the longform privacy-policy surface linked from the site footer.

---

## Route Shape

- **Route file:** `src/app/privacy/page.tsx`
- **Shared shell:** `src/components/feature-page-shell.tsx`
- **Primary navigation surface:** `src/components/footer.tsx`

The route is static and frontend-only. It does not call worker APIs.

---

## Metadata Contract

`src/app/privacy/page.tsx` defines:

- title: `Privacy Policy`
- description: `Pharos privacy policy: what data we collect, how we use it, and your choices.`
- canonical: `/privacy/`
- Open Graph image: `/og-card.png`

The page renders through `FeaturePageShell` with:

- `breadcrumbName = "Privacy Policy"`
- `path = "/privacy/"`
- `variant = "longform"`
- `containerClassName = "max-w-2xl"`
- lead copy: `Last updated: March 2026`

---

## Content Contract

The current policy copy covers:

1. optional GA4-based anonymized analytics when `NEXT_PUBLIC_GA_ID` is configured at build time
2. no accounts or wallet connections
3. GA4 cookies only, and only when analytics is enabled
4. 14-month GA4 retention when GA4 is enabled
5. Cloudflare Pages / Workers hosting and Google Analytics as third-party services
6. support contact via `@PharosWatch` and the About page
7. optional Telegram/X handles submitted through the feedback form appear publicly on the GitHub issue created for your submission

Portfolio holdings are explicitly described as browser-local only, which matches the `/portfolio/` implementation. The page now also notes that any delegated feedback contact handle will be visible in the GitHub issues that Pharos creates.

### Telemetry Contract

- `src/app/layout.tsx` injects the GA4 script only when `NEXT_PUBLIC_GA_ID` is set. When that env var is unset, Pharos does not load Google Analytics and `src/lib/analytics.ts` becomes a no-op wrapper around `window.gtag`.
- `src/lib/analytics.ts` is the typed event catalog for custom telemetry. Current events cover feature adoption (`stress_test_run`, `comparison_*`), engagement (`search_performed`, `filter_applied`, `time_range_changed`, `sort_changed`, `contract_copied`), portfolio actions, and UI toggles (`theme_toggled`, `panel_toggled`).
- The policy page is static and frontend-only, but its analytics claims must stay aligned with both `src/app/layout.tsx` and `src/lib/analytics.ts`.

---

## Navigation And Discoverability

- Footer links point to `/privacy/` from both desktop and mobile footer layouts in `src/components/footer.tsx`.
- The route is included in `src/app/sitemap.ts`.
- The design-language doc treats this page as a constrained longform layout (`max-w-2xl`).

---

## Update Rules

When editing privacy-policy copy, keep these surfaces aligned:

1. `src/app/privacy/page.tsx` for the visible policy text and metadata
2. this document for route-level behavior and integration notes
3. any footer-navigation changes in `src/components/footer.tsx`

If the policy date changes, update the visible `Last updated:` line in the page component in the same change.

---

## File Index

| File | Role |
|------|------|
| `src/app/privacy/page.tsx` | Longform privacy policy route and metadata |
| `src/components/feature-page-shell.tsx` | Shared longform shell used by the route |
| `src/components/footer.tsx` | Footer links to `/privacy/` |
| `src/app/sitemap.ts` | Includes `/privacy/` in sitemap output |
| `docs/design-language.md` | Layout token reference for the page width constraint |
