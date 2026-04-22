# Daily Digest Twitter `no-creds` Root Cause

Date: 2026-04-22

## Scope

Investigate why recent `daily-digest` cron runs generated successfully, posted to Telegram, but did not post to Twitter/X. Example metadata:

`tweet: no-creds, telegram: ok+appendix(...), quality: repeated-primary-coin:soft`

## Conclusion

Twitter posting is currently disabled in the runtime digest delivery path. This is not a transient failure, not a circuit-breaker event, and not a missing-secret issue in production.

The `tweet: no-creds` status is produced because both active digest execution surfaces pass `twitterCreds = null` into `generateDailyDigest(...)`, which then returns `"no-creds"` from `runDigestChannelDelivery(...)` without attempting any X API request.

The run's `degraded` status is a separate issue caused by the soft quality flag (`repeated-primary-coin:soft`), not by the Twitter skip.

## Evidence

1. `worker/src/cron/daily-digest.ts`
   - `tweetStatus` is computed via `runDigestChannelDelivery(...)`.
   - `runDigestChannelDelivery(...)` returns `"no-creds"` immediately when `creds` is falsy.

2. `worker/src/handlers/scheduled/daily-0805.ts`
   - The scheduled 08:05 UTC path calls:
   - `generateDailyDigest(runtime.db, runtime.env.ANTHROPIC_API_KEY ?? null, null, false, buildTelegramCreds(runtime.env), signal)`
   - The third argument is explicitly `null`, so Twitter delivery can never run on the daily scheduled job.

3. `worker/src/handlers/scheduled/digest-trigger-poll.ts`
   - The manual/admin execution path also calls:
   - `generateDailyDigest(runtime.db, runtime.env.ANTHROPIC_API_KEY ?? null, null, true, buildTelegramCreds(runtime.env), signal)`
   - The third argument is again explicitly `null`, so manual re-runs also cannot tweet.

4. `docs/digest-pipeline.md`
   - The verified doc corpus explicitly states:
   - "Current scheduled and manual-trigger digest paths pass `twitterCreds = null`, so this helper is available but not active in runtime digest delivery."

5. Git history
   - Commit `a262a394d6da75aaa873007a4dc717f67229bce5` is titled:
   - `disable Twitter posting for daily digest`
   - Commit message:
   - `Digest generation and Telegram posting remain active. Twitter creds are no longer passed at the cron or admin-trigger call sites.`

6. Live secret presence
   - `cd worker && npx --no-install wrangler secret list` on 2026-04-22 showed all four Twitter secret bindings present by name:
   - `TWITTER_API_KEY`
   - `TWITTER_API_SECRET`
   - `TWITTER_ACCESS_TOKEN`
   - `TWITTER_ACCESS_TOKEN_SECRET`
   - That rules out "production secret missing" as the cause of `tweet: no-creds`.

## Secondary Findings

1. The runtime no longer builds Twitter creds anywhere active.
   - Current `worker/src/lib/runtime-credentials.ts` only exports `buildTelegramCreds(...)`.
   - The old `buildTwitterCreds(...)` helper existed historically but is no longer part of the active runtime wiring.

2. There is still functional Twitter posting code.
   - `worker/src/lib/twitter.ts` remains implemented and tested.
   - The helper is dormant because no active execution path constructs and passes `TwitterCreds`.

3. `degraded` on the sample run was not caused by Twitter.
   - `worker/src/cron/daily-digest.ts` marks the cron result degraded when `degradedReasons.length > 0 || digestCopy.qualityIssues.length > 0`.
   - The provided metadata includes `quality: repeated-primary-coin:soft`, which is sufficient to mark the run degraded even when generation and Telegram delivery succeed.

## Root Cause

The root cause of missing Twitter posts is product/runtime wiring, not runtime breakage:

- Twitter digest delivery was deliberately disabled on 2026-03-18.
- That disablement was preserved through later refactors, including the 2026-04-17 manual-trigger poll rewrite.
- Production still has Twitter secrets, but the runtime never constructs or passes a Twitter credential object to the digest job.

## Scope Of Impact

All current daily digest execution paths are affected:

- scheduled daily 08:05 UTC run
- manual/admin-triggered digest runs via `digest-trigger-poll`

Weekly recaps are Telegram-only by design and are not part of this issue.

## If Re-Enablement Is Wanted

The smallest safe fix is to restore a `buildTwitterCreds(env)` helper and pass it into the two daily digest call sites above, then verify with:

- a unit test that scheduled/manual paths pass non-null Twitter creds when all four secrets exist
- a live manual trigger in production or preview that confirms `tweet: ok`
