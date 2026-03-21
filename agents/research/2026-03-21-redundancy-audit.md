# Redundancy Audit - 2026-03-21

## Inventory Summary

- Frontend: `src/app/`, `src/components/`, `src/hooks/`, `src/lib/`
- Shared runtime-neutral logic: `shared/lib/`, `shared/types/`, `shared/data/`
- Worker API / cron / runtime helpers: `worker/src/api/`, `worker/src/cron/`, `worker/src/lib/`, `worker/src/handlers/`
- Pages Functions proxy layer: `functions/`
- Tooling / policy / CI scripts: `scripts/`, `.github/workflows/`
- Verified docs consulted for architecture and contracts: `docs/architecture.md`, `docs/api-reference.md`, `docs/testing.md`, `docs/worker-and-api-limits.md`

Framework-required wrappers and entrypoints were not flagged when they existed to satisfy Next.js routing, Cloudflare Worker dispatch, or Pages Functions host gating.

## Findings

### 1. Dead status API shim layer

- `worker/src/api/status-data-quality.ts:1-1`
- `worker/src/api/status-derived-data.ts:1-7`
- `worker/src/lib/status-evaluation.ts:18-29`
- `worker/src/api/status-supplements.ts:16-16`
- `docs/architecture.md:503-505`
- `docs/status-dashboard.md:135-143`

Both API-layer files are pure re-export shims with no behavior of their own, and the runtime code no longer imports them. The real implementations live in `worker/src/lib/status/data-quality.ts` and `worker/src/lib/status/derived-data.ts`, which are imported directly by the status evaluation path. This leaves two dead indirection files in place and creates stale documentation risk because the docs still describe them as active modules.

Consolidation strategy: delete the two API shims, update any doc references that still point at them, and keep the actual implementations under `worker/src/lib/status/`.

Effort: small

### 2. Duplicate fallback thresholds in the status route

- `worker/src/api/status.ts:17-37`
- `worker/src/lib/status-reliability.ts:15-24`

`status.ts` hardcodes the same hysteresis and dwell thresholds that already exist in `status-reliability.ts`. The fallback state builder is effectively maintaining a second copy of the canonical status policy, which makes future tuning risky because the fallback snapshot can drift from the persisted reliability logic.

Consolidation strategy: export a shared fallback-state helper or export the hysteresis object from `status-reliability.ts` and have `status.ts` consume that instead of repeating the numeric constants.

Effort: small to medium

### 3. Repeated 1800-second freshness window

- `worker/src/lib/status-reliability.ts:24-27`
- `worker/src/lib/status-reliability.ts:648-653`

`STATUS_DISCREPANCY_MAX_PROBE_AGE_SEC` is hardcoded to the same `1800` value already represented by `STATUS_SYSTEM_FRESHNESS_SEC`, but the two values are maintained separately. The probe-freshness check and the general system freshness window are semantically aligned today, so keeping them as independent literals creates an avoidable drift point.

Consolidation strategy: derive the probe-age limit from `STATUS_SYSTEM_FRESHNESS_SEC` or replace both with a single exported freshness-window constant if the semantics are intentionally identical.

Effort: small

## Scope Notes

- I did not flag Cloudflare/Next route wrappers, cron-slot handlers, or barrel files when they are required for framework wiring or provide a stable import surface used across the repo.
- I did not find a direct dependency-list redundancy that was clearly removable without changing runtime capability.
- The highest-confidence redundancy in this audit is the dead status shim layer; the other two findings are configuration drift risks rather than large structural duplication.
