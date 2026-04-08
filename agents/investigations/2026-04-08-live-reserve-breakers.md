# Live Reserve Breakers Investigation — 2026-04-08

## Trigger

Admin status showed two open dynamic reserve breakers:

- `live-reserves:ethena`
- `live-reserves:reservoir`

## Live State

Queried `https://api.pharos.watch/api/health` on 2026-04-08:

- overall public health: `healthy`
- `live-reserves:ethena`
  - `state`: `open`
  - `consecutiveFailures`: `4`
  - `lastSuccessAt`: `1775632322` (`2026-04-08T07:12:02Z`)
  - `lastFailureAt/openedAt`: `1775650496` (`2026-04-08T12:14:56Z`)
- `live-reserves:reservoir`
  - `state`: `open`
  - `consecutiveFailures`: `4`
  - `lastSuccessAt`: `1775632327` (`2026-04-08T07:12:07Z`)
  - `lastFailureAt/openedAt`: `1775650523` (`2026-04-08T12:15:23Z`)

Next half-open probe windows:

- `ethena`: `2026-04-08T12:44:56Z`
- `reservoir`: `2026-04-08T12:45:23Z`

## Production D1 Evidence

Remote D1 `reserve_sync_state` rows:

- `usde-ethena`
  - `last_status`: `error`
  - `last_attempted_at`: `1775650303` (`2026-04-08T12:11:43Z`)
  - `last_success_at`: `1775632282` (`2026-04-08T07:11:22Z`)
  - `last_error`: `JSON parse failed ... text/html ... <!DOCTYPE html>`
- `wsrusd-reservoir`
  - `last_status`: `error`
  - `last_attempted_at`: `1775650445` (`2026-04-08T12:14:05Z`)
  - `last_success_at`: `1775632314` (`2026-04-08T07:11:54Z`)
  - `last_error`: `Fetch failed for https://app.reservoir.xyz/api/reserves/raw`

Remote D1 `reserve_sync_attempt_history` shows repeated failures across the hourly reserve lane:

- `usde-ethena`: parse failures at `08:11`, `09:11`, `10:11`, `11:11`, and `12:11` UTC
- `wsrusd-reservoir`: network fetch failures at `08:13`, `09:13`, `10:13`, and `12:14` UTC

Remote D1 `cron_runs` for `sync-live-reserves`:

- `2026-04-08T07:11Z`: `126/126` synced, no failures
- `2026-04-08T08:11Z`: `124/126` synced, errors only for `usde-ethena` and `wsrusd-reservoir`
- `2026-04-08T09:11Z`: same two errors
- `2026-04-08T10:11Z`: same two errors
- `2026-04-08T12:11Z`: same two errors

There is a `usde-ethena` attempt-history row at `2026-04-08T11:11:42Z` without a matching `cron_runs` row, suggesting one hourly lane may have been interrupted before final cron-run persistence.

## Direct Upstream Recheck

Direct probes from this machine on 2026-04-08 around `12:34-12:35Z`:

- `https://app.ethena.fi/api/positions/current/collateral` returned `200` with valid JSON
- `https://app.reservoir.xyz/api/reserves/raw` returned `200` with valid JSON

Reproducing the worker request shape (`Accept: application/json`, `User-Agent: Mozilla/5.0`) still returned valid JSON for both endpoints.

## Assessment

This is a real reserve-sync issue, not just a stale dashboard flag:

- the worker has been unable to refresh live reserve data for `usde-ethena` and `wsrusd-reservoir` since the `07:11Z` run on 2026-04-08
- the problem is isolated to two dynamic reserve breakers
- public `/api/health` remains `healthy` because `live-reserves:*` breakers do not affect top-level public health on their own
- no evidence supports rollback or broad incident response

Most likely interpretation:

- `ethena`: intermittent upstream/app-edge behavior is sometimes returning HTML to the worker path instead of JSON
- `reservoir`: intermittent worker-to-upstream transport/network failures
- because both upstreams were healthy when rechecked directly, the safest immediate operator action is observation, not emergency intervention

## Recommended Action

1. Re-check breaker state after the half-open probe window (`12:44:56Z` / `12:45:23Z`).
2. If both breakers close on the next probe, treat this as transient upstream/runtime instability and keep monitoring only.
3. If either breaker reopens, add targeted telemetry on the live-reserve fetch path:
   - response status
   - content-type
   - first-body-snippet on parse failures
   - timeout vs transport failure counts
   - colo / egress context if available
4. Do not take rollback action while public health remains `healthy` and the failure remains isolated to these two reserve sources.
