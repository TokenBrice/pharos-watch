# OG Images

> **Agent navigation** — Start with [Route cards](#1-route-cards) and [CI guardrails](#ci-guardrails). Grep the numbered card-family heading for editorial · mechanism explainer · case-study · Cemetery · selector · blog · dynamic Worker cards; use each family's renewal instructions rather than reading wholesale.

Pharos serves eight classes of Open Graph / Twitter preview images. They have different generation pipelines and different renewal cadences.

## 1. Route cards

Route share cards replaced the weekly page screenshots on 2026-10-12. A screenshot carried a figure with no generation, and several carried live-state claims ("LIVE · AS OF …", "1 open incident", a flow verdict) that went false within hours. A route card either states one figure stamped with the generation that produced it, or states no figure at all.

`shared/lib/og-route-cards.ts` is the single authority for the route keys, kicker, two-line promise, `public/` filename and layout shared by both variants. `OG_LIVE_PAGE_SLUGS` lists the routes that select the live card.

### Live cards (`/api/og/page/:slug`)

The live routes' metadata selects `buildLiveRouteOgImageUrl(slug)` (`src/lib/page-metadata.ts`). The Worker reads each hero in process from the owner the public endpoint uses (no self-fetch, no connection-budget cost) and reduces it with the same shared helper the page uses. See [§8](#8-dynamic-worker-cards-apiog) for the rendering pipeline.

| Slug | Route | Hero (owner → reducer) | Support (each dropped independently on failure) | Budget |
| --- | --- | --- | --- | --- |
| `home` | `/` | Total stablecoin market cap: stablecoins cache → `buildLiveHomepageHeroSnapshot` | Displayed PSI band and score; active depegs | `stablecoins` |
| `chains` | `/chains/` | Largest chain's share of observed global supply (max `dominanceShare`): `handleChains` body, with the homepage completeness verdict over the same stablecoins generation; timeless (`incomplete-coverage`) when the leader or runner-up has an unavailable chain observation | Next two chains' shares and the observed (or known-subtotal) global supply; share bar only when shares sum to at most 1 | `chains` |
| `dependency-map` | `/dependency-map/` | Mapped direct exposure: `projectDependencyGraph` + market caps → `buildDependencyHubsModel` | Upstream hubs; direct dependents | `stablecoins` and `reportCards`; stamped with the older read |
| `timeline` | `/timeline/` | Open depeg incidents: `selectActiveDepegCoins` (`shared/lib/active-depegs.ts`) over `/api/peg-summary`, the homepage census | — | `pegSummary` |
| `flows` | `/flows/` | Bank Run Gauge score and published band: mint-burn-flows body `gauge.score` / `gauge.band` (`formatBankRunGaugeScore`, `resolvePublishedGaugeBand`); a null score falls back to the timeless card (`figure-null`); the stamp adds "partial: N weighted coins withheld" when `partialValuationInputs > 0`; a band that withheld weight could move is omitted and the stamp reads "band unsettled: N weighted coins withheld" (`assessGaugeBandSettlement`, same rule as the digest) | — | `mintBurnFlows` |
| `freezewatch` | `/freezewatch/` | Freezable share: stablecoins cache → `buildBlacklistStatusBuckets` → `computeFreezableSummary` | Freezable market cap; freezable coin count | `stablecoins` |
| `liquidity` | `/liquidity/` | Total DEX TVL: `handleDexLiquidity` global row | — | `dexLiquidity` |
| `alt-pegs` | `/alt-pegs/` | Non-USD market cap of the core universe: stablecoins cache → `buildNonUsdMarketSnapshot` (`shared/lib/alt-peg-snapshot.ts`), the same reducer as the page; a partial total shows as a known subtotal stamped `Partial · x/y non-USD coins observed` | Top three peg shares (only when every non-USD coin reports supply) | `stablecoins` |
| `yield` | `/yield/` | Ranked yields: summary projection → `dedupeYieldRankings` | Median 30D APY of A/B-graded rows (never the top APY) | `yieldRankings` |

The timeline card counts the full open set the homepage reads, not the feed's windowed event page, so an incident opened before the feed window still counts (ADR-34). The `/api/og/depeg` summary card counts open `depeg_events` rows instead and labels that figure **OPEN DEPEG EVENTS**.

The Budget column names the source; its admission budget is `OG_SOURCE_BUDGET_SEC` (`worker/src/api/og-page/types.ts`): the same fresh ceiling the owner endpoint publishes as `_meta.status: "fresh"` (`API_FRESHNESS_MAX_AGE_SEC` × the cache's fresh ratio from `getCacheRatioThresholds`), never less than two producer intervals. A card therefore shows its figure exactly while its page reads fresh and goes timeless once the page itself would warn.

Fail-closed contract:

- The hero source must be present, inside its admission budget, not a held publication, and published by its page. Otherwise the Worker serves the route's timeless card with `200`, `X-Og-Status: timeless` and a closed-vocabulary `X-Og-Reason` (`cache-missing`, `stale-cache`, `held-publication`, `incomplete-coverage`, `figure-null`, `owner-error`, `render-error`, `timeless-by-decision`). A card mirrors its page: where the page publishes a partial total as a labelled known subtotal (home, chains, dependency map), the card shows the same figure and names the gap in its stamp (`Partial · 266/267 assets observed`, `excl. 3 coins without supply data`); it goes timeless only where the page itself withholds the number (for example a partial FreezeWatch share).
- The stamp names the hero's generation time (`As of 12 Oct 2026, 14:05 UTC`), never the render clock. A cached copy on a social platform is therefore self-dating. Live responses carry `X-Og-Status: live`, `X-Og-Generation`, `X-Og-As-Of`, `X-Og-Freshness-Budget` and `X-Og-Assessed-At`, cached for the 15-minute `ogImage` lifetime or until the figure leaves its admission budget, whichever is sooner (`buildOgImageCacheControl`, floored at one minute). Timeless responses use the 5-minute `custom` profile so the live card returns soon after its source recovers.
- There are no colored verdicts. The flows card states the gauge score and its band name, never a net-direction verdict. The top rule is neutral ink on every card; the only data hue is the PSI band swatch on the home card, drawn only when that render read a fresh PSI. Each card shows its route's navigation glyph (`shared/lib/og-route-glyphs.ts`, drift-tested against `src/lib/nav-config.ts`). An optional neutral share bar or pair of bars re-draws figures the card already prints, and a share bar is omitted when chain shares over-attribute (sum above 1).
- Sublabels name the figure's basis: the chains hero is a share of the same core-aggregate supply as the homepage, and unavailable chain observations are named in its stamp (`Partial · N chain observations unavailable`), dependency exposure is gross, and flows cover tracked issuance chains.
- A share card is presentation that inherits its page's methodology. It must show the page's exact published figure and needs no methodology-changelog entry of its own.

### Timeless cards (`public/og-*.png`)

Generated by `scripts/maintenance/build-og-route-timeless.ts` through the shared static runner, with the Geist faces the Worker uses. Each card has the route kicker, its two-line promise and `Live figures at pharos.watch/<route>`. It has no figure, date or state claim. The filenames are the retired screenshot roster's, so inbound links keep resolving.

| Image | Route | Selected by |
| --- | --- | --- |
| `og-card.png` | `/` | Live-card fallback; default image in `src/lib/page-metadata.ts` and `src/app/layout.tsx`; `/compliance/`; docs JSON-LD |
| `og-chains.png`, `og-dependency-map.png`, `og-timeline.png`, `og-flows.png`, `og-blacklist.png`, `og-liquidity.png`, `og-yield.png`, `og-alt-pegs.png` | live routes | Worker fail-closed twin; legacy inbound links |
| `og-coverage.png` | `/coverage/` | route metadata |
| `og-stablecoins.png` | `/stablecoins/`, peg and taxonomy pages | route metadata; quarantined/delisted dossier fallback |
| `og-upcoming.png` | `/upcoming/` | route metadata; pre-launch dossier fallback |
| `og-compare.png` | `/compare/`, `/compare/[slug]/` | route metadata |
| `og-default.png` | `/screener/` | route metadata |
| `og-funding.png` | `/funding/` | route metadata |
| `og-pharoswatchbot.png` | `/pharoswatchbot/` | route metadata |
| `og-changelog.png` | `/changelog/` | route metadata |
| `og-portfolio.png` | `/portfolio/` | route metadata |

Registry-derived counts (coverage, upcoming, stablecoins), funding and bot figures and the portfolio fixture stay timeless by decision: a count that changes per deploy or a demo portfolio adds nothing a shared card needs. `/upcoming/` shares through `/api/og/page/upcoming`: its loader always answers `timeless-by-decision`, so the route serves the timeless card (200, `X-Og-Status: timeless`, `X-Og-Reason: timeless-by-decision`, logged at info, not as a failure).

### How to renew

```bash
npm run build:og-route-timeless
npm run check:generated-artifacts -- --only=og-route-timeless
```

### When to renew

- After changing a route's copy or the layout in `shared/lib/og-route-cards.ts`.
- After changing the brand mark (`public/pharos-mark-on-light.svg`) or the Geist font files.

## 2. Editorial content cards (`public/og-editorial-*.png`)

Generated by `scripts/maintenance/build-og-editorial.mjs` for long-form/editorial route families. The template renders a shared light editorial card aligned with the current product shell and varies the kicker/title per category. Editorial, mechanism, and case-study cards share `scripts/lib/og-static-runner.mts`, which loads the local fonts, fingerprints source/font inputs, rasterizes SVG through Firefox, and compares PNGs with the existing small-raster-drift tolerance.

Write mode renders each PNG into ignored staging first and replaces the checked-in file only when its pixels changed beyond the same tolerance used by check mode. Routine local builds therefore leave visually unchanged OG assets and their modification times untouched despite Firefox encoding drift.

| Image | Used by |
| --- | --- |
| `og-editorial-about.png` | `/about/` |
| `og-editorial-depeg.png` | Depeg briefings |
| `og-editorial-digest.png` | Daily/weekly digest pages |
| `og-editorial-learn.png` | `/learn/mechanisms/`, `/learn/case-studies/` |
| `og-editorial-methodology.png` | Methodology pages |

The Cemetery card (`og-editorial-cemetery.png`) was retired on 2026-09-30: `/cemetery/` selects the generated plot-map card (§5).

### How to renew

```bash
npm run build:og-editorial
npm run check:generated-artifacts -- --only=og-editorial
```

### When to renew

- After changing the editorial OG template.
- After changing the card roster in `build-og-editorial.mjs`.
- After a methodology version pin change that affects the rendered card.

## 3. Mechanism explainer cards (`public/og-learn-*.png`)

Generated for `/learn/mechanisms/[archetype]` pages. The pipeline renders the mechanism diagram SVG directly from `src/components/stablecoin-detail/mechanism-diagrams/` and sends it through the shared static runner so the committed PNG stays diagram-consistent.

The complete card roster is `MECHANISM_EXPLAINER_ENTRIES` in `src/lib/mechanism-explainer-registry.ts`; each entry owns its slug, title, and `ogFilename`. The generator maps that registry directly rather than maintaining a separate image list.

### How to renew

```bash
node --import tsx scripts/maintenance/build-og-learn-images.ts
npm run check:generated-artifacts -- --only=og-learn
```

The build writes the generated SVG sources to `agents/og-learn-staging/` and rasterizes them into the committed PNG roster. `--check` regenerates each source, verifies the source and local-font hashes, and compares the rendered PNG with the committed asset; it is not an existence-only check.

Mechanism cards set their text in the repo fonts the runner loads (`Newsreader` for the title, `GeistMono` elsewhere), never a `system-ui` stack: with system fonts the Linux CI raster differs from a macOS raster by ~5% of pixels, beyond the drift tolerance, so the pixel check could only ever pass on the machine that rendered the asset.

### When to renew

- After a mechanism diagram update (any change under `src/components/stablecoin-detail/mechanism-diagrams/`).
- After an archetype title change in `MECHANISM_EXPLAINER_TITLES` (`src/lib/mechanism-explainer-registry.ts`), which the build reads through `MECHANISM_EXPLAINER_ENTRIES`.
- After a new mechanism archetype is added (also requires a new content module per [Learn: mechanisms](./learn-page.md#mechanisms)).

## 4. Case-study cards (`public/og-learn-case-*.png`)

Generated by `scripts/maintenance/build-og-case-studies.ts` for `/learn/case-studies/[slug]/` pages from the typed case-study content registry.

Like the editorial generator, write mode promotes staged PNGs only when their pixels changed materially, avoiding transient Git changes from Firefox encoding drift during routine builds. The shared static runner records the source and local-font hashes in the signature sidecar.

### How to renew

```bash
npm run build:og-case-studies
npm run check:generated-artifacts -- --only=og-case-studies
```

### When to renew

- After adding, removing, or renaming a case-study in `CASE_STUDY_LIST` (the build reads the typed registry).
- After changing a case-study title, eyebrow, or outcome that appears on the card (subtitle and eventDateLabel are not rendered on the OG card).
- After changing the shared case-study OG template.

## 5. Stablecoin Cemetery card (`public/og-cemetery.png`)

Generated by `scripts/maintenance/build-og-cemetery.ts` for `/cemetery/`. It owns the real light-theme desktop plot-map composition, crop and palette settings for the 1200×630 card. Generic CSS-module/token/font loading and screenshot rendering belong to `scripts/lib/scene-og.ts`; see [Data Visualization: Scene Kit](./data-visualization.md#scene-kit).

Freshness is an input signature, not a pixel comparison. `scripts/maintenance/state/og-cemetery-signature.json` records the SHA-256 of the rendered document and the hash of the PNG written from it. `--check` rebuilds the document (no browser) and verifies both hashes and the PNG dimensions. It gives the same result on every platform. Write mode is a no-op while the check passes; `--force` re-renders anyway.

It is the registered `og-cemetery` generated artifact and depends on `cemetery-logo-atlas`; regenerate it explicitly after adding a death or changing a cemetery logo. Its sources are the dead-coin data and frozen catalog, the cemetery modules, the plot-map model, geometry, scene, shapes and CSS module, the scene kit (`shared/lib/scene/`, `src/components/scene/`, `scripts/lib/scene-og.ts`), the atlas, the design tokens and the fonts.

### How to renew

```bash
npm run build:og-cemetery
npm run check:generated-artifacts -- --only=og-cemetery
```

### When to renew

- Automatically at commit time when a source changes (a new death, a plot-map or token change, a new atlas).
- After changing the card composition in `build-og-cemetery.ts`: bump `OG_CEMETERY_GENERATOR_VERSION`.

## 6. Selector profile cards (`public/og-selector-*.png`)

`public/og-selector-default.png` is the retained static Picker metadata card. [Screener snapshot sharing](./screener-page.md#snapshot-sharing) owns the profile-level preview and no-answer/no-shortlist privacy contract.

## 7. Blog cards (`public/og-blog.png`, `public/blog/*-cover.png`)

The `/blog/` hub uses the authored shared `public/og-blog.png` card. Individual posts use their optional `BlogPost.coverImage` for Open Graph and Twitter metadata as well as the article and hub-card image; posts without a cover fall back to `og-blog.png`. Cover images are authored 1200×630 assets, not generator outputs. The registry and route behavior live in `src/data/blog/index.ts` and `src/app/blog/[slug]/page.tsx`; follow [process/blog-publishing.md](./process/blog-publishing.md) when adding or changing one.

### When to renew

- After deliberately changing the shared blog identity card.
- When publishing or revising a post whose registry entry selects a cover image.
- Do not add blog covers to the screenshot or editorial-card generators; their lifecycle belongs to the post source.

## 8. Dynamic Worker cards (`/api/og/*`)

Rendered on-request by `worker/src/api/og.tsx` using satori + resvg WASM, cached 15 minutes via `API_CACHE_PROFILES.ogImage`. The shared frame follows the current light product shell and semantic status colors. **Self-renewing — no manual step.**

Stablecoin and depeg cards read DEWS through `stress-signals-current-rows.ts`, the same publication owner as `/api/stress-signals`. They honor completed-generation coverage rather than selecting raw maximum timestamps, so superseded or staged rows cannot override the published generation. Both use the API's eight-times-freshness fallback threshold for materialized rows and retain the owner's last-valid/history fallback (including an older single-coin result); unavailable authority yields no DEWS row. Existing rendering and response-cache limits are unchanged.

Stablecoin cards preserve unavailable price, DEWS, liquidity, market cap, metadata, and seven-day flow as `—`; unavailable readings do not imply par, calm, zero liquidity, or a backing/governance classification. A numeric zero remains an observed zero. Seven-day measured flow is labelled **7D NET MINT/BURN**; when absent, a **7D SUPPLY DELTA** is shown only if both current and prior-week USD supply are available. Supply change is not measured mint/burn. With fewer than two price-history points the chart is replaced by **Price history unavailable**, never a synthetic flat line. The sparkline selects the latest seven non-null `supply_history` prices, not a date-bounded seven-day window. Since mint-burn-flow v6.23 new rows never store a nominal par reference; a currently nominal coin draws no price line. A currently observed coin can retain older legacy par points until newer priced rows displace them. Since mint-burn-flow v6.23 the seven-day mint/burn cell follows the hourly valuation completeness: a complete window shows its signed net, a partial window (unpriced events) shows only its known gross subtotal as a lower bound (**7D GROSS (MIN)**, `$X+`, neutral color, never a signed net and never replaced by the supply delta), and a window with legacy coverage-unknown buckets keeps its net under **7D NET (UNVERIFIED)** in neutral color. When the published price is a nominal par reference (`priceObservedAtMode: "nominal_reference"`, pricing v6.38), the price cell is labelled **NOMINAL PAR** instead of **PRICE**, so par is never presented as an observed market price; an observed price, including a trusted market discount on a nominal-par route, keeps the **PRICE** label.

| Route | Source |
| --- | --- |
| `/api/og/stablecoin/:id` | per-stablecoin card (referenced from `src/lib/page-metadata.ts → buildStablecoinDetailMetadata`) |
| `/api/og/safety-scores` | safety scores summary card |
| `/api/og/depeg` | depeg summary card |
| `/api/og/stability-index` | stability index summary card |
| `/api/og/chain/:id` | per-chain card (referenced from `src/app/chains/[chain]/page.tsx` via `API_PATHS.ogChain`) |
| `/api/og/page/:slug` | live route cards ([§1](#1-route-cards)); unknown slug → `404` |

A chain absent from the current aggregate renders a figure-free "No current supply observation" card with `X-Og-Status: degraded` and `X-Og-Reason: chain-not-in-aggregate`, never `$0`: absence from the aggregate is not an observed zero (ADR-28).

Summary cards keep missing DEWS counts, safety coverage and window averages unavailable. Fewer than two PSI history observations yield no sparkline, and PSI 24h change uses a sample within one hour before source-minus-24h, else it is unavailable. PSI and safety freshness headers name the assessment clock, budget and generation where available.

These are the OG images that automatically reflect current data. If their template needs to change, edit `worker/src/lib/og-templates/*` and run worker tests.

The Worker pins Satori to `0.32.0`. Satori `0.33.x` introduces HarfBuzz initialization that reads `self.location.href`, which is unavailable in workerd and makes every dynamic card fail with `503`. Upgrade only after the real Worker render check passes: `npx vitest run scripts/__tests__/og-worker-runtime.test.ts worker/src/api/__tests__/og.test.tsx`. The runtime check executes the production Satori/Yoga/resvg pipeline in local workerd and decodes cold and warm 1200×628 PNG responses; the existing Node SVG tests cover the individual card templates. After deployment, verify actual `GET` responses for all six dynamic card families (every `/api/og/page/:slug`) return decodable `image/png` data. `HEAD` and mocked handler tests do not prove rendering health.

The shared frame inlines the Pharos brand mark as SVG paths (`worker/src/lib/og-templates/shared.tsx`) because satori cannot fetch a same-origin asset. It is the **on-light** variant — the same art as `public/pharos-mark-on-light.svg` — because the card background is light. Keep the two in sync by hand when the mark changes; a mark swap needs a **Worker deploy** and invalidates the 15-minute OG cache.

## CI guardrails

- `npm run seo:check` (`scripts/ci/check-seo-static.mjs`) inspects the built `out/` for OG metadata. As part of T2, this check also asserts that every same-origin `og:image` / `twitter:image` URL — root-relative, or absolute on `pharos.watch` — resolves to a file in `out/`; cards on other hosts (the `api.pharos.watch` dynamic routes) are skipped. This catches broken references like the historical `/og-default.png` regression.
- `seo:check` runs in the classifier-selected PR `pages-artifact` lane through `npm run check:pages-artifact` → `npm run check:pages-release`. It also runs post-merge in `.github/workflows/pages-release.yml` and locally through `npm run check:release`; ordinary local `check:pr` defers the Pages lane to CI unless `--with-pages` is supplied.

## Orphans (intentional)

These files in `public/` are not referenced from `src/` but are kept in case of external/legacy inbound links:

- `og-image.png` — pre-`og-card.png` default fallback.
- `og-card.svg` — predecessor of `og-card.png`. Also **visibly stale** since the 2026-07-31 brand-mark swap: it still carries the drawn lighthouse mark. Left untouched deliberately (it is an orphan); do not treat it as drift.
- `og-pharosville.png` — `/pharosville` promo page no longer exists in app.

Audit and remove if you confirm no external surfaces still point at them.
