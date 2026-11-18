# OG Images

> **Agent navigation** — Start with [Route cards](#1-route-cards), [dated scorecards](#dated-scorecards) and [CI guardrails](#ci-guardrails). The numbered family headings retain legacy image-maintenance anchors.

Canonical links lead with identity, an honest reason to investigate and a relevant visual. Social copy is evergreen. Active stablecoin dossiers share a current rated scorecard with an explicit observation date when one is available. The evergreen dossier image covers unavailable assessments and other lifecycles.

Site/CDN freshness does not expire a preview retained by a social network. A new image URL helps only after that network rereads the HTML; neither a cache purge nor a refresh tool guarantees that existing messages or attachments change.

## 1. Route cards

Canonical page metadata resolves through `getPageSocialPreview()` in `src/lib/page-metadata.ts` and the generated `src/generated/social-preview-images.json` map. A missing public destination is an error, never a silent homepage-image fallback; only non-public chrome deliberately uses the home preview. Social title/description are separate from SEO title/description, so build-time directory counts and search experiments do not become undated social claims.

The `social-preview-images` artifact owns the destination catalog, generated map and the `/og/v2/` PNGs, which are rendered at build time and never tracked. Source registries establish subjects for coin and chain dossiers, named comparisons, taxonomy/peg cohorts, editorial articles, digest editions, events, documentation and tools. Indexability does not determine whether an exported page needs a specific preview.

The lens system shares a 1200×630 canvas, the site's own type (Bricolage Grotesque display, JetBrains Mono labels, Newsreader editorial titles) and one Pharos lockup. `shared/lib/social-card/spec.ts` is the contract between the catalog (`scripts/lib/social-card-catalog.ts`, what each destination says) and the templates (`shared/lib/social-card/`, drawn through `scripts/lib/social-card-render.ts`):

- **Hub:** analytics hubs, tools, cohorts and chains. A headline and one-sentence deck sit beside the lens (hairline rings with frost ticks), which holds a registry-selected logo cluster, a chain orbit, the grade shield, a peg ruler of real closed historical lows, or a line glyph. Every mark encodes a registry field or fixed history; nothing fabricates a price line or a live-looking dashboard.
- **Dossier:** one instrument. The ticker headlines (the name when the ticker is long), a name and launch line follows, and the hook is the coin's AI-summary title after a volatility screen (no figures, currency amounts or now/still/currently/new; otherwise the mechanism headline). At most two chips; the logo sits in the lens. Lifecycle stamps: **HISTORICAL RECORD** for frozen coins (Stablecoin Cemetery epitaph and obituary death date), **LISTING REVIEW** / **DATA HOLD** for delisted and quarantined instruments, **PRE-LAUNCH** / **NOT YET TRACKED** for announced and launched-untracked ones.
- **Versus:** a named pair in two lenses, with tickers and issuer · jurisdiction, or the mechanism where the two differ.
- **Record:** paper editorial for depeg records, case studies, digests, methodology logs and archives, changelog months, docs and blog posts without a cover: a Newsreader title, the date printed once in the dateline, an outcome pill and fixed facts. Depeg records add a peg ruler marking the closed low.

The identity mark sits fully inside the centre square (x285–915) that Telegram's small article preview crops to; text stays at x ≥ 96 and above y 524, clear of X's 2:1 crop and its bottom-left domain overlay; essential text is at least 22 px. Text is fitted with real HarfBuzz metrics that replay Satori's line breaking, and overlong copy fails rather than clipping or dropping words. Drawable text is ASCII, Latin-1, common punctuation and `€`; `₮` renders as `T`, and any other uncovered glyph fails generation. Missing registered logo bytes fail generation; an identity without a registered logo draws a monogram. Raster logos are normalized to PNG (dark marks without a disc of their own get a light plate; historical logos fade to grey), and trusted local SVGs keep their resource-admission checks.

The local Multipli mark (`public/logos/340-rwausdi.png`) is mirrored from the issuer's [official rwaUSDi documentation](https://docs.multipli.fi/rwausd/liquidity-classes-why-segmentation-by-design/rwausdi-the-institutional-credit-layer-for-tokenized-private-markets), replacing an undecodable source asset.

Social copy is explicit per family and never derived from the drawn text: the catalog supplies `og:title` and `og:description` (coin dossiers use `{Name} ({SYM}): {hook}` and the curated one-liner; depeg records reuse the event title and description). Classification labels come from the shared vocabulary.

Evergreen previews omit numeric grades, current prices, market caps, coverage tallies, alarms and methodology pins. Numerical Safety assessments appear on dated scorecards. Picker and portfolio cards never disclose answers, shortlists or holdings. Authored blog covers and the Cemetery scene retain their designs through immutable copies.

The map supplies image URL, alt, MIME type, dimensions and evergreen social copy. Article and hub structured imagery uses the evergreen destination identity. Active dossier Open Graph and Twitter image tags point to the [Worker dossier route](#8-dynamic-worker-cards-apiog) with the map's image hash as the fallback. Static dossier imagery covers frozen, delisted, quarantined and pre-launch assets and yield subpages. Dossier structured data uses its catalog imagery.

Every evergreen image uses `/og/v2/image-<sha256>.png`, independent of route slugs; the generated map remains the destination-to-image authority. A drawn card's hash covers only what reaches its pixels: the drawn spec fields (never path or social copy), the SHA-256 of each render source, font, brand mark and logo it uses, and the `satori` and `@cf-wasm/resvg` versions. It is computed without rasterizing. Equal drawings share one URL; editing a `page.tsx`, catalog code that leaves drawn fields unchanged or an unrelated helper changes no URL, while a drawn-field, render-source or input-byte change renders a new one. Authored covers are re-encoded on admission as palette PNGs (quality 90, effort 10) and named by the SHA-256 of those bytes. Every preview PNG must be a well-formed 1200×630 PNG of at most 500 KB, with a warning above 300 KB. `loadSocialPreviewEntries()` in `scripts/lib/social-preview-build.ts` is the only seam between the catalog/renderer and identity, rendering and storage. Every earlier `/og/v2/` URL, slug-based or hashed, remains valid and permanent.

### Renewal

```bash
npm run build:og-evergreen               # write the map and render missing PNGs into ignored public/og/v2/
npm run build:og-evergreen -- --check    # validate in memory; reads no ignored output, writes nothing
```

Nothing is committed after a source edit: `public/og/v2/` and the map are gitignored. Bootstrap runs `--map-only`, which validates and writes the server-only map without rendering. The post-refresh lifecycle (release build, local `npm run build`, the Pages artifact lane) renders every current image that `public/og/v2/` lacks, after newly acquired digest/event routes arrive, so each deployment carries exactly the current set and `seo:check` sees it. Satori lays each card out with the tracked social-card fonts (`worker/assets/fonts/social-card/`) and outlines every glyph; the Node resvg WASM engine rasterizes it with no system fonts or browser, sequentially. An existing file is reused because its name hashes its inputs; for the same reason the Pages artifact lane does not snapshot the directory, since a replay can only add files.

R2 is the archive: published URLs are permanent identities, not release artifacts with a retention window. Before Pages activation, `scripts/maintenance/publish-social-previews.ts` checks that every map image in the exact `out/` export is a well-formed 1200×630 PNG, lists the `pharos-social-previews` bucket's `evergreen/v2/` prefix once, and uploads only absent objects with create-only `If-None-Match: *` writes carrying `png-sha256` metadata. Any failed create blocks activation; losing a race to the same identity counts as existing. It never overwrites, reads back, re-verifies history or prunes; the owner's indefinite bucket lock guards stored objects.

`functions/og/v2/[[path]].ts` serves the deployment's static bytes first and falls back on a static 404 to the R2 object, which keeps every earlier URL resolving after replacement or rollback. Both sources must be well-formed 1200×630 PNGs; object metadata from any publisher generation is accepted, never required. It never renders a replacement or fetches a live image. `public/_routes.json` keeps `/og/v2/` function-backed while legacy `/og-*.png` remains direct. PNG responses use one-year immutable caching and image-byte SHA-256 ETags for GET/HEAD and conditional requests, and carry no `X-Robots-Tag`, because Article JSON-LD names these images. HTML revalidates independently. Bucket provisioning, binding, lifecycle, lock and trusted publication are [deployment prerequisites](./deployment-process.md#social-preview-storage-prerequisites), not a claim of configured live storage.

## Dated scorecards

Coin dossiers and Safety Scores expose **Share dated scorecard** separately from ordinary Copy link, Copy as image and Download PNG. Copy link shares the canonical URL. Copy as image and Download PNG use the evergreen image, including on active dossiers.

`POST /_site-data/scorecard` accepts only `{ "stablecoinId": "..." }`; `safety-scores` selects the overview. The existing browser-session cookie is scoped to `/_site-data`; when Pages `SITE_SESSION_ENFORCEMENT=enforce`, the creator verifies it locally before quotas or capture. Invalid sessions return `401` with `X-Pharos-Session: required`; missing signing configuration returns `503`. Observe/unset preserves the rollout's observation mode. The Pages handler uses the trusted public Worker OG lane (optional `SITE_API` binding, otherwise public HTTP), never an input-supplied URL or the denied site-data lane. Required `SOCIAL_PREVIEWS` R2, `DB`, the keyed-IP secret and Cloudflare client-IP signal, a bounded JSON body and the allowed-origin signal gate creation. Retained GET/HEAD reads remain public.

`/api/og/v2/scorecard/:id` reads the canonical accepted compact Safety publication and renders the admitted subject. A not-rated coin has no edition: the Worker answers `404` with `X-Scorecard-Reason: not-rated`, the creator passes it on as non-retryable, and the coin page hides **Share dated scorecard** unless its report card is rated. A coin retains its published grade, including legitimate grade hysteresis; the overview separates rated, not-rated and pipeline-unavailable members and reports the rated arithmetic mean without inventing an aggregate letter grade. Missing, held, stale or quarantined evidence cannot become a current assessment. Publication acceptance writes a compact companion row of available pillar scores and grades from the same accepted cards. The Worker reads the requested coin's pillars with the admitted index in one D1 query, matching publication generation, result digest and timestamp. The publisher assigns pillar grades using the dossier's Safety Score grade ladder. A missing pillar score is omitted, and an observed zero is displayed. The Worker re-admits the observation and publication clocks, exact identity, subject with pillars, and publication health after rendering.

The PNG and `X-Pharos-Scorecard` metadata bind the same publication identity, methodology, observation/publication clocks, renderer revision and image SHA-256. The image is drawn by the shared lens templates (`shared/lib/social-card/scorecard.ts`) with the four social-card faces the Worker bundles. A coin card shows its logo, ticker and name beside the lens, which holds the grade in its family colour and the score. The coin card lists available Backing, Exit and Economic control scores and grades. The overview holds the mean rated score in a frost ring and a counts line, never a letter grade. Both carry one outline pill reading **As of {D Mon YYYY}**; the methodology version and clocks travel in the metadata and on the share page, not on the image. The logo is one bounded same-origin read of its registered file (PNG, JPEG or trusted SVG); WebP or any failure draws a monogram. Renderer revision `scorecard-5` adds pillar rows. Retained records and existing compact publications without pillar data remain readable.

The Pages creator validates and seals that evidence into one content-addressed JSON object containing metadata and PNG bytes under `scorecards/v1/` in `SOCIAL_PREVIEWS`, not KV. Conditional create plus strongly consistent R2 readback coordinates concurrent creators; a loser validates the existing winner, and corrupt existing content is never replaced.

`shared/lib/pages-storage.ts` owns durable D1 creation-attempt quotas: **20 per keyed IP and 2,000 globally per UTC day**. Deduplication precedes the quota: after upstream capture, an edition whose content address is already sealed in R2 is validated and returned without a reservation, even when a quota is exhausted. Only a new edition takes the transactional guarded reservation, before storage. Accepted dual reservations stay charged even if storage fails, while capture failures reserve nothing; an IP refusal releases that attempt's global reservation, while global refusal creates no IP counter. Quota exhaustion returns `429` with seconds until next UTC midnight; store/configuration failures fail closed. Indexed, bounded request-path pruning removes old counters without a cron. Additive migration `0304_social_scorecard_daily_quota.sql` must precede the new creator.

The global cap bounds daily new-edition storage attempts, not captures, lifetime storage or read traffic. Distributed clients can still exhaust it and deny new creations; it is not an abuse-proof identity system. Existing retained reads and re-shares of a sealed edition do not consume creation quotas.

- `/share/scorecard/<id>/` serves retained-assessment HTML with self-canonical `og:url`, `noindex, follow`, the dated image and a link to current analysis. Presentation can evolve: HTML uses `public, max-age=0, must-revalidate` and an ETag of the actual rendered HTML body.
- `/share/scorecard/<id>.png` serves the exact retained image with one-year immutable caching and an image-SHA ETag. Both support GET/HEAD `If-None-Match` and bodyless `304`.
- Reads validate record/content/image identity. A missing or corrupt artifact never fetches latest as a substitute.
- Records have no automatic expiry and are independent of public-dataset retention/pruning.
- Public artifacts contain only public assessment data, not holdings, Picker answers, wallets, raw IP addresses or user fingerprints.

The Share menu uses one responsive control/state machine, including the compact desktop coin-header presentation; breakpoint changes do not create competing requests or feedback. Ordinary image actions read the first-party `/og/v2/` image identity from metadata, using the validated evergreen fallback hash on active dossiers. For Safari/WebKit, image copy starts `navigator.clipboard.write()` in the selection gesture with a promise-valued `ClipboardItem`; the abortable fetch resolves afterward. Cancellation and supersession suppress stale feedback. Clipboard failures retain labelled manual-copy URLs or download guidance. `social_share` analytics carry only bounded action/outcome/surface fields, not artifact IDs, coin IDs or URLs.

## 2. Editorial content cards (`public/og-editorial-*.png`)

Canonical metadata uses destination-specific evergreen previews. The existing `public/og-editorial-*.png` files are inert compatibility assets for cached HTML and external previews. Keep the published URLs and PNGs available under the same policy as the retired mechanism and case-study cards below.

## 3. Mechanism explainer cards (`public/og-learn-*.png`)

Current mechanism pages use generated subject-specific evergreen previews. Existing `public/og-learn-<archetype>.png` files remain inert compatibility assets for old HTML and external previews. Their retired generators are not revived; on-page mechanism diagrams remain independently maintained.

## 4. Case-study cards (`public/og-learn-case-*.png`)

Current case-study metadata, Article JSON-LD and hub ItemList entries use each study's generated preview. Existing `public/og-learn-case-<slug>.png` files follow the inert-asset policy above. Article titles, canonicals and authored historical outcomes remain independent of those binaries.

## 5. Stablecoin Cemetery card (`public/og-cemetery.png`)

`scripts/maintenance/build-og-cemetery.ts` owns the real plot-map composition, crop and palette for the 1200×630 scene. The canonical preview map retains its visual through an immutable copy; generic renderer/font machinery belongs to `scripts/lib/scene-og.ts` ([Scene Kit](./data-visualization.md#scene-kit)).

The `og-cemetery` artifact depends on the logo atlas. `scripts/maintenance/state/og-cemetery-signature.json` binds document and published PNG hashes; check mode verifies signature and dimensions without platform-dependent rerender comparison.

```bash
npm run build:og-cemetery
npm run build:og-evergreen
npm run check:generated-artifacts -- --only=og-cemetery,social-preview-images
```

Regenerate after registered scene/data/atlas inputs change; composition changes also bump `OG_CEMETERY_GENERATOR_VERSION`. Do not replace the authored scene with a generic tool card.

## 6. Selector profile cards (`public/og-selector-*.png`)

The Picker uses an evergreen profile-level card. The retained `og-selector-default.png` stays available for old links. [Screener snapshot sharing](./screener-page.md#snapshot-sharing) owns the no-answer/no-shortlist privacy contract; a Picker result never becomes an assessment scorecard.

## 7. Blog cards (`public/og-blog.png`, `public/blog/*-cover.png`)

Posts with an authored `BlogPost.coverImage` preserve that artwork through an immutable social-image copy. Posts without a cover and the blog hub use destination-specific generated cards, not the old category fallback. On-page covers remain authored assets, with their authored alt text; follow [blog publishing](./process/blog-publishing.md).

The old `og-blog.png` remains a compatibility asset. Do not attach unrelated methodology-version badges to new blog previews.

## 8. Dynamic Worker cards (`/api/og/*`)

The Worker uses one renderer for two routes. `/api/og/v2/scorecard/:id` is the trusted creation input for [dated scorecards](#dated-scorecards). `/api/og/v2/dossier/:id?fallback=<hash>` serves the same PNG and metadata for rated active coins. `worker/src/api/og.tsx` routes it to [`og-scorecard.tsx`](../worker/src/api/og-scorecard.tsx), and `worker/src/lib/og-render.ts` owns the request-initialized Satori/HarfBuzz/Yoga/resvg pipeline at 1200×630. A malformed id returns `400` and a non-canonical one `404`, before any read. The PNG's cache ceiling is at most 60 seconds, bounded by both observation and publication runway; an account-level browser-cache floor is independent of it, so acceptance inspects delivered uncached and cached headers. Public methodology labels derive from the served publication's methodology version, never the internal `model: "v9"` compatibility discriminator or a newer repository constant. The overall grade comes from the accepted publication, including any grade hold.

When the dossier scorecard is unavailable, the Worker sends a bodyless `302` with a three-minute cache lifetime. The redirect targets the site's evergreen PNG for the supplied 64-character lowercase hex hash. An absent or invalid hash selects the home image pinned in the legacy table.

The retired numerical families answer `301` to an absolute evergreen image on `https://pharos.watch/og/v2/`, with `Cache-Control: public, max-age=31536000, immutable`. No page selects them, but old shares and lazy re-fetchers still request them. A redirect performs no D1 read and no render.

| Path under `/api/og/` or `/api/og/v2/` | `Location` |
| --- | --- |
| `stablecoin/:id` | the `/stablecoin/<id>/` image |
| `chain/:id` | the `/chains/<id>/` image |
| `depeg`, `safety-scores`, `stability-index` | that page's image |
| `page/:slug` | the image of the page the slug named (`home` is `/`) |
| an unknown id in any of these families | the home image |

`worker/src/api/og-legacy-redirects.json` maps each `family/id` to an image hash. It was generated once from the evergreen map in effect at retirement (`git:dfa0f3cf70:scripts/maintenance/state/social-preview-images.json`). Never regenerate it: its targets are permanent identities that R2 retains, and an id added later never had a legacy URL. Any other `/api/og/*` path returns `404`.

The OG descriptor remains exempt from API keys and denied on site-data, and the Worker edge-cache key keeps the full path, including the subject ID, and drops queries. Only `200` responses enter that cache, so a fallback redirect stays specific to the request. The API smoke probes one redirect and one scorecard render. Satori's workerd-compatible HarfBuzz loader remains `worker/src/lib/og-harfbuzz.ts`. Keep WASM initialization inside request execution, with isolate reuse. A renderer upgrade needs the actual workerd PNG check, not only Node SVG tests.

## CI guardrails

- `npm run seo:check` inspects built HTML and requires referenced same-origin images to exist in `out/`. API-hosted dossier previews must match the page's coin ID and name an evergreen fallback image present in the export. Every page needs a non-empty `og:image` whose first tag starts within the first 32,768 bytes, because Slack reads only the start of a page; decoded HTML above 1 MB, Apple Messages' preview limit, warns. It runs in the classifier-selected Pages artifact/release lane.
- `npm run build:og-evergreen -- --check` validates destination coverage, copy and glyph budgets, logo admission, authored-cover size and the map in memory; bootstrap runs the same validation on every CI job, so PRs need no separate drift check. The post-refresh render gates every rendered PNG's dimensions and size. The Cemetery check verifies its source and PNG signatures without launching Firefox.
- Focused rendering proof: `npx vitest run scripts/__tests__/social-card-render.test.ts scripts/__tests__/social-card-catalog.test.ts scripts/__tests__/social-preview-build.test.ts scripts/__tests__/og-worker-runtime.test.ts`. Real cold/warm workerd scorecard responses must decode as 1200×630 PNGs.
- Review each family at a 520 px feed width, in X's 2:1 crop with its bottom-left overlay and in Telegram's 48 dp centre square. Subject, recognizable identity and reason to open survive without a description; essential dated provenance stays readable beside the assessment, with no clipping, color-only meaning or footer/chart overlap.
- Cover long identities, registered logos, lifecycle variants, fixed historical dates, unknown/NR/quarantined inputs, held/stale sources, observed zero, partial scope and publication changes during rendering. Retained HTML/PNG must stay coherent after source rollover/pruning, and old static hashes must resolve independently of replacement deployments or rollback.
- After deployment, inspect actual new-share presentations on Telegram and other target clients, separately from existing attachments. Meta Sharing Debugger, LinkedIn Post Inspector and Telegram's refresh tooling are operational aids, not a freshness SLA.
- Share-action analytics measure intent and completion, not social impressions or CTR. Evaluate creative variants against observable impressions and qualified visits; technical compliance or an attractive mockup does not prove a click lift.

## Orphans (intentional)

Legacy `og-*.png`, `og-card.svg` and retired mechanism/case-study images remain available for cached HTML/external references, and published `/og/v2/` URLs keep resolving from R2 after they leave the deployment. Do not remove them merely because current source no longer selects them. Any withdrawal requires explicit external-reference/retention review.
