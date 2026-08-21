# Safety Score Map

The Safety Score map is a landscape poster of the graded stablecoin universe: every graded coin drawn as its logo, sized by circulating supply, packed into the five V9 grade strata (A, B, C, D, F). It is published at `/safety-scores/map/`, and the image itself is served from KV at `/safety-scores/map.png` on a daily cadence that is deliberately decoupled from Pages deploys.

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
| Stamp | `DATA AS OF <date>` | Month plus issue lockup |
| Default basename | `safety-score-map-latest` | `safety-score-map-<YYYY-MM>` |
| Movers window | Since the previous snapshot | Month-boundary snapshots |
| Published to | KV, and therefore the live route | Not published by any automation |

The monthly edition is never inferred from the data clock. Archive and output naming use the **UTC run date**; the visible stamp uses the report-card capture clock (`asOfSec`). Without that split, a run on the first of a month over the previous month's data would file itself under the wrong month and collide with the existing monthly archive.

`--issue <n>` supplies the monthly issue number; it is a positive integer and applies to the monthly lockup only.

## Generator

`scripts/maintenance/build-safety-score-map.ts`, run through `npm run build:safety-score-map` (daily) or `npm run build:safety-score-map:monthly`.

Data comes from the keyed maintenance API — the V9 report cards and the stablecoin list — so `PHAROS_API_KEY` is required (env or `.env.local`), with `PHAROS_API_BASE` as an optional origin override. Supply is read through `getCirculatingRaw()` and treated as already USD-denominated.

Beside the PNG, sharing its basename, the run writes `.svg` and `.html` (the rendered scene and its screenshot host), `.alt.json` (alt text plus the per-tier table), `.snapshot.json` (per-coin `{id, score, grade}` under a header of `{edition, date, asOfSec, renderedAtSec, methodologyVersion, counts}`), and `.manifest.json`. The snapshot is both the movers baseline and the next run's delta-guard input.

Every figure on the poster is computed from the fetched data. No headline number is a literal — under an unattended daily cadence a hardcoded figure becomes a published falsehood within days.

### Guards

The generator exits non-zero rather than publishing something wrong. All of these are unconditional:

- **Freshness.** The report-card capture must be under 48 hours old. A stalled producer must fail the job, not publish week-old scores under today's date.
- **Join coverage.** At least 95% of graded cards must join a list row with real supply, or the map is drawing legibility floors instead of data.
- **Grade vocabulary.** An unrecognized grade letter fails; a silently dropped tier is worse than no map.
- **Finite geometry.** A non-finite bubble scale or radius fails, as does an empty graded set.
- **Composition.** A layout linter rejects overlapping or out-of-band geometry.
- **Fonts.** Each family is checked explicitly; `document.fonts.ready` resolves even when a face fails, and fallback metrics silently break the chip geometry.
- **Raster size.** The screenshot must come back at exactly 3200x1800 (1600x900 at `deviceScaleFactor: 2`).

One guard is skippable: the **day-over-day delta guard**, armed by `--previous-snapshot <path>`. It fails the run when the graded count falls more than 2% or the not-rated count moves more than 5 against the prior snapshot — the guard against a half-broken scoring producer reclassifying most of the universe. An absent or unreadable snapshot skips it with a warning, so a first run can bootstrap.

## Publication

`.github/workflows/safety-map-refresh.yml`. See the header block in that file for the full step-by-step rationale.

The workflow reads `safety-map:snapshot:latest` to arm the delta guard, renders the daily edition, builds a KV manifest from the snapshot header, and publishes. Key order is load-bearing:

| Key | Contents |
| --- | --- |
| `safety-map:snapshot:YYYY-MM-DD` | Dated snapshot, archival |
| `safety-map:snapshot:latest` | Rolling pointer, read by the next run |
| `safety-map:alt:latest` | Alt text and the per-tier table |
| `safety-map:YYYY-MM-DD.png` | Dated image — the URL the digest embeds |
| `safety-map:latest.png` | Same bytes, stable URL for the site |
| `safety-map:latest.json` | Manifest — **written last, the commit marker** |

Because the manifest is written last, a consumer that requires it can never observe a half-published set, and a failure part-way leaves the previous complete set live and untouched. Both PNG keys are read back and byte-compared before the manifest is written. A publish that would land behind the live manifest's render time is refused outright.

Keys live under the single-purpose `safety-map:` prefix inside the existing `SELECTOR_SNAPSHOTS` namespace — the same namespace `functions/selector-snapshot/[[path]].ts` uses. Reusing it changes account state not at all, so the weekly Cloudflare account-state drift check needs no manifest update. (R2 was rejected for this reason among others: that check normalizes `d1` and `kv_namespace` bindings only, so an R2 bucket would be unmonitored surface.)

Failure surfaces as a red run and a GitHub notification. It does **not** page anyone: `ALERT_WEBHOOK_URL` is unset in production, so `sendAlert()` silently no-ops. The reliable human-visible signal is the digest ops line described below.

### Provisioning

`vars.SAFETY_MAP_KV_NAMESPACE_ID` and `secrets.SAFETY_MAP_KV_TOKEN` are provisioned. The token is scoped to *Workers KV Storage: Edit* on that one namespace and is deliberately **not** `CLOUDFLARE_API_TOKEN`, which deploys production Pages and is used only from workflows running under the `production` environment protection that this unattended job does not have.

### Outstanding owner action

The workflow is `workflow_dispatch` only. Its `schedule:` block (`cron: "20 7 * * *"`) is present but commented out.

**Uncomment the cron only after a successful post-merge `workflow_dispatch` run on the default branch has produced a same-day manifest.** 07:20 UTC leaves roughly 45 minutes of headroom before the 08:05 UTC digest cron — deliberately wide, because Actions schedules are routinely delayed 5-20 minutes at peak.

## Serving

`functions/safety-scores/map.png.ts` serves `/safety-scores/map.png` from KV. `GET` and `HEAD` only; HEAD answers exactly as GET does minus the body, because several social platforms probe an image URL with HEAD before fetching it.

`?date=YYYY-MM-DD` selects the dated archive, validated against a strict pattern; anything else is a 400. The Function never lists the namespace and never accepts a caller-supplied key fragment beyond the date. The archive lives on a query parameter rather than a nested path segment so it cannot shadow the static `/safety-scores/map/` page; Cloudflare includes the query string in the default cache key, so the two remain distinct cache entries.

Cache headers differ by resource: `latest.png` gets a short edge TTL with a long `stale-while-revalidate` grace window, while dated keys are write-once and therefore `immutable`.

**A missing binding or a missing object is a 404 with `no-store`, not a 500.** This diverges from the `selector-snapshot` precedent, which treats an absent binding as a misconfiguration, and the divergence is deliberate: it is what makes the kill switch work. A KV read that throws is a 503, which is a different condition and must not be confused with the kill switch.

The page at `src/app/safety-scores/map/page.tsx` embeds the image with a download link and prose on how to read it. `src/app/safety-scores/map/poster.tsx` swaps in an explanatory panel on image error, so both the local-development state (no Pages Function exists under `next dev`) and the post-kill-switch state read as deliberate rather than broken.

## Digest Degradation Contract

The digest pairing is not implemented. The contract is fixed here so the pairing work has something to build against.

The digest includes the map **iff all three hold**:

1. `safety-map:latest.json` exists,
2. `manifest.date` is today (UTC), and
3. `manifest.asOfSec` is under 24 hours old.

It embeds the **dated** URL, never `latest.png`. Telegram and X cache by URL, so a stable URL lets their CDNs keep serving a superseded image and makes a bad poster unrecallable. With dated URLs, rollback is simply "the next post uses a new URL".

In any other state the digest omits the map section entirely — no stale link, no placeholder — and appends one internal ops line. That ops line is the monitoring: it turns "the map job died" into a message where someone is already looking.

**The digest never fails, blocks, or delays on the map**, in any state, including the namespace being unreachable.

## Kill Switch

Three levers, in increasing order of what has already escaped:

1. **Stop generating.** `gh workflow disable safety-map-refresh.yml`. Previously published keys stay live and served.
2. **Stop serving.** Delete the `safety-map:latest.json` key. The Function then returns 404 with `no-store`, which auto-trips the digest's omit rule, and the page renders its unavailable panel. No Pages release is required.
3. **A bad image is already live and scraped.** Re-render, overwrite the keys, and run `.github/workflows/purge-pages-zone-cache.yml`. Social CDNs that already hold the dated URL are not recallable — this is why the digest embeds dated URLs, so the next post simply supersedes.

## Related

- [report-cards.md](./report-cards.md) — the grades and scores the map draws
- [digest-pipeline.md](./digest-pipeline.md) — the intended consumer of the manifest
- [scripts.md](./scripts.md) — the generator's row in the script inventory
- [og-images.md](./og-images.md) — the other rendered-image pipeline, which is deploy-coupled by contrast
