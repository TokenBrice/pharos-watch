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
- lead copy: `Last updated: February 2026`

---

## Content Contract

The current policy copy covers:

1. GA4-based anonymized analytics
2. no accounts or wallet connections
3. GA4 cookies only
4. 14-month GA4 retention
5. Cloudflare Pages / Workers hosting and Google Analytics as third-party services
6. support contact via `@PharosWatch` and the About page

Portfolio holdings are explicitly described as browser-local only, which matches the `/portfolio/` implementation.

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
