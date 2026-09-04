# Sitemap Tree Page

Route contract for `/sitemap-tree/`, the human-readable companion to `/sitemap.xml`.

## Route Shape

- Route: `src/app/sitemap-tree/page.tsx`
- Shared shell: `src/components/feature-page-shell.tsx`
- Navigation source: `src/lib/nav-config.ts` and `COMMAND_PALETTE_EXTRA_PAGES` in `src/components/command-palette-model.ts`
- Route inventory source: `src/lib/public-route-inventory.ts`
- Footer link: `src/components/footer.tsx`

The route is static, indexable, and fetches nothing. It is linked from the footer as `Sitemap` and acts as a crawlable hub, but it is not the site's only crawl path into the research hubs — the footer nav row carries persistent anchors for those independently.

## Metadata

`src/app/sitemap-tree/page.tsx` owns the title, description, and canonical `/sitemap-tree/` through `buildPageMetadata(...)` in `src/lib/page-metadata.ts`; the social image falls back to the shared default. Sitemap membership and priority are owned by `src/app/sitemap.ts`, and indexable-route membership by `src/lib/public-route-inventory.ts`; see [Architecture](./architecture.md).

## Information Architecture

The page authors no navigation tree of its own. Three of its six tier columns are looked up from `NAV_GROUPS` by key (`markets`, `risk`, `tools`); the other three are the labeled columns of the `more` group (`research`, `watch`, `pharos`), and the closing quick-access section renders `QUICK_NAV_ITEMS` and `BOTTOM_NAV_ITEMS`. Adding, removing, or reordering a nav item therefore reshapes this public page in the same change.

Three lookups are deliberately tolerant and fail silently rather than at build time:

- a tier whose `NAV_GROUPS` key no longer exists renders an empty column
- a `more` column whose key no longer exists renders an empty column
- a taxonomy row whose `href` is no longer in `COMMAND_PALETTE_EXTRA_PAGES` is filtered out

Renaming a nav group key, a `more` column key, or an extra-page href drops content from the page without failing a check, so verify the rendered tiers after any of those changes. Methodology changelog rows behave the opposite way: they resolve `publicPath` through `getMethodologyChangelogEntry()` in `shared/lib/methodology-versions/registry.ts`, which throws on an unknown key, and the route-local copy table is `satisfies`-bound to `MethodologyChangelogRegistryKey`.

The hand-curated sub-clusters (taxonomy browse, stablecoin profiles, About, methodology changelogs, more reference) are the exception to the derive-everything rule: they exist to surface a tier's children next to their parent. Stablecoin profile rows come from `TRACKED_STABLECOINS` in `shared/lib/stablecoins/registry.ts` with `buildStablecoinUrl()` from `shared/lib/urls.ts`, and their description is chosen from the coin's lifecycle status. `/coverage/` and `/funding/` are footer-only routes and reach this page through the indexed-archive backstop rather than a tier.

## Indexed Archive

The closing `Every remaining public route` section is the completeness backstop: it renders every `PUBLIC_ROUTE_INVENTORY` entry that the curated tiers and companion rows did not already list, labelled by its `PublicRouteKind`. A new indexable route family appears here automatically, so the page cannot silently fall behind the XML sitemap.

What it does not do: the archive is a projection, not a gate. Nothing asserts that the curated tiers agree with the inventory — the sitemap parity test in `src/app/__tests__/sitemap-frozen.test.ts` covers `src/app/sitemap.ts` against the registry, not this route. Deduplication is by exact `href` string, so a curated row that differs from its inventory entry only by trailing slash or hash is listed twice rather than suppressed.

## Update Rules

Update this contract when the tier derivation, the curated sub-clusters, or the indexed-archive fallback changes. Nav and route-inventory changes do not need an edit here unless they change that contract, but they do change the rendered page — treat `/sitemap-tree/` as a consumer of `src/lib/nav-config.ts` and `src/lib/public-route-inventory.ts`, and run `npm run seo:check` when route membership moves.
