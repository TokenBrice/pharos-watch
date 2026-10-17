# Safety Score Map

The Safety Score map is a landscape poster of the graded stablecoin universe: every graded coin appears in one of five discrete grade bands, with bubble area tracking circulating supply only above a per-tier minimum and smaller assets shown as fixed-size logo presence markers. Each band is a grade-tinted field with one pattern-redundant outer edge and an in-situ label at top centre (letter, computed score range, census), so the labels read as one A-to-F scale. The chrome sits in the four corners the inscribed ellipse leaves empty: top left, the brand eyebrow with the capture date, the two-line title and the deck `Safer toward the centre`; top right, the computed A-tier share of known supply and its count; bottom left, the exact-width supply-mass bar, per-grade shares and both computed size thresholds; bottom right, the PSI level, band and basis fetched for that render, methodology version, capture time and graded count. A held publication adds a high-contrast `SCORES HELD` pill beside the eyebrow date and its hold start in the provenance corner. Only the PSI marker takes the PSI band colour. It is published at `/safety-scores/map/`, and the image itself is served from KV at `/safety-scores/map.png` on a daily cadence that is deliberately decoupled from Pages deploys.

Grades, scores, and the methodology behind them are owned by [report-cards.md](./report-cards.md). This document owns the map as a *surface*: its two editions, its publication path, its serving contract, and its operational levers.

## Why the Image Is Not a Static Asset

A daily-changing binary cannot ride the site-deploy cadence, because the daily digest cron runs *before* the daily Pages rebuild. Committing the PNG would also add a large binary to git history every day. So the poster is rendered on a GitHub Actions runner, published to the KV namespace already bound to the Pages project, and served by a Pages Function.

The render must happen on a runner: Playwright/Firefox and `sharp` are not Worker-compatible.

## Editions

One generator, one composition, two editions selected by `--edition`.

| | `--edition=daily` (default) | `--edition=monthly` |
| --- | --- | --- |
| Purpose | Living reference, always current | The campaign artifact a human posts |
| Trigger | Unattended, by the refresh workflow | Deliberate, by an operator |
| Date treatment | Capture date in the eyebrow, time in the provenance corner | Month and issue in the eyebrow, full timestamp in the provenance corner |
| Default basename | `safety-score-map-latest` | `safety-score-map-<YYYY-MM>` |
| Published to | KV, and therefore the live route | Not published by any automation |

The monthly edition is never inferred from the data clock. Archive and output naming use the **UTC run date**; visible date provenance uses the report-card capture clock (`asOfSec`). Without that split, a run on the first of a month over the previous month's data would file itself under the wrong month and collide with the existing monthly archive.

`--issue <n>` supplies the monthly issue number; it is a positive integer and applies to the monthly lockup only.

## Generator

`scripts/maintenance/build-safety-score-map.ts`, run through `npm run build:safety-score-map` (daily) or `npm run build:safety-score-map:monthly`.

Data comes from the keyed maintenance API — the V9 report cards, stablecoin list, and current Stability Index response — so `PHAROS_API_KEY` is required (env or `.env.local`), with `PHAROS_API_BASE` as an optional origin override. Supply is read through `getCirculatingRawOrNull()` and treated as already USD-denominated. Missing/empty supply retains null and an unavailable reason; observed zero remains an observed join. Tier totals and the mass rail are labelled known-supply subtotals/shares, never complete graded-cohort supply. `mapSummary.supplyCoverage` records completeness, observed/unavailable counts, per-asset reasons and `shareBasis = "known-mapped-supply"`. The PSI footer follows the Stability Index page's display rule: rolling 24-hour level/band labelled `24H AVG` when available, otherwise the raw current sample labelled `RAW`. A missing, malformed, future-dated, or stale PSI reading fails the render.

Beside the PNG, sharing its basename, the run writes `.svg` and `.html` (the rendered scene and its screenshot host), `.alt.json` (alt text plus the per-tier table), and `.manifest.json` (publication provenance, render counts, and the public `mapSummary`). The map keeps no historical score snapshot because comparing score movements is outside the renderer's responsibility.

Every figure on the poster is computed from the fetched data. No headline number is a literal — under an unattended daily cadence a hardcoded figure becomes a published falsehood within days.

Bubble area tracks circulating supply above a per-tier minimum marker. The generator derives and discloses both thresholds after fitting — one for A and one for B-F — on every render; smaller assets share a fixed-size presence marker rather than a fake proportional bubble. Every mark is one badge: dark disc, grade-colour ring, a hair of dark gap, then the circle-clipped, `sharp`-transcoded PNG logo (or a high-contrast initial). Plates follow the raster's alpha and luminance: full-bleed tiles and mostly dark-ink marks get a light plate; other marks sit on the dark disc. Marker floors are 12.6px (A) and 9px (B-F). Only when a census outgrows the 9px floor, after every guide split, does the fitter step down to the previous 7.8125px floor, logging a warning; the disclosed threshold follows the floor in use, and it never goes lower.

The A core is sized to what it holds. The two largest A coins form a near-tangent hero pair, separated by `BUBBLE_GAP`, whose area-weighted centroid is the map centre. A coins of radius 30px or more carry a name chip (symbol, score) below them, and the A label tops the pair. Other A coins walk out from the pair on fixed bearings, alternating sides in supply order, until clear; the core is the smallest fixed-aspect ellipse holding it all, and B begins just outside. The B-F stack is then allocated toward the bounded outer ellipse (724x396 around 800,450). Each guide's short-axis thickness must hold its census footprint, its runner-up mark and a semantic minimum. Each guide's largest mark is anchored on a long-axis vertex (B and D right, C and F left), where bands are proportionally thicker, so supply giants in different bands never stack on the short axis. B takes the smallest leftover share that closes every guide; C receives the rest.

The fitter starts with one guide per grade. When a grade's guide runs out of circumference, that grade alone gains a concentric guide (up to five), kept as the search continues; only when no split helps do large bubbles shrink, and only when every scale fails does the floor step down. This keeps capacity monotonic. Supply-sorted entries are dealt round-robin across guides without loss or duplication, with demand-weighted thickness; inner guides are layout, not score boundaries, so only a grade's outer edge is drawn. A grade's first guide is packed with two anchors, its leader on the vertex and its label at exact top centre, inserted where both arcs share near-equal slack; label pairs are charged straight extent because the guide is flattest there. The allocator reserves the same label and tag entries under the same arc bound, and thickens a labelled guide so the pill's corners clear its curvature. A leader drawn above the floor carries a name tag (a hero chip from 30px) reserving its extent projected on the guide's tangent; it hangs just below the leader, else above, nudged at most 24px. Published plus/base/minus modifiers select bounded radial lanes, never continuous score-to-radius placement; lanes displace marks along their own angle, so anchors and slack survive, and shrink to zero when needed. The packer budgets curvature correction per neighbouring pair, and guide closure keeps a 1px margin for the packer's sampled perimeter. Every guide is checked for empty arcs, bounds and clearance, and all bubbles for overlap across guides and grades.

If no readable layout fits the bounded field, the renderer throws `SafetyMapCapacityError` with machine-readable code `layout-capacity-exhausted` and names the limiting geometry in its diagnostic. It never drops entries or bypasses composition guards. The regression fixture captures all 367 graded entries from read-only canonical API GETs on 2026-10-08, with per-grade populations A/B/C/D/F of 4/25/148/104/86. Tests also cover at least 25% and 50% growth in every grade at the readable floor, 80% growth at the fallback floor, one grade's growth never moving the floor, supply leaders redistributed across outer grades, and genuine capacity exhaustion. The segmented supply-mass rail uses `tier supply / total mapped supply * track width` exactly, with no minimum visible segment width; separators are drawn over the joins rather than taken out of segments.

In-map labels are slots with exact geometry, sized by deterministic estimates; Firefox measures the real glyphs and fails the render if text escapes a pill.

### Guards

The generator exits non-zero rather than publishing something wrong. All of these are unconditional:

- **Canonical inputs.** Report cards must satisfy the canonical API schema. Their publication status and capture time are preserved as provenance but do not gate rendering: a valid held or aged Safety Score publication still renders. The PSI sample must remain future-free and within the shared Stability Index endpoint freshness budget because the poster presents it as current context.
- **Input hygiene.** The canonical API schema enforces unique card IDs, finite in-range scores, grade vocabulary and score/grade agreement before map projection. Pipeline-gap cards are excluded from grade bands. Negative finite supply buckets fail closed before the supply join.
- **Join coverage.** At least 95% of graded cards must join an admitted observed supply (including explicit zero). Unavailable entries retain fixed presence markers and are excluded only from known-supply sums/shares. Count coverage does not bound the missing dollar amount and never certifies complete-cohort value.
- **Grade vocabulary.** An unrecognized grade letter fails; a silently dropped tier is worse than no map.
- **Finite geometry.** A non-finite bubble scale or radius fails, as does an empty graded set.
- **Composition and annotations.** The corner blocks join the annotation scene as reserved regions (headline, supply key, provenance) or obstacles (the stepped title), each inflated toward the map; with that clearance every block lies wholly outside the outer ellipse bounding every mark, so no census can crowd the corner type. In-map slots are obstacles too: nothing may touch a label. The planner treats the headline, supply key and provenance as required and fails the render if any cannot be placed. The composition linter rejects an outer band with a bare arc: a run of circumference no mark or label slot occupies, wide enough for the band's median mark and over three times its mean unoccupied run. It measures emptiness between mark edges along true ellipse arc length, not angle between centres, because one dominant asset legitimately spans a wide angle while leaving no space beside it. Firefox `getBBox()` measurements of the corner groups, title lockup and every in-map label are revalidated before the screenshot.
- **Edge clearance.** Every planet edge must stay at least 14px inside the top and bottom canvas edges, or the render fails.
- **Fonts.** Each family is checked explicitly; `document.fonts.ready` resolves even when a face fails, and fallback metrics visibly change the publication typography.
- **Raster size.** The screenshot must come back at exactly 3200x1800 (1600x900 at `deviceScaleFactor: 2`).

There is deliberately no day-over-day score, grade, tier, leader, census, supply-movement, or missing-logo comparison. The Safety Score publication pipeline and its history own movement validation; the map's single responsibility is to render the canonical publication it receives. This prevents legitimate scoring or methodology changes from blocking the presentation surface.

## Publication

`.github/workflows/safety-map-refresh.yml` owns checkout, credentials, scheduling, and artifact upload in one main-only job. Its Node-only setup inspects live KV in the `plan` phase, emitting `should_render` and a plan token; only when needed does a second setup install Firefox and bootstrap render inputs in the same workspace. No plan-state artifact transfer or second dependency install is needed. `scripts/maintenance/publish-safety-score-map.ts` owns explicit `plan`, `render`, `publish`, and `summary` phases. The token binds render/publish to the saved local plan state; it is not a publish-time live-KV compare-and-swap. One guarded summary covers both no-op and render/publish outcomes after a successful plan.

The workflow reads the live manifest only in the plan-before-browser phase. The plan runs in one of two modes: `ensure` (every `schedule` run and the Worker's pre-digest dispatch) exits early, rendering and writing nothing, whenever the live manifest already carries today's date, whatever that map's data age; `force` (the default for a manual `workflow_dispatch`) always renders, so an operator can supersede a bad same-day poster. `ensure` never re-renders a live same-day date because its dated PNG is the URL the digest has already embedded and CDNs cache as `immutable`. When needed, the conditional render phase installs Playwright/Firefox, renders the daily edition, builds the compact KV manifest from the renderer's manifest sidecar, and publishes. Key order is load-bearing:

| Key | Contents |
| --- | --- |
| `safety-map:alt:latest` | Alt text and the per-tier table |
| `safety-map:YYYY-MM-DD.png` | Dated image — the URL the digest embeds |
| `safety-map:latest.png` | Same bytes, stable URL for the site |
| `safety-map:latest.json` | Manifest — **written last, the commit marker** |

Manifest-last prevents a new manifest from advertising before its image writes and dated-PNG hash readback complete. A failed readback leaves the stable latest image untouched, but KV keys are not atomic: a same-day `force` can overwrite the dated image while the prior manifest still references it. The backwards-time guard compares against the manifest saved during planning, not a fresh live read; workflow concurrency serializes this workflow's runs.

Keys live under the single-purpose `safety-map:` prefix inside the existing `SELECTOR_SNAPSHOTS` namespace — the same namespace `functions/selector-snapshot/[[path]].ts` uses. Reusing it changes account state not at all, so the weekly Cloudflare account-state drift check needs no manifest update. (R2 was rejected for this reason among others: that check normalizes `d1` and `kv_namespace` bindings only, so an R2 bucket would be unmonitored surface.)

Failure surfaces as a red run and a GitHub notification. Independently, the digest watchdog checks `/safety-scores/map.json` from 07:15 UTC and raises advisory `map-producer-lag` when the manifest is not today's. On the 15-minute status lane its first check lands at 07:24, leaving about 40 minutes before the 08:05 digest. This advisory neither consumes the digest publication alert cooldown nor degrades the sentinel run; digest publication stays unblocked.

### Pre-Digest Producer Kick

GitHub starts scheduled workflow runs hours late: in September 2026 the earliest of the three daily slots was created five to six and a half hours after its cron time, and other scheduled workflows in the repository lagged by up to eight and a half hours. Scheduled slots alone therefore missed the 08:05 UTC digest on 2026-09-27 and 2026-09-29. `workflow_dispatch` events are not subject to that scheduler queue, so the Worker owns the pre-digest trigger.

`worker/src/cron/safety-map-producer-kick.ts` runs as the budget-only `safety-map-producer-kick` surface on the five-minute digest trigger poll. Between 06:20 and 08:00 UTC it reads the manifest date; only a manifest dated today suppresses action, so an unreadable manifest is treated as missing rather than as published. Otherwise it dispatches `safety-map-refresh.yml` on `main` in `ensure` mode through the GitHub REST API with the Worker's `GITHUB_PAT`, at most three times per UTC day and at least 15 minutes apart. Each attempt is claimed in the D1 `cache` key `safety-map:producer-kick:v1` before the request is sent, so a lost response costs one bounded attempt and never loops. A render takes about three minutes, so the three attempts (normally 06:20, 06:35, 06:50) finish well before the digest. Outside the window the surface makes no reads and records nothing; its status telemetry therefore uses a one-day interval.

During its window the surface reports `current`, `dispatched`, `awaiting-render` (spacing has not elapsed), `dispatch-failed`, `attempts-exhausted`, or `token-missing`; the last three are `degraded`. Outside the window it returns `outside-window` with no recorded outcome. A persistent render failure consumes all three attempts and is then left to operator alerts: retrying a deterministic generator guard cannot fix it.

### Provisioning

`vars.SAFETY_MAP_KV_NAMESPACE_ID` and `secrets.SAFETY_MAP_KV_TOKEN` are provisioned. The token is scoped to *Workers KV Storage: Edit* on that one namespace and is deliberately **not** `CLOUDFLARE_API_TOKEN`, the broad account token that deploys production Pages. Scoping this writer to one namespace keeps an unattended browser job away from the deploy token, even though some other scheduled workflows (for example `curation-expiry-sweep.yml`) still consume that account token outside `production` environment protection.

The Worker kick reuses the Worker secret `GITHUB_PAT` that the feedback issue bridge already requires. A classic token needs `repo` scope; a fine-grained token needs *Actions: Read and write* on this repository in addition to the feedback bridge's *Issues* access. A token without Actions write access surfaces as `dispatch-failed` with `dispatch-http-403` on the kick surface.

The workflow keeps three daily schedules, 01:20, 03:20, and 05:20 UTC, as a no-cost fallback behind the Worker kick: `schedule` runs plan in `ensure` mode and exit early once today's map is live. It also supports `workflow_dispatch` with a `mode` input (`force` by default for operators, `ensure` for the Worker).

## Serving

`functions/safety-scores/map.png.ts` serves `/safety-scores/map.png` from KV. `GET` and `HEAD` only; HEAD answers exactly as GET does minus the body, because several social platforms probe an image URL with HEAD before fetching it.

`functions/safety-scores/map.json.ts` serves the manifest commit marker at `/safety-scores/map.json` with `no-store`. The daily digest reads this bounded endpoint to validate publication date and data freshness without adding the Pages KV namespace to the API Worker. A same-day manifest is current; when publication is late, the newest manifest up to two whole UTC days old may be carried forward. Missing, malformed, unreachable, or older state makes the map attachment unavailable, but never withholds the digest itself (see the bounded carry-forward pairing below).

`?date=YYYY-MM-DD` selects the dated archive, validated against a strict pattern; anything else is a 400. The Function never lists the namespace and never accepts a caller-supplied key fragment beyond the date. The archive lives on a query parameter rather than a nested path segment so it cannot shadow the static `/safety-scores/map/` page; Cloudflare includes the query string in the default cache key, so the two remain distinct cache entries.

Cache headers differ by resource: `latest.png` gets a short edge TTL with a long `stale-while-revalidate` grace window; dated URLs are served as `immutable`, although a same-day `force` rerender can overwrite their KV bytes without changing the URL.

**A missing binding or a missing object is a 404 with `no-store`, not a 500.** This diverges from the `selector-snapshot` precedent, which treats an absent binding as a misconfiguration, and the divergence is deliberate: it is what makes the kill switch work. A KV read that throws is a 503, which is a different condition and must not be confused with the kill switch.

The page at `src/app/safety-scores/map/page.tsx` embeds the image with a download link and prose on how to read it. `src/app/safety-scores/map/poster.tsx` swaps in an explanatory panel on image error, so both the local-development state (no Pages Function exists under `next dev`) and the post-kill-switch state read as deliberate rather than broken.

## Digest Map Pairing (Bounded Carry-Forward)

The digest attaches a map when all four hold:

1. `safety-map:latest.json` exists,
2. `manifest.date` is the requested UTC date or no more than two whole UTC days older,
3. `manifest.asOfSec` is future-free and under 72 hours old, and
4. a HEAD probe confirms that the dated PNG for `manifest.date` exists and is served as `image/png`.

It embeds the **dated** URL built from `manifest.date`, never `latest.png`. A new date gives Telegram and X a new URL; a same-day `force` retains the URL and cannot guarantee replacement of cached images. A carried-forward attachment and its channel captions name the date the poster actually depicts; only a current attachment is described as today's map.

When available, X downloads the PNG, uploads it through the OAuth 1.0a media endpoint, and references the returned media id on the digest post. Telegram stores the canonical dated URL and the depicted date inside the immutable outbox payload and sends the poster as a real `sendPhoto` message, captioned `Safety Score map · <date>`, immediately before the text chunks. A dedicated `media_state` column (`none` / `pending` / `sent`) advances only on an accepted photo send, so the media step joins the accepted-chunk cursor contract: a retryable photo failure never advances the chunk cursor, and a text retry never resends an accepted photo.

If any condition fails, the digest still generates and delivers without the map attachment or map prose; map unavailability is not a digest precondition. The resolver reports the bounded reason (`manifest-http-<status>`, `manifest-invalid-json`, `manifest-invalid`, `manifest-too-old`, `manifest-data-stale`, `image-http-<status>`, `image-content-type`, or `read-failed:<detail>`) for observability, while a valid carried-forward manifest keeps the dated attachment available. An X media-upload failure after the pairing check remains a channel-local retryable definitive failure; it does not withhold the digest or the other channel.

## Kill Switch

Three levers, in increasing order of what has already escaped:

1. **Stop generating.** `gh workflow disable safety-map-refresh.yml`. Previously published keys stay live and served. A disabled workflow also refuses the Worker's pre-digest dispatches; the kick surface then reports `dispatch-failed` until its daily attempt budget is spent.
2. **Stop serving the image.** Delete `safety-map:latest.png` and today's dated key plus any dated keys still eligible for the two-day carry-forward window, then run `.github/workflows/purge-pages-zone-cache.yml`. The Function then returns 404 with `no-store` and the page renders its unavailable panel. No Pages release is required.

   The purge is not optional. `latest.png` is served with `s-maxage=300, stale-while-revalidate=86400`, so a deleted key can keep being served from the edge for up to a day. Dated keys are `immutable` and will not re-validate at all until purged.

   Deleting `safety-map:latest.json` is a **different** lever with a different scope: the Function never reads the manifest, so the image keeps serving. What the manifest controls is whether the digest carries a map (see above); deleting it removes the map attachment but does **not** hold the digest. Delete the manifest to pull the map from social channels; delete the PNG keys to stop it appearing on the site. To stop both, delete all three.
3. **A bad image is already live and scraped.** Re-render, overwrite the keys, and run `.github/workflows/purge-pages-zone-cache.yml`. This purges Pages, not social CDNs. A same-day `force` keeps the dated URL and may remain stale there; only a new date gives the next post a new URL.

## Related

- [report-cards.md](./report-cards.md) — the grades and scores the map draws
- [digest-pipeline.md](./digest-pipeline.md) — the intended consumer of the manifest
- [scripts.md](./scripts.md) — the generator's row in the script inventory
- [og-images.md](./og-images.md) — the other rendered-image pipeline, which is deploy-coupled by contrast
