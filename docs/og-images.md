# OG Images

> **Agent navigation** — Start with [Route cards](#1-route-cards), [dated scorecards](#dated-scorecards) and [CI guardrails](#ci-guardrails). The numbered family headings retain legacy image-maintenance anchors.

Canonical links are discovery surfaces, not miniature dashboards. Their image and social copy stay evergreen: identity, an honest reason to investigate, and a relevant visual. Numeric assessments belong to explicitly dated scorecards.

Site/CDN freshness does not expire a preview retained by a social network. A new image URL helps only after that network rereads the HTML; neither a cache purge nor a refresh tool guarantees that existing messages or attachments change.

## 1. Route cards

Canonical page metadata resolves through `getPageSocialPreview()` in `src/lib/page-metadata.ts` and the generated `src/generated/social-preview-images.json` map. A missing public destination is an error, never a silent homepage-image fallback; only non-public chrome deliberately uses the home preview. Social title/description are separate from SEO title/description, so build-time directory counts and search experiments do not become undated social claims.

The `social-preview-images` artifact owns the destination catalog, generated map and immutable `/og/v2/` PNGs. Source registries establish subjects for coin and chain dossiers, named comparisons, taxonomy/peg cohorts, editorial articles, digest editions, events, documentation and tools. Indexability does not determine whether an exported page needs a specific preview.

The three visual grammars share a 1200×630 canvas, substantial ink/navy contrast and compact Pharos branding (`scripts/lib/social-preview-render.ts`):

- **Signal:** a bold monitoring question with frost-blue beams or oversized mechanism art, never a fabricated price line or live-looking dashboard.
- **Dossier / contrast:** recognizable locally registered logo and ticker identity, a due-diligence question and bounded evidence themes. Comparison identities sit apart with a distinct `VS`, not a fused ticker.
- **Briefing:** editorial serif subject hierarchy and document/calendar-led art, with actual edition dates and fixed historical outcomes where appropriate.

Subject, hook, essential evidence and brand remain within the center-square crop (x285–915). Copy wraps within explicit readable budgets; overlong content fails rather than clipping or silently dropping words. Rendered text stays within the tracked fonts' coverage (ASCII, Latin-1 and common punctuation): `₮` renders as `T`, and any other uncovered glyph fails generation instead of drawing a missing-glyph box. Logos are clipped to the same circle the site uses. Art and copy adapt to the subject instead of reserving empty diagram bands. Missing registered logo bytes fail generation; an identity without a registered logo uses a two-character monogram beside its full ticker. Admitted raster logos are normalized to PNG before SVG embedding so WebP/JPEG decoding cannot silently remove an identity; the original file SHA-256 remains part of the semantic SVG identity. Trusted local SVGs retain their resource-admission checks.

The local Multipli mark (`public/logos/340-rwausdi.png`) is mirrored from the issuer's [official rwaUSDi documentation](https://docs.multipli.fi/rwausd/liquidity-classes-why-segmentation-by-design/rwausdi-the-institutional-credit-layer-for-tokenized-private-markets), replacing an undecodable source asset.

Lifecycle copy comes from `scripts/lib/social-preview-catalog.ts`: frozen dossiers say historical/legacy with a freeze date; delisted instruments explain the out-of-scope listing decision; quarantined instruments name the listing review/data hold; pre-launch instruments name plans and missing evidence, not active monitoring. Classification labels come from the shared vocabulary.

Ordinary previews contain no numeric grade, current price, market cap, coverage tally, alarm or irrelevant methodology pin. Picker and portfolio cards never disclose answers, shortlists or holdings. Authored blog covers and the Cemetery scene retain their designs through immutable copies.

The map supplies image URL, alt, MIME type, dimensions and evergreen social copy. Metadata and article/hub structured imagery use the same destination identity. There is no route-local image override convention.

Every new image uses `/og/v2/image-<semanticHash>.png`, independent of route slugs; the generated map remains the destination-to-image authority. Rendered identities hash the full semantic specification, stamped source fingerprint and toolchain identity; authored copies use the complete original PNG SHA-256. Retained slug-based URLs remain valid and permanent. The manifest's `sources[path]` values use explicit `sha256:<64 lowercase hex digits>` digests of the exact source bytes; PNG source stamps, semantic hashes and image-byte hashes retain their full raw SHA-256 values.

### Renewal

```bash
npm run build:og-evergreen
npm run check:generated-artifacts -- --only=social-preview-images
```

Generation also belongs to the post-refresh lifecycle: newly acquired digest/event routes must receive previews before the export is built. Evergreen rendering uses the existing Node resvg WASM engine with tracked fonts and no system-font fallback or browser installation; candidate code can therefore render newly replayed subjects offline. Replay restoration snapshots the entire `public/og/v2/` directory, restoring original membership and removing replay-created files even after failure.

Published hashes are permanent identities, not release artifacts with a finite retention window. Before Pages activation, `scripts/maintenance/publish-social-previews.ts` verifies the map/manifest, every current and retained PNG, embedded source identity, exact `out/` versus `public/` bytes and absence of unregistered files. It conditionally creates objects in the dedicated `pharos-social-previews` R2 bucket under `evergreen/v2/`, then verifies bytes and metadata by readback; collisions fail, never overwrite or rebaseline. Never prune an old identity because it left the current map.

`functions/og/v2/[[path]].ts` serves verified current static bytes first and falls back on static 404 to the same permanent R2 object. It never renders a replacement or fetches a live image. `public/_routes.json` keeps `/og/v2/` function-backed while legacy `/og-*.png` remains direct. PNG responses use one-year immutable caching and image-byte SHA-256 ETags for GET/HEAD and conditional requests. HTML revalidates independently. Bucket provisioning, binding, lifecycle and trusted publication are [deployment prerequisites](./deployment-process.md#social-preview-storage-prerequisites), not a claim of configured live storage.

## Dated scorecards

Coin dossiers and Safety Scores expose **Share dated scorecard** separately from ordinary Copy link, Copy as image and Download PNG. Ordinary actions use the canonical page and its evergreen image.

`POST /_site-data/scorecard` accepts only `{ "stablecoinId": "..." }`; `safety-scores` selects the overview. The existing browser-session cookie is scoped to `/_site-data`; when Pages `SITE_SESSION_ENFORCEMENT=enforce`, the creator verifies it locally before quotas or capture. Invalid sessions return `401` with `X-Pharos-Session: required`; missing signing configuration returns `503`. Observe/unset preserves the rollout's observation mode. The Pages handler uses the trusted public Worker OG lane (optional `SITE_API` binding, otherwise public HTTP), never an input-supplied URL or the denied site-data lane. Required `SOCIAL_PREVIEWS` R2, `DB`, the keyed-IP secret and Cloudflare client-IP signal, a bounded JSON body and the allowed-origin signal gate creation. Retained GET/HEAD reads remain public.

`/api/og/v2/scorecard/:id` reads the canonical accepted compact Safety publication and renders the admitted subject. A coin retains its published grade, including legitimate grade hysteresis; the overview separates rated, not-rated and pipeline-unavailable members and reports the rated arithmetic mean without inventing an aggregate letter grade. Missing, held, stale or quarantined evidence cannot become a current assessment. Observation/publication clocks, exact publication identity, subject and health are admitted again after rendering.

The PNG and `X-Pharos-Scorecard` metadata bind the same publication identity, methodology, observation/publication clocks, renderer revision and image SHA-256. `worker/src/lib/og-templates/scorecard.tsx` keeps the subject, grade/score or cohort summary and readable calendar **DATE · NOT LIVE** together inside the center-square safe zone.

The Pages creator validates and seals that evidence into one content-addressed JSON object containing metadata and PNG bytes under `scorecards/v1/` in `SOCIAL_PREVIEWS`, not KV. Conditional create plus strongly consistent R2 readback coordinates concurrent creators; a loser validates the existing winner, and corrupt existing content is never replaced.

`shared/lib/pages-storage.ts` owns durable D1 creation-attempt quotas: **20 per keyed IP and 2,000 globally per UTC day**. Deduplication precedes the quota: after upstream capture, an edition whose content address is already sealed in R2 is validated and returned without a reservation, even when a quota is exhausted. Only a new edition takes the transactional guarded reservation, before storage. Accepted dual reservations stay charged even if storage fails, while capture failures reserve nothing; an IP refusal releases that attempt's global reservation, while global refusal creates no IP counter. Quota exhaustion returns `429` with seconds until next UTC midnight; store/configuration failures fail closed. Indexed, bounded request-path pruning removes old counters without a cron. Additive migration `0304_social_scorecard_daily_quota.sql` must precede the new creator.

The global cap bounds daily new-edition storage attempts, not captures, lifetime storage or read traffic. Distributed clients can still exhaust it and deny new creations; it is not an abuse-proof identity system. Existing retained reads and re-shares of a sealed edition do not consume creation quotas.

- `/share/scorecard/<id>/` serves retained-assessment HTML with self-canonical `og:url`, `noindex, follow`, the dated image and a link to current analysis. Presentation can evolve: HTML uses `public, max-age=0, must-revalidate` and an ETag of the actual rendered HTML body.
- `/share/scorecard/<id>.png` serves the exact retained image with one-year immutable caching and an image-SHA ETag. Both support GET/HEAD `If-None-Match` and bodyless `304`.
- Reads validate record/content/image identity. A missing or corrupt artifact never fetches latest as a substitute.
- Records have no automatic expiry and are independent of public-dataset retention/pruning.
- Public artifacts contain only public assessment data, not holdings, Picker answers, wallets, raw IP addresses or user fingerprints.

The Share menu uses one responsive control/state machine, including the compact desktop coin-header presentation; breakpoint changes do not create competing requests or feedback. Ordinary image actions read the canonical first-party `/og/v2/` metadata identity. For Safari/WebKit, image copy starts `navigator.clipboard.write()` in the selection gesture with a promise-valued `ClipboardItem`; the abortable fetch resolves afterward. Cancellation and supersession suppress stale feedback. Clipboard failures retain labelled manual-copy URLs or download guidance. `social_share` analytics carry only bounded action/outcome/surface fields, not artifact IDs, coin IDs or URLs.

## 2. Editorial content cards (`public/og-editorial-*.png`)

These category cards remain for legacy inbound image URLs; new canonical metadata uses the destination-specific evergreen map instead. `scripts/maintenance/build-og-editorial.mjs` remains their owner.

```bash
npm run build:og-editorial
npm run check:generated-artifacts -- --only=og-editorial
```

The shared `scripts/lib/og-static-runner.mts` hashes semantic SVG, font and renderer inputs and embeds their fingerprint into the actual PNG before publication. Raster tolerance applies only when source identity agrees. A small changed word/version cannot be discarded as encoding drift while a sidecar signature advances. Missing or changed PNG source identity requires regeneration; signatures describe bytes actually promoted.

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

The Worker renders one image family, the trusted creation input for [dated scorecards](#dated-scorecards): `/api/og/v2/scorecard/:id`. `worker/src/api/og.tsx` routes it to [`og-scorecard.tsx`](../worker/src/api/og-scorecard.tsx), and `worker/src/lib/og-render.ts` owns the request-initialized Satori/HarfBuzz/Yoga/resvg pipeline at 1200×630. A malformed id returns `400` and a non-canonical one `404`, before any read. The PNG's cache ceiling is at most 60 seconds, bounded by both observation and publication runway; an account-level browser-cache floor is independent of it, so acceptance inspects delivered uncached and cached headers. Public methodology labels derive from the served publication's methodology version, never the internal `model: "v9"` compatibility discriminator or a newer repository constant. Safety grades are not recalculated from scores.

The retired numerical families answer `301` to an absolute evergreen image on `https://pharos.watch/og/v2/`, with `Cache-Control: public, max-age=31536000, immutable`. No page selects them, but old shares and lazy re-fetchers still request them. A redirect performs no D1 read and no render.

| Path under `/api/og/` or `/api/og/v2/` | `Location` |
| --- | --- |
| `stablecoin/:id` | the `/stablecoin/<id>/` image |
| `chain/:id` | the `/chains/<id>/` image |
| `depeg`, `safety-scores`, `stability-index` | that page's image |
| `page/:slug` | the image of the page the slug named (`home` is `/`) |
| an unknown id in any of these families | the home image |

`worker/src/api/og-legacy-redirects.json` maps each `family/id` to an image hash. It was generated once from the evergreen map in effect at retirement (`git:dfa0f3cf70:scripts/maintenance/state/social-preview-images.json`). Never regenerate it: its targets are permanent identities that R2 retains, and an id added later never had a legacy URL. Any other `/api/og/*` path returns `404`.

The OG descriptor remains exempt from API keys and denied on site-data, and the edge-cache key drops queries. The API smoke probes one redirect and one scorecard render. Satori's workerd-compatible HarfBuzz loader remains `worker/src/lib/og-harfbuzz.ts`. Keep WASM initialization inside request execution, with isolate reuse. A renderer upgrade needs the actual workerd PNG check, not only Node SVG tests.

## CI guardrails

- `npm run seo:check` inspects built HTML and requires referenced same-origin images to exist in `out/`. It runs in the classifier-selected Pages artifact/release lane.
- The evergreen artifact check validates destination coverage, source/image identities, dimensions, metadata map and immutable publication. Legacy static checks require embedded semantic source provenance as well as their manifests.
- Focused rendering proof: `npx vitest run scripts/__tests__/og-worker-runtime.test.ts worker/src/api/__tests__/og.test.tsx worker/src/api/__tests__/og-source-availability.test.tsx`. Real cold/warm workerd responses must decode as 1200×630 PNGs.
- Review full canvas, 600px, 400px and center-square crops in light/dark surroundings. Subject, recognizable identity and reason to open survive without a description; essential dated provenance stays readable beside the assessment, with no clipping, color-only meaning or footer/chart overlap.
- Cover long identities, registered logos, lifecycle variants, fixed historical dates, unknown/NR/quarantined inputs, held/stale sources, observed zero, partial scope and publication changes during rendering. Retained HTML/PNG must stay coherent after source rollover/pruning, and old static hashes must resolve independently of replacement deployments or rollback.
- After deployment, inspect actual new-share presentations on Telegram and other target clients, separately from existing attachments. Meta Sharing Debugger, LinkedIn Post Inspector and Telegram's refresh tooling are operational aids, not a freshness SLA.
- Share-action analytics measure intent and completion, not social impressions or CTR. Evaluate creative variants against observable impressions and qualified visits; technical compliance or an attractive mockup does not prove a click lift.

## Orphans (intentional)

Legacy `og-*.png`, `og-card.svg`, retired mechanism/case-study images and published `/og/v2/` hashes remain available for cached HTML/external references. Do not remove them merely because current source no longer selects them. Any withdrawal requires explicit external-reference/retention review.
