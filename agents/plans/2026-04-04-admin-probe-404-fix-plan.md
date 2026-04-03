# Admin Probe 404 Fix Plan

**Date:** 2026-04-04
**Scope:** Fix the browser probe regression where `/api/stablecoin-summary/usdt-tether` returns `404` from the admin and public status surfaces after public API key enforcement.

## Diagnosis

- Browser-origin public probes on `pharos.watch` and `ops.pharos.watch` are rewritten through same-origin `/_site-data/*`.
- The shared probe registry still includes `/api/stablecoin-summary/usdt-tether`.
- The shared site-data allowlist explicitly denies `stablecoin-summary`, so the proxy returns `404` before the worker auth gate or upstream handler runs.

## Plan

1. Allow `stablecoin-summary` on the shared site-data lane.
2. Update shared tests and Pages proxy tests to match the intended behavior.
3. Run targeted validation for the shared route policy and site-data proxy path.
