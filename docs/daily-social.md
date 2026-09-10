# Daily Pharos data posts

Pharos renders one data-led graphic and tweet text per day, keyed to a **14:00 Europe/Belgrade** edition clock. `shared/lib/daily-social-schedule.ts` is the calendar and time authority. The IANA timezone conversion yields 12:00 UTC during summer time and 13:00 UTC during winter time, including transition dates. Editions are generated and posted manually; nothing publishes to X automatically. The series supplements the existing morning digest.

## Editorial calendar and data policy

| Belgrade weekday | Topic | Evidence and selection |
| --- | --- | --- |
| Monday | Market-cap growth | Up to five largest positive seven-day dollar increases among tracked assets with at least $10M current market cap and valid positive prior-week baselines. Percentage change and current cap accompany the dollars. |
| Tuesday | Yield watch | Current APY ranked descending, with Safety Score at least 70 and at least $1M source TVL. Requires fresh, score-qualified V9 provenance bound to the active safety publication, no warning/anomaly/investability flags, no default safety, and APY above zero and at most 100%. Current safety grade/score and source TVL are visible. |
| Wednesday | DEX liquidity growth | Up to five largest positive tracked pool TVL increases. Every eligible measured, trendworthy coin's history is examined. The baseline is the nearest daily point within 36 hours of seven days earlier, with the same methodology version and coverage class. Current data must be fresh. TVL changes can include price and coverage effects; they are not labelled net deposits. |
| Thursday | Market-share movers | Three largest percentage-point gains and two largest losses in share of the same comparable tracked-asset cohort at both dates. The graphic leads with the actual prior/current shares (for example, 19.6% → 20.1%); the delta spells out “percentage points.” Movers require $10M current cap. The denominator is explicitly this cohort; wrappers may overlap underlying supply. |
| Friday | Stability report | New confirmed incidents and recorded recoveries over seven days, plus all still-open incidents. Reads the complete cursor-paginated archive with exact-count and duplicate checks; aborts on incomplete/changing pagination. Pending observations are excluded. Counts are episodes, not unique coins. |
| Saturday | Safety Score board | Highest current published scores among rated tracked assets with $10M+ market cap. Letter grades are the primary rating; the smaller numeric score, shared 0–100 ladder and weakest pillar provide context. Publication must be current. Sparse grade-change history is insufficient for exact weekly score deltas, so the title explicitly says current scores. |
| Sunday | Market overview | Largest eligible tracked assets by current circulating market cap, plus eligible asset count. The graphic labels its composition as the displayed caps, without claiming a deduplicated ecosystem total. |

`scripts/lib/daily-social-capture.ts` consumes existing Pharos endpoints and canonical response schemas. Circulating list values are already USD and use `getCirculatingRaw()` without multiplying by price. Frozen/restored supplies, malformed buckets and stale observed supply are excluded. A tied numeric rank is resolved by asset ID. Quiet growth/share editions can truthfully show zero qualifying movers; missing specialist evidence falls back to a separately captured fresh market overview. The snapshot records `fallbackFor` and a visible subtitle explaining the substitution. If neither source is usable, preparation fails and no fabricated or stale post is sent.

Current API freshness uses the earliest applicable body timestamp, `X-Data-Age` plus edge `Age`, and per-row observed timestamps; stale/future warning headers and missing required provenance fail closed. Historical DEX arrays do not have freshness headers: their explicit point timestamps and compatibility fields are checked separately. Historical baseline age is not used as the current snapshot clock. A prepared edition must remain within three hours of its oldest current source data and two hours of capture at delivery.

Coin graphics include current letter grades beside symbols, such as `USDC (A+)`, when a published rating is available. Growth, liquidity, share and overview captures join one fresh, current V9 publication by stablecoin ID. Yield rows retain their already-qualified safety publication; the safety board uses its own current publication. Grades are never inferred from symbols or numeric scores. A grade-bearing snapshot freezes `safetyAsOf` and `safetyPublicationId`, and its overall `asOf` includes the safety clock. Canonical `NR` is shown only when explicitly published. An unavailable optional grade feed leaves the market graphic usable with an unavailable-grade notice; missing individual cards stay ungraded. Aggregate stability counts do not receive coin ratings.

Optional `shareBeforePct` / `shareAfterPct` row fields retain the actual cohort shares and must arithmetically match the percentage-point delta. Small movements gain enough decimal places to remain visible. New tweet and alt text use grade-first labels and before/after shares. Old snapshots without these optional fields keep their original deterministic copy so deployed immutable manifests remain readable.

## Preparation and publication

There is no scheduled or dispatchable workflow. The former daily social GitHub workflow (cron candidates at `:07`/`:27`/`:47` UTC during hours 11–12, plus manual dispatch) was removed on 2026-09-10 because its `plan` gate only accepted the 13:00–14:00 Europe/Belgrade window, which made it useless for on-demand generation. Operators run the local commands below whenever an edition is wanted.

`publish` remains available locally for the immutable KV protocol; it still requires today's capture inside the preparation window and the existing `CLOUDFLARE_ACCOUNT_ID`, `SAFETY_MAP_KV_TOKEN`, and `KV_NAMESPACE_ID` (Pages `SELECTOR_SNAPSHOTS` namespace). No X credentials are involved anywhere in this pipeline.

The snapshot freezes local edition date, scheduled time, captured/current-source timestamps, actual topic and any fallback, exact row values, visible context, highlights, source and methodology. The renderer has seven distinct compositions, shared numeric scales, signed share bars and 0–100 score scales. The stability report gives new incidents and recoveries large headline counts, with a separate open-episode strip and explicitly labelled shared count bars. Grade suffixes remain intact when long labels are fitted to their space, and grade-bearing graphics show the Safety Score publication clock in a legend. The renderer emits PNG, embedded-font SVG/HTML and alt text from the same snapshot. The publisher fully decodes the PNG and enforces 1600×1000 dimensions and a 5 MiB maximum before publishing.

`publish` writes `daily-social:YYYY-MM-DD:SHA256.png`, verifies byte readback, then commits `daily-social:YYYY-MM-DD.json` containing the snapshot, checksum and deterministic tweet/alt text. The dated manifest is never replaced. Content-addressed images let a later retry recover from a pre-manifest failure without overwriting an earlier image. KV editions are retained; no automatic deletion is introduced.

The Pages route `functions/social-posts/[[path]].ts` serves `GET`/`HEAD` at `/social-posts/YYYY-MM-DD.json` and `.png`. It loads the validated manifest before resolving a PNG key, verifies image signature and checksum, bounds reads to 32 KiB JSON and 5 MiB PNG, and returns immutable success responses. Missing, malformed and mismatched artifacts are never cached.

## Delivery

Publication is manual. The Worker does not fetch, verify or tweet these editions, and no `daily-social-delivery` budget surface or `daily-social:twitter-sent:*` ledger exists. An operator takes the rendered `poster.png` and `.alt.txt` and posts them by hand when an edition is wanted. The former automatic 14:00 Europe/Belgrade tweet was retired on 2026-09-10 to keep every post an editorial decision.

Commit/build validation does not activate anything; releasing the Pages code only enables manifest serving.

## Local preview and checks

```bash
npm run publish:daily-social -- capture --topic market-growth --out-dir agents/daily-social/local
npm run build:daily-social -- --input agents/daily-social/local/snapshot.json --out agents/daily-social/local/poster.png
npm run publish:daily-social -- publish --dry-run --out-dir agents/daily-social/local
```

`capture` loads `PHAROS_API_KEY` from the environment or ignored root `.env.local`. Previews may run any day; a topic override cannot bypass the weekday policy for remote publication. `--dry-run` never writes local files, GitHub outputs or KV. `plan` is read-only apart from its normal GitHub step output.

Focused coverage includes all weekday choices, CET/CEST and both DST transition dates, prepublication boundaries, fallback eligibility, source filters, incomplete history, scalar formatting, seven graphic layouts, complete PNG decoding, content-addressed recovery, manifest integrity and Pages serving.
