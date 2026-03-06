---
title: "Fix status probe fidelity and alert escalation"
agent: "codex"
model: "o4-mini"
reasoning_effort: "high"
done: false
---

## Goal

Fix the 2 critical observability findings: synthetic probes that bypass the real production request path, and probe failures that can avoid triggering alerts.

## Context

`worker/src/cron/status-self-check.ts` is a cron job that probes the API to verify it's working. Currently (line ~64) it calls `route()` directly — an in-process function call that bypasses DNS, TLS, CDN, and maintenance-mode gating. If the Worker is up but the domain is misconfigured or maintenance mode is on, this probe still reports healthy.

The alerting logic (line ~148) only fires when there's a discrepancy between effective status and probe status, AND a streak threshold is met. If probes fail consistently (both effective and probe show unhealthy), no alert fires — because there's no discrepancy.

## Task

### Step 1: STATUS-001 — Real HTTP probes

In `worker/src/cron/status-self-check.ts`, around line 64:

1. Replace the `route()` call with a real `fetch()` call against the worker's own URL. The URL should come from env (e.g., `env.SELF_URL` or derive from the configured custom domain `api.pharos.watch`):

```typescript
// Before: const response = route(syntheticRequest, env, ctx);
// After:
const probeUrl = `https://api.pharos.watch/api/peg-summary`;
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 10_000);
try {
  const response = await fetch(probeUrl, { signal: controller.signal });
  clearTimeout(timeoutId);
  // ... process response
} catch (err) {
  clearTimeout(timeoutId);
  // ... handle timeout/network error
}
```

2. Probe multiple endpoints for coverage (e.g., `/api/peg-summary`, `/api/stablecoins`). If any fails, mark probe as degraded.

3. **Important**: The self-URL should ideally come from an env binding (e.g., `SELF_URL`) rather than being hardcoded, so it works in staging environments too. Check if `env` has such a binding; if not, use the `routes` config from wrangler.toml (the custom domain `api.pharos.watch`).

### Step 2: STATUS-002 — Independent probe-failure alerting

In `worker/src/cron/status-self-check.ts`, around line 148:

Currently alerts only fire on status-vs-probe discrepancies. Add a separate alert path for sustained probe failures:

1. After computing the probe result, check if the probe itself failed (not just the discrepancy):
```typescript
if (!probeResult.ok) {
  probeFailureStreak++;
} else {
  probeFailureStreak = 0;
}

// Alert on sustained probe failure regardless of discrepancy
if (probeFailureStreak >= PROBE_FAILURE_ALERT_THRESHOLD) {
  await sendAlert(env, `Status probe failing for ${probeFailureStreak} consecutive checks`);
  // Optionally reset streak after alert to avoid spam (or use cooldown)
}
```

2. The `probeFailureStreak` needs to be persisted across runs. Store it in the `cron_runs` metadata or in a dedicated KV/D1 row. Check how the existing discrepancy streak is persisted and use the same mechanism.

3. Add a `PROBE_FAILURE_ALERT_THRESHOLD` constant (suggest: 3 consecutive failures = alert).

## Acceptance Criteria

1. `cd worker && npx tsc --noEmit` passes
2. `npm test` passes
3. `npm run lint` passes
4. The probe in `status-self-check.ts` uses `fetch()` against a real URL, not `route()`
5. Probe failures trigger alerts independently of discrepancy logic
6. The probe timeout is 10 seconds or less
7. Read the final code and verify: if the probe endpoint is down for 3+ consecutive checks, an alert fires even if the effective status also shows unhealthy
