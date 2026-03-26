# Browser Probe Timeout Investigation

Date: 2026-03-26

## Symptom

The public `/status/` page and ops `/admin/` page could report browser probes as `unreachable` with `Browser probe timed out` / `No HTTP`, even while the underlying worker routes and cron health were normal.

## Live verification

- Direct terminal fetches against `https://api.pharos.watch` returned `200` for the reported routes (`/api/health`, `/api/peg-summary`, `/api/report-cards`, `/api/blacklist-summary`) inside the browser timeout budget.
- Fresh isolated browser sessions on `https://pharos.watch/status/` also showed `27/27` healthy probes.
- A longer-lived browser session could later show many false failures (`11/27` pass, `16` stale/unreachable) with exact 5s timeout signatures, pointing to browser-session probe behavior rather than backend availability.

## Root cause

The status-page probe loop was fanning out every browser probe at once and leaving most successful response bodies unread. Over repeated browser-side probe runs, that creates a transport-local false-negative mode: the session can strand response streams / connection slots long enough for later probes to hit the client timeout and get labeled as `unreachable`, even though the endpoints themselves are healthy.

## Fix

- Limit browser probe concurrency to `6`.
- Cancel unread response bodies for non-semantic probes as soon as the HTTP status is known.

## Validation

- `npm run lint`
- `npm test`
- `npm run build`
