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

## Accepted residual risk — selector-snapshot write lane (S-062)

`POST /selector-snapshot` (`functions/selector-snapshot/[[path]].ts`) is the only unauthenticated KV write path in this slice. Its gates are: a spoofable Origin/Referer check (`rejectIfNotSiteDataUiOrigin`), a 100 KiB payload cap, content-addressed dedupe of identical bodies, a per-isolate hashed-IP throttle (10 writes / 60s window), and a D1-backed atomic hashed-IP daily quota (100 writes / UTC day). The zone WAF rate limits only cover `api.pharos.watch/api/*`; the isolate-local limiter still resets on isolate recycle and is not shared across colos, but the D1 quota gives direct-client writes an atomic durable per-IP ceiling.

Accepted because the blast radius is bounded write-amplification / KV cost, not data integrity: read-side sid recomputation and shape validation reject tampered values, selector prose is stripped instead of trusted from POST bodies, and abusive entries fall off the 90-day unread TTL (`SELECTOR_SNAPSHOT_UNREAD_TTL_SECONDS`) unless read. Worst-case single-IP cost ceiling is roughly `100 KiB x 100 writes/day x 90 days` of KV storage before unread expiry, with each entry surviving longer only if it is also read at least once.

If this lane sees real abuse, escalate to a Cloudflare WAF / rate-limiting rule on `pharos.watch/selector-snapshot*` or move the throttle to a Durable Object-backed counter with stricter replay controls.

## Common Checks

- Pages Functions tests under `functions/__tests__`
- `npm run check:env-contract`
- `npm run check:worker-boundary`
