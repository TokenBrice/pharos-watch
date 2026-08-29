# Safety Score Map

The Safety Score map is a landscape poster of the graded stablecoin universe: every graded coin appears in one of five discrete grade bands, with bubble area tracking circulating supply only above a per-tier minimum and smaller assets shown as fixed-size logo presence markers. The A-grade core is line-free; B, C, D, and F use quiet grade-colored, pattern-redundant band guides with no data-point path. The single-line footer records the PSI level, corresponding condition band, and calculation basis fetched for that render alongside the size encoding, capture time, methodology version, and graded count. A small marker uses the canonical PSI band colour while the text stays neutral and legible across every band; the frost-blue brand treatment and Safety Score grade palette do not change with PSI. A compact key in the header gives every letter, computed score range, guide pattern and the direction cue `inner -> safer`, followed by one computed A-tier count/share signal and an exact-width segmented supply-mass bar. Both computed size floors are disclosed in the footer instead of repeated in the key. It is published at `/safety-scores/map/`, and the image itself is served from KV at `/safety-scores/map.png` on a daily cadence that is deliberately decoupled from Pages deploys.

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
| Date treatment | Once in the footer | Issue lockup in the masthead plus footer provenance (the month reaches the archive name and alt text, not the poster) |
| Default basename | `safety-score-map-latest` | `safety-score-map-<YYYY-MM>` |
| Movers window | Since the previous snapshot | Month-boundary snapshots |
| Published to | KV, and therefore the live route | Not published by any automation |

The monthly edition is never inferred from the data clock. Archive and output naming use the **UTC run date**; visible date provenance uses the report-card capture clock (`asOfSec`). Without that split, a run on the first of a month over the previous month's data would file itself under the wrong month and collide with the existing monthly archive. The Movers window names the snapshot comparison baseline; that comparison currently feeds the delta guard and is not yet rendered on the poster.

`--issue <n>` supplies the monthly issue number; it is a positive integer and applies to the monthly lockup only.

## Generator

`scripts/maintenance/build-safety-score-map.ts`, run through `npm run build:safety-score-map` (daily) or `npm run build:safety-score-map:monthly`.

Data comes from the keyed maintenance API — the V9 report cards, stablecoin list, and current Stability Index response — so `PHAROS_API_KEY` is required (env or `.env.local`), with `PHAROS_API_BASE` as an optional origin override. Supply is read through `getCirculatingRaw()` and treated as already USD-denominated. The PSI footer follows the same display rule as the Stability Index page: the rolling 24-hour level and band when both are available, labeled `24H AVG`; otherwise the raw current sample is labeled `RAW`. A missing, malformed, future-dated, or stale PSI reading fails the render instead of publishing an old regime.

Beside the PNG, sharing its basename, the run writes `.svg` and `.html` (the rendered scene and its screenshot host), `.alt.json` (alt text plus the per-tier table), `.snapshot.json` (per-coin `{id, symbol, score, grade, mcap}` under a header of `{edition, date, publicationStatus, asOfSec, renderedAtSec, methodologyVersion, counts, mapSummary}`), and `.manifest.json`. The snapshot is both the movers baseline and the next run's delta-guard input.

Every figure on the poster is computed from the fetched data. No headline number is a literal — under an unattended daily cadence a hardcoded figure becomes a published falsehood within days.

Bubble area tracks circulating supply above a per-tier minimum marker. The generator derives and discloses both thresholds after fitting — one for A and one for B-F — at readable size on every render. Assets below those thresholds share a fixed-size logo presence marker rather than a fake proportional bubble; every asset retains its circle-clipped, `sharp`-transcoded PNG logo, with a high-contrast initial used only when no logo asset exists. Logo plates are selected deterministically from that raster's alpha and luminance: recognizable transparent marks sit as bare silhouettes on the field without a redundant grade rim, predominantly light marks receive a dark plate, and opaque full-bleed tiles retain a light plate behind their own background. Floor-sized marks retain the grade rim because the logo alone is too small to carry the tier signal. Larger assets retain proportional sizing, and the floor is fail-closed: large bubbles may shrink during fitting, but the renderer will not silently reduce either minimum logo size.

The line-free A core is deliberately compact, and B begins immediately outside it so the two read as a dense centre. Outer-band thickness is recomputed for each render from the required bubble footprint plus a fixed semantic minimum, then the B-F stack is allocated sequentially toward the bounded map edge. C receives any remaining radial thickness because its census and modifier lanes carry the greatest placement demand; D and F remain distinct outer tiers. Within B-F, the published grade modifier selects one of three materially separated bounded radial lanes: plus inward, unmodified on the guide, and minus outward. This is discrete label placement, never continuous score-to-radius placement; A keeps its line-free core, and a tier with only unmodified grades collapses to its guide. Every lane retains its full distributed angular slack and therefore completes the ellipse. When separated lanes collide, their offset shrinks through a deterministic fixed-step search; if zero separation is required, the band collapses onto its single evenly packed guide before the whole-layout fitting retries. The compact header does not reserve body space, so the orbital field uses the reclaimed vertical canvas. If the demand cannot retain the minimum thickness, inter-band gap, bubble clearance, and fixed floor together, fitting fails rather than compressing a grade boundary. The segmented supply-mass rail uses `tier supply / total mapped supply * track width` exactly, with no minimum visible segment width; its single printed count/share calls out the dominant A-tier supply concentration.

The two largest A-tier circles form one tangent hero pair whose area-weighted visual centroid is fixed to the map centre; this keeps unequal USDT/USDC-sized leaders from making the core read off-axis. The orbital field starts below a protected 12px gutter after the header separator. The centre is biased slightly downward so that extra top clearance does not unnecessarily consume the footer-side plotting space.

### Guards

The generator exits non-zero rather than publishing something wrong. All of these are unconditional:

- **Freshness and publication status.** The report-card capture must be future-free and under 48 hours old (the exact 48-hour boundary fails), and the API must label it `current`. The PSI sample must also be future-free and stay within the shared Stability Index endpoint freshness budget. A stalled or held producer must fail the job, not publish old scores or an old PSI regime under today's date.
- **Input hygiene.** The response must have unique card IDs, finite scores in range, exact grade vocabulary, and score/grade agreement. Negative finite supply buckets fail closed before the supply join.
- **Join coverage.** At least 95% of graded cards must join a list row with real supply, or the map is drawing legibility floors instead of data.
- **Grade vocabulary.** An unrecognized grade letter fails; a silently dropped tier is worse than no map.
- **Finite geometry.** A non-finite bubble scale or radius fails, as does an empty graded set.
- **Composition and annotations.** The header chart-key panel, masthead lockup and publication footer participate in the annotation scene without claiming body space. The annotation planner treats the grade key, supply-mass rail and combined footer disclosure/provenance run as required, rejects collisions between the header lockup and annotations or between annotations, and fails the render if any cannot be placed. The unconditional composition linter also rejects an outer band that leaves a bare arc: a run of circumference no mark occupies, wide enough to hold that band's median mark and more than three times the band's mean unoccupied run. It measures the emptiness between mark edges along true ellipse arc length, not the angle between mark centres, because bubble area encodes supply: one dominant asset legitimately spans a wide angle while leaving no space beside it. Firefox `getBBox()` measurements of the final SVG groups are revalidated before the screenshot.
- **Header clearance.** Every planet edge must remain below the protected 12px gutter beneath the header rule; the render fails if a future layout crosses it.
- **Fonts.** Each family is checked explicitly; `document.fonts.ready` resolves even when a face fails, and fallback metrics visibly change the publication typography.
- **Raster size.** The screenshot must come back at exactly 3200x1800 (1600x900 at `deviceScaleFactor: 2`).

One guard is skippable: the **day-over-day delta guard**, armed by `--previous-snapshot <path>`. It fails the run when the graded count falls more than 2% or the not-rated count moves more than 5 against the prior snapshot, and also checks per-tier counts, per-coin grade transitions, tier and leader supply, join identity, and missing-logo count. A missing path or no supplied baseline skips it with a warning, so a first run can bootstrap; a present but malformed baseline fails closed rather than being treated as absent.

The tier-leader check tolerates an explained swap: a new tier leader passes when it already sat in the prior snapshot's recorded top-3 for that tier and its own supply moved within the same 25% tolerance. Near-tied neighbours trade the top spot on ordinary market movement (2026-08-29: a ~0.6% BUIDL/USYC gap in tier C flipped, failed both scheduled runs, and shipped the digest without the map), and a failed run never advances the snapshot baseline, so a hard identity check kept failing against the same stale leader. A leader arriving from outside the recorded top-3, or one whose supply moved more than 25%, still fails closed as a suspected join or scoring fault.

An operator may accept a reviewed methodology or census transition through the manual workflow's `accept_snapshot_transition` input. The publication planner permits that flag only on `workflow_dispatch`, requires the current live snapshot to be readable, and records the acceptance in the run state and summary. The renderer still parses and validates that snapshot against the full current publication contract, then skips only the day-over-day comparisons; freshness, finite geometry, composition, header clearance, font, and raster-size guards remain mandatory. Scheduled runs cannot use this path, and normal tolerances are unchanged.

The join-identity check applies only to coins present in both snapshots, and tolerates immaterial flips: a coin whose joined state changes in either direction (supply crossing zero, or its list row appearing/disappearing) is warned about and published from the current supply state — a coin that lost its join draws at the size floor, one that regained it draws at its real size — rather than failing the run, as long as at most 3 coins flip and their combined supply stays under 0.1% of the previous snapshot's mapped supply. Beyond either bound the run still fails closed. Census additions and removals are deliberately not join flips — they are bounded by the graded-count, tier-count, tier-supply and leader checks instead. The original check counted them, which failed the run the day after any coin entered the census (2026-08-26: `hollar-hydrated` moving NR → graded under methodology 9.44 blocked that day's publication and digest map) — and, because a failed run never advances `safety-map:snapshot:latest`, every later run kept failing against the same stale baseline until the census change was accommodated in code.

## Publication

`.github/workflows/safety-map-refresh.yml` owns checkout, credentials, scheduling, and artifact upload. `scripts/maintenance/publish-safety-score-map.ts` owns the tested operational state machine through explicit `plan`, `render`, `publish`, and `summary` phases. `plan --dry-run` inspects live KV state and prints the same-day decision without rendering or writing KV; it still requires the purpose-scoped KV credentials because a useful plan cannot guess at live state.

The workflow reads `safety-map:snapshot:latest` to arm the delta guard, renders the daily edition, builds a KV manifest from the snapshot header, and publishes. Key order is load-bearing:

| Key | Contents |
| --- | --- |
| `safety-map:snapshot:YYYY-MM-DD` | Dated snapshot, archival |
| `safety-map:snapshot:latest` | Rolling pointer, read by the next run |
| `safety-map:alt:latest` | Alt text and the per-tier table |
| `safety-map:YYYY-MM-DD.png` | Dated image — the URL the digest embeds |
| `safety-map:latest.png` | Same bytes, stable URL for the site |
| `safety-map:latest.json` | Manifest — **written last, the commit marker** |

Because the manifest is written last, a consumer that requires it can never observe a half-published set. The dated PNG is read back and hash-compared immediately after it is written, before the latest PNG is promoted; a verification failure at that point leaves the previous complete image live, while the manifest-last sequence still leaves a tolerated cross-key window in which the image and manifest can describe different editions. A publish that would land behind the live manifest's render time is refused outright.

Keys live under the single-purpose `safety-map:` prefix inside the existing `SELECTOR_SNAPSHOTS` namespace — the same namespace `functions/selector-snapshot/[[path]].ts` uses. Reusing it changes account state not at all, so the weekly Cloudflare account-state drift check needs no manifest update. (R2 was rejected for this reason among others: that check normalizes `d1` and `kv_namespace` bindings only, so an R2 bucket would be unmonitored surface.)

Failure surfaces as a red run and a GitHub notification. It does **not** page anyone: no webhook-alerting path for this job exists in the repository. The reliable human-visible signal is the digest ops line described below.

### Provisioning

`vars.SAFETY_MAP_KV_NAMESPACE_ID` and `secrets.SAFETY_MAP_KV_TOKEN` are provisioned. The token is scoped to *Workers KV Storage: Edit* on that one namespace and is deliberately **not** `CLOUDFLARE_API_TOKEN`, which deploys production Pages and is used only from workflows running under the `production` environment protection that this unattended job does not have.

The workflow runs on two daily schedules, 04:20 and 06:20 UTC, and also supports `workflow_dispatch`. GitHub delays scheduled runs by up to about an hour under load (observed: 47 minutes on 2026-08-24, which made the original single 07:20 slot miss that day's digest; 53 minutes on 2026-08-26), so a single slot leaves exactly one attempt before the 08:05 UTC digest cron. The 04:20 attempt normally publishes; the 06:20 attempt retries after a failed or delayed first run and exits early — rendering and writing nothing — when the live manifest already carries today's date with data fresh enough (`asOfSec` under 6 hours) to clear the digest's own 24-hour staleness gate. Manual dispatches never take that early exit, so an operator can always supersede a bad same-day poster; selecting `accept_snapshot_transition` is reserved for a separately reviewed baseline transition and remains visible in the workflow summary.

## Serving

`functions/safety-scores/map.png.ts` serves `/safety-scores/map.png` from KV. `GET` and `HEAD` only; HEAD answers exactly as GET does minus the body, because several social platforms probe an image URL with HEAD before fetching it.

`functions/safety-scores/map.json.ts` serves the manifest commit marker at `/safety-scores/map.json` with `no-store`. The daily digest reads this bounded endpoint to validate publication date and data freshness without adding the Pages KV namespace to the API Worker. Missing, malformed, or unreachable manifest state fails closed as an omitted attachment.

`?date=YYYY-MM-DD` selects the dated archive, validated against a strict pattern; anything else is a 400. The Function never lists the namespace and never accepts a caller-supplied key fragment beyond the date. The archive lives on a query parameter rather than a nested path segment so it cannot shadow the static `/safety-scores/map/` page; Cloudflare includes the query string in the default cache key, so the two remain distinct cache entries.

Cache headers differ by resource: `latest.png` gets a short edge TTL with a long `stale-while-revalidate` grace window, while dated keys are write-once and therefore `immutable`.

**A missing binding or a missing object is a 404 with `no-store`, not a 500.** This diverges from the `selector-snapshot` precedent, which treats an absent binding as a misconfiguration, and the divergence is deliberate: it is what makes the kill switch work. A KV read that throws is a 503, which is a different condition and must not be confused with the kill switch.

The page at `src/app/safety-scores/map/page.tsx` embeds the image with a download link and prose on how to read it. `src/app/safety-scores/map/poster.tsx` swaps in an explanatory panel on image error, so both the local-development state (no Pages Function exists under `next dev`) and the post-kill-switch state read as deliberate rather than broken.

## Digest Degradation Contract

The digest includes the map **iff all four hold**:

1. `safety-map:latest.json` exists,
2. `manifest.date` is today (UTC), and
3. `manifest.asOfSec` is under 24 hours old, and
4. a HEAD probe confirms that today's dated PNG exists and is served as `image/png`.

It embeds the **dated** URL, never `latest.png`. Telegram and X cache by URL, so a stable URL lets their CDNs keep serving a superseded image and makes a bad poster unrecallable. With dated URLs, rollback is simply "the next post uses a new URL".

When available, X downloads the PNG, uploads it through the OAuth 1.0a media endpoint, and references the returned media id on the digest post. Telegram stores the canonical dated link inside the immutable outbox payload and requests a large link preview above the message. This preserves Telegram's exact-payload replay and accepted-chunk cursor contracts without creating a separate photo send.

In any other state the digest omits the map section entirely — no stale link, no placeholder — and emits a structured internal ops warning plus a `safety-map-*` degraded reason. An X media-upload failure falls back to the normal text-only tweet and records `safety-map-twitter-attachment`; it never suppresses the digest.

**The digest never fails, blocks, or delays on the map**, in any state, including the namespace being unreachable.

## Kill Switch

Three levers, in increasing order of what has already escaped:

1. **Stop generating.** `gh workflow disable safety-map-refresh.yml`. Previously published keys stay live and served.
2. **Stop serving the image.** Delete `safety-map:latest.png` **and today's dated key** (`safety-map:YYYY-MM-DD.png`), then run `.github/workflows/purge-pages-zone-cache.yml`. The Function then returns 404 with `no-store` and the page renders its unavailable panel. No Pages release is required.

   The purge is not optional. `latest.png` is served with `s-maxage=300, stale-while-revalidate=86400`, so a deleted key can keep being served from the edge for up to a day. Dated keys are `immutable` and will not re-validate at all until purged.

   Deleting `safety-map:latest.json` is a **different** lever with a different scope: the Function never reads the manifest, so the image keeps serving. What the manifest controls is the digest's omit rule (see the degradation contract above). Delete the manifest to stop the map appearing in the digest; delete the PNG keys to stop it appearing on the site. To stop both, delete all three.
3. **A bad image is already live and scraped.** Re-render, overwrite the keys, and run `.github/workflows/purge-pages-zone-cache.yml`. Social CDNs that already hold the dated URL are not recallable — this is why the digest embeds dated URLs, so the next post simply supersedes.

## Related

- [report-cards.md](./report-cards.md) — the grades and scores the map draws
- [digest-pipeline.md](./digest-pipeline.md) — the intended consumer of the manifest
- [scripts.md](./scripts.md) — the generator's row in the script inventory
- [og-images.md](./og-images.md) — the other rendered-image pipeline, which is deploy-coupled by contrast
