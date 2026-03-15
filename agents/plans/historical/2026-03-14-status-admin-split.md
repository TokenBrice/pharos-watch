# Status/Admin Split Plan

Date: 2026-03-14

## Goal

Split the current auth-gated `/status/` surface into:

1. `/admin/` for Access-protected operator actions and deep telemetry
2. `/status/` for public, read-only health information

## Implementation Outline

1. Move the existing operator dashboard route shell from `src/app/status/*` to `src/app/admin/*`.
2. Move the Pages host gate from `functions/status/[[path]].ts` to `functions/admin/[[path]].ts` so `/admin/` stays ops-host-only.
3. Replace `src/app/status/client.tsx` with a public status page backed only by public endpoints (`/api/health` plus public browser probes).
4. Keep admin-only mutation flows on `/api/admin/*` and leave operator actions on the new `/admin/` route.
5. Update smoke-script defaults and status/operator docs to point operators at `ops.pharos.watch/admin/`.
