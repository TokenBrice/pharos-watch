# Pre-Launch Registry Split Investigation

Date: 2026-04-13

## Question

Pre-launch stablecoins were stored in the main stablecoin JSON shards, which made it easier for live pipelines to accidentally treat an upcoming asset as active. The concrete symptom was `pusd-polaris` showing on the Yield vs Safety scatter despite Polaris USD not being live.

## Findings

- `ACTIVE_YIELD_BEARING_STABLECOINS` already excluded `status === "pre-launch"` assets.
- `pusd-polaris` still entered yield rankings through `RAW_AUTO_LENDING_POOL_MAP` and `RAW_AUTO_LENDING_SAFETY_BYPASS_IDS` in `worker/src/cron/yield-config.ts`.
- `appendPoolFamilyYieldSources()` resolved explicit and deterministic lending candidates through `TRACKED_META_BY_ID`, which includes pre-launch metadata, so a configured pre-launch ID could bypass the active-yield subset.
- `/upcoming/`, pre-launch detail pages, and Telegram launch subscriptions intentionally need the combined tracked metadata universe.

## Resolution

- Move all 10 pre-launch records into `shared/data/stablecoins/pre-launch.json`.
- Keep `TRACKED_STABLECOINS` as the combined 194-entry metadata universe and keep `ACTIVE_STABLECOINS` as the 184-entry live universe.
- Validate that the active JSON shards cannot contain `status: "pre-launch"` and that `pre-launch.json` only contains pre-launch records.
- Remove `pusd-polaris` from deterministic lending overrides and mark it as an intentional pre-launch yield gap.
- Gate explicit and deterministic yield candidate publication on the active stablecoin universe before resolving metadata.

## Expected Effect

After the next successful `sync-yield-data` publish, `pusd-polaris` should not appear in `/api/yield-rankings` or the `/yield` scatter plot. Upcoming surfaces still retain the Polaris USD detail page and launch-alert command.
