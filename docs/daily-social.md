# Daily Pharos data posts

Pharos prepares one data-led graphic and tweet per day, targeting **14:00 Europe/Belgrade**. `shared/lib/daily-social-schedule.ts` is the calendar and time authority. The IANA timezone conversion yields 12:00 UTC during summer time and 13:00 UTC during winter time, including transition dates. This series supplements the existing morning digest and replaces the earlier uncommitted Monday-only growth schedule.

## Editorial calendar and data policy

| Belgrade weekday | Topic | Evidence and selection |
| --- | --- | --- |
| Monday | Market-cap growth | Up to five largest positive seven-day dollar increases among tracked assets with at least $10M current market cap and valid positive prior-week baselines. Percentage change and current cap accompany the dollars. |
| Tuesday | Yield watch | Current APY ranked descending, with Safety Score at least 70 and at least $1M source TVL. Requires fresh, score-qualified V9 provenance bound to the active safety publication, no warning/anomaly/investability flags, no default safety, and APY above zero and at most 100%. Current safety grade/score and source TVL are visible. |
| Wednesday | DEX liquidity growth | Up to five largest positive tracked pool TVL increases. Every eligible measured, trendworthy coin's history is examined. The baseline is the nearest daily point within 36 hours of seven days earlier, with the same methodology version and coverage class. Current data must be fresh. TVL changes can include price and coverage effects; they are not labelled net deposits. |
| Thursday | Market-share movers | Three largest percentage-point gains and two largest losses in share of the same comparable tracked-asset cohort at both dates. Movers require $10M current cap. The denominator is explicitly this cohort; wrappers may overlap underlying supply. |
| Friday | Stability report | New confirmed incidents and recorded recoveries over seven days, plus all still-open incidents. Reads the complete cursor-paginated archive with exact-count and duplicate checks; aborts on incomplete/changing pagination. Pending observations are excluded. Counts are episodes, not unique coins. |
| Saturday | Safety Score board | Highest current published scores among rated tracked assets with $10M+ market cap, with grade and weakest pillar. Publication must be current. Sparse grade-change history is insufficient for exact weekly score deltas, so the title explicitly says current scores. |
| Sunday | Market overview | Largest eligible tracked assets by current circulating market cap, plus eligible asset count. The graphic labels its composition as the displayed caps, without claiming a deduplicated ecosystem total. |

`scripts/lib/daily-social-capture.ts` consumes existing Pharos endpoints and canonical response schemas. Circulating list values are already USD and use `getCirculatingRaw()` without multiplying by price. Frozen/restored supplies, malformed buckets and stale observed supply are excluded. A tied numeric rank is resolved by asset ID. Quiet growth/share editions can truthfully show zero qualifying movers; missing specialist evidence falls back to a separately captured fresh market overview. The snapshot records `fallbackFor` and a visible subtitle explaining the substitution. If neither source is usable, preparation fails and no fabricated or stale post is sent.

Current API freshness uses the earliest applicable body timestamp, `X-Data-Age` plus edge `Age`, and per-row observed timestamps; stale/future warning headers and missing required provenance fail closed. Historical DEX arrays do not have freshness headers: their explicit point timestamps and compatibility fields are checked separately. Historical baseline age is not used as the current snapshot clock. A prepared edition must remain within three hours of its oldest current source data and two hours of capture at delivery.

## Preparation and publication

`.github/workflows/daily-social.yml` runs at `:07`, `:27`, and `:47` during UTC hours 11 and 12. The timezone-only plan accepts only the local 13:00–14:00 preparation window, so these candidates cover both CET and CEST. The first successful run prepares the edition; later candidates skip its immutable manifest. GitHub starts are best-effort. A workflow that misses the preparation window cannot silently schedule a different day.

The workflow uses existing `secrets.PHAROS_API_KEY`, `secrets.CLOUDFLARE_ACCOUNT_ID`, `secrets.SAFETY_MAP_KV_TOKEN`, and `vars.SAFETY_MAP_KV_NAMESPACE_ID`. The token must cover the existing Pages `SELECTOR_SNAPSHOTS` namespace. Twitter credentials remain in the Worker; no additional X credentials are copied to CI.

The snapshot freezes local edition date, scheduled time, captured/current-source timestamps, actual topic and any fallback, exact row values, visible context, highlights, source and methodology. The renderer has seven distinct compositions, shared numeric scales, signed share bars and 0–100 score scales. It emits PNG, embedded-font SVG/HTML and alt text from the same snapshot. The publisher fully decodes the PNG and enforces 1600×1000 dimensions and a 5 MiB maximum before publishing.

The serialized workflow is the sole writer. It writes `daily-social:YYYY-MM-DD:SHA256.png`, verifies byte readback, then commits `daily-social:YYYY-MM-DD.json` containing the snapshot, checksum and deterministic tweet/alt text. The dated manifest is never replaced. Content-addressed images let a later retry recover from a pre-manifest failure without overwriting an earlier image. The workflow retains input/render/recovery artifacts for 30 days. KV editions and delivery ledgers are retained; no automatic deletion is introduced.

The Pages route `functions/social-posts/[[path]].ts` serves `GET`/`HEAD` at `/social-posts/YYYY-MM-DD.json` and `.png`. It loads the validated manifest before resolving a PNG key, verifies image signature and checksum, bounds reads to 32 KiB JSON and 5 MiB PNG, and returns immutable success responses. Missing, malformed and mismatched artifacts are never cached.

## Delivery and operational acceptance

`worker/src/lib/daily-social-delivery.ts` runs serially after the Telegram outbox drain in the existing five-minute digest-trigger slot. The new budget-only surface `daily-social-delivery` reserves one connection. Manifest fetch, PNG fetch, media upload, alt-text upload and tweet creation consume each response before the next request. There is no new cron expression and the morning digest keeps its existing behavior.

Delivery opens at 14:00 local and closes at 15:00 local. The 14:00 tick is the target, with later ticks reserved for bounded recovery from transient failure or platform delay. Runtime checks use the wall clock, local date/topic/scheduled timestamp, source/capture freshness and exact image checksum. The time and age checks run again after media preparation, immediately before the tweet. Image or alt-text failure aborts the tweet; text-only degradation is not allowed.

`daily-social:twitter-sent:YYYY-MM-DD` uses the existing D1 compare-and-swap Twitter ledger. A sent edition cannot repost. Confirmed non-post failures have at most three attempts; ambiguous tweet outcomes and lost sending owners stop automatic retries. Terminal states use a read-only fast path before downloading assets again. Budget-surface telemetry records pending artifacts, success, stale data, exhausted attempts and ambiguous outcomes without stopping the digest poll.

Commit/build validation does not activate the schedule. Activation requires the workflow and Worker/Pages code to be released through the protected-main pipeline. Observe the first due production preparation, delivery ledger tweet ID, and live attached image before declaring operational acceptance. For ambiguous delivery, inspect X and reconcile the recorded outcome; never delete an unknown-outcome ledger simply to force another post.

## Local preview and checks

```bash
npm run publish:daily-social -- capture --topic market-growth --out-dir agents/daily-social/local
npm run build:daily-social -- --input agents/daily-social/local/snapshot.json --out agents/daily-social/local/poster.png
npm run publish:daily-social -- publish --dry-run --out-dir agents/daily-social/local
```

`capture` loads `PHAROS_API_KEY` from the environment or ignored root `.env.local`. Previews may run any day; a topic override cannot bypass the weekday policy for remote publication. `--dry-run` never writes local files, GitHub outputs or KV. `plan` is read-only apart from its normal GitHub step output.

Focused coverage includes all weekday choices, CET/CEST and both DST transition dates, prepublication/catch-up boundaries, fallback eligibility, source filters, incomplete history, scalar formatting, seven graphic layouts, complete PNG decoding, content-addressed recovery, manifest integrity, duplicate/ambiguous delivery and Pages serving. Run the Worker schedule/connection/smoke checks when changing the delivery seam.
