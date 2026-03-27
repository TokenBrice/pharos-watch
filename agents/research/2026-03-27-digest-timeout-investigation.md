# Digest Timeout Investigation — 2026-03-27

## Findings

- Production D1 confirmed there was no daily digest row for `2026-03-27`; the latest real digest remained `2026-03-26 08:06:08 UTC`.
- Recent `cron_runs` showed `daily-digest` failed at `2026-03-27 08:05:23 UTC` after `30341 ms` with `Error: Claude API error null: no response after retries`.
- Anthropic request logs supplied by the operator showed three `529 Overloaded` responses during the same `2026-03-27 09:05 CET` window, matching the worker-side failure.
- The ops admin path was also brittle for recovery because `POST /api/trigger-digest` waited for the full digest run before responding, while the ops UI proxies admin calls through a short-lived same-origin Pages Function.

## Fix Direction

- Extend retry handling for Anthropic overload responses (`529`) with real exponential backoff.
- Increase Anthropic retry depth for daily digest and weekly recap generation.
- Make `POST /api/trigger-digest` enqueue the digest in `waitUntil()` and run it under the existing `daily-digest` lease so manual recovery does not depend on a long browser-held request.
