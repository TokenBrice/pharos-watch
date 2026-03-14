## Status self-check divergence investigation

- Observed production symptom: `status raw degraded -> effective degraded` while synthetic probes reported `28/28 ok` and `probeStatus: healthy`, causing `consecutiveDivergent` to climb.
- Live confirmation on 2026-03-14:
  - `GET https://api.pharos.watch/api/health` returned HTTP `200` with body `{"status":"degraded", ...}`.
  - The same payload showed open live-reserve circuit breakers (`live-reserves:ethena`, `live-reserves:reservoir`), which is enough to keep public health degraded.
- Root cause in code: `worker/src/cron/status-self-check.ts` treated probe success as `status >= 200 && status < 300` and never inspected the `/api/health` body, so a semantically degraded health endpoint still counted as a healthy probe.
- Fix:
  - parse `/api/health` response JSON inside the self-check
  - map `status: degraded|stale` to probe degradation/staleness even when the transport is `200`
  - preserve existing bootstrap-miss handling for cache-backed `503` endpoints
- Expected effect:
  - self-check metadata should no longer report `probeStatus: healthy` when `/api/health` is explicitly degraded
  - divergence streak should stop increasing for this transport-vs-semantic mismatch
