# Pages Functions Agent Notes

Applies to `functions/**`.

## Read First

- `docs/architecture.md`
- `docs/worker-infrastructure.md`
- `docs/operator-origin-access.md`
- `docs/deployment-process.md`

## Rules

See root AGENTS.md / CLAUDE.md Hard Rules for cross-cutting rules. This file only documents functions-specific items.

- Pages Functions own same-origin proxy behavior for browser-facing website and operator lanes.
- Production `/_site-data/*` hosts require `SITE_API_ORIGIN` and forward `SITE_API_SHARED_SECRET` to the Worker site-data lane.
- `site-api.pharos.watch` is internal, not a browser surface.
- Keep Pages env contracts aligned with `functions/lib/ops-env.ts`, `functions/lib/site-api-env.ts`, and `.env.example`.
- Do not import `worker/src/**`; shared cross-runtime policy belongs in `shared/lib/**`.

## Selector-snapshot write lane (S-062)

`POST /selector-snapshot` (`functions/selector-snapshot/[[path]].ts`) is the only unauthenticated KV write path in this slice. Its gates are: a spoofable Origin/Referer check (`rejectIfNotSiteDataUiOrigin`), an incrementally enforced 100 KiB payload cap, content-addressed dedupe of server-recomputed output, a per-isolate HMAC-IP throttle (10 writes / 60s window), and a D1-backed atomic HMAC-IP daily quota (100 writes / UTC day). `SELECTOR_SNAPSHOT_IP_HASH_SECRET` is a dedicated Pages secret; raw and unsalted IP hashes must never be persisted.

New snapshots are Pharos-recomputed. POST projects only `SelectorInput`, fetches and schema-validates the eight canonical site-data sources through `SITE_API_ORIGIN` with `SITE_API_SHARED_SECRET`, rebuilds the dataset, and runs the shared selector engine. Source requests run in two batches of four and each response body must be fully consumed before the next batch opens. The boundary persists schema-v3 output with `provenance: "pharos-verified"`, a `pharos-server-recomputed-v1` dataset/engine binding, and matching KV trust metadata. Never infer trust from body fields alone: only entries carrying that KV metadata may use the verified replay validator or banner. Existing entries without trusted metadata are normalized to schema v2 with `provenance: "client-unverified"`; that legacy status must remain visible. Entries fall off the 90-day unread TTL (`SELECTOR_SNAPSHOT_UNREAD_TTL_SECONDS`) unless the first read successfully extends retention; extension failure returns `503` instead of claiming the five-year retention contract succeeded.

If this lane sees real abuse, escalate to a Cloudflare WAF / rate-limiting rule on `pharos.watch/selector-snapshot*` or move the throttle to a Durable Object-backed counter with stricter replay controls.

## Common Checks

- Pages Functions tests under `functions/__tests__`
- `npm run check:env-contract`
- `npm run check:worker-boundary`
