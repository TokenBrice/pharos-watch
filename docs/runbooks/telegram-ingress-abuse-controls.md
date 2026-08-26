# Telegram Ingress Abuse Controls

## Scope

This runbook covers the three unauthenticated public POST entrypoints that authenticate with Telegram credentials inside the Worker. `api.pharos.watch` uses the canonical limiter budget shown below; requests reaching the same paths on another Worker host use a separate noncanonical-host budget.

| Route                                 | Worker per-colo ceiling | Body cap |
| ------------------------------------- | ----------------------: | -------: |
| `POST /api/telegram-webhook`          |               2,400/min |  128 KiB |
| `POST /api/telegram-mini-app/session` |               1,600/min |   16 KiB |
| `POST /api/telegram-mini-app/mutate`  |               9,600/min |   16 KiB |

The Worker ceilings are native Cloudflare Workers [Rate Limiting bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/). They are permissive, eventually consistent, and local to the Cloudflare location serving the request. They bound work; they are not exact accounting. Noncanonical hosts share a separate key per route, so preview, site-data, or ops-origin traffic cannot consume the canonical public API budget while still remaining pre-auth rate limited.

There are no active Telegram-specific WAF rules. The account-state source of truth, `scripts/ci/cloudflare-account-state-manifest.json`, records one deliberately disabled broad API rule because the zone's free plan has one rate-limiting slot. `wrangler deploy` installs only the Worker bindings.

## Request Cost Order

`worker/src/handlers/http/request-dispatch.ts` applies the ingress guard after CORS preflight and maintenance mode, but before Access/API-key gates, routing, Telegram authentication, D1, request attribution, or usage analytics:

1. Match the exact pathname and `POST` method. `api.pharos.watch` uses the canonical route key; every other routed hostname uses the route's shared noncanonical-host key before continuing to the normal host/lane gate.
2. Reject malformed declared `Content-Length` with `400` and declared oversize bodies with `413`.
3. Charge the path-specific Rate Limiting binding. Exhaustion returns `429`; a missing or failed binding fails closed with `503` and `Retry-After: 1`.
4. Read at most the path body cap so chunked or misleading requests cannot bypass the declared-size check.
5. Rebuild the request from the bounded bytes without the stale `Content-Length` or `Transfer-Encoding` headers.
6. Continue to schema parsing, webhook-secret or Mini App HMAC validation, D1, and authenticated usage analytics.

An over-budget request therefore does not read its body, execute Telegram HMAC work, touch D1, or schedule request-attribution writes. An admitted request remains body-bounded.

## Edge WAF posture

The three Worker bindings are the live pre-auth budget. Planning note (non-authoritative): if an edge rule is proposed later, first verify current Cloudflare plan capacity, then reconcile the proposal with the account-state manifest and drift fixtures in one review. An exact-path rule cannot be treated as active until the manifest records it and the read-only account-state check passes.

## Telemetry

Early and handler-level rejections emit a structured Workers log record with:

- `event = telegram_ingress_rejection`
- `route = webhook | mini_app_session | mini_app_mutation`
- `status = 400 | 401 | 413 | 429 | 503`
- `metadata.stage = body_header | rate_limit | body_stream | handler`
- `metadata.reason` from the closed reason set in `telegram-ingress-abuse.ts`

The record contains no IP address, request header, URL query, body, Telegram `initData`, chat ID, or user ID. Early rejections deliberately do not write D1 telemetry. In Workers Observability, filter on `telegram_ingress_rejection`, then group by `route`, `status`, `metadata.stage`, and `metadata.reason`.

Interpretation:

- `429 / rate_limit / preauth_rate_limited`: Worker per-colo ceiling was reached. Check WAF Security Events only if an edge rule has since been activated.
- `503 / rate_limit / rate_limit_unavailable`: binding absent or failed. Treat as a deployment/runtime incident; the gate is intentionally fail closed.
- `413 / body_header` versus `413 / body_stream`: declared-size abuse versus chunked/misdeclared overflow.
- `401 / handler`: Mini App Telegram signature or freshness rejection after the pre-auth budget admitted the request.
- `400 / handler`: schema or JSON rejection after the bounded read.

## Verification

Run the local contract and config checks:

```bash
npx vitest run \
  worker/src/handlers/http/__tests__/telegram-ingress-abuse.test.ts \
  worker/src/handlers/http/__tests__/request-dispatch.test.ts
npx tsc -p worker/tsconfig.json --noEmit
npx wrangler deploy --dry-run --config worker/wrangler.toml --outdir /tmp/pharos-worker-dry-run
```

The tests enforce exact host/path/method matching, request cost order, streamed body caps, fail-closed binding behavior, the launch-burst fixture, route isolation, telemetry fields, and Wrangler binding budgets. The account-state drift tests separately own deployed edge posture.

After production rollout, verify one ordinary Mini App launch and mutation, then confirm no unexpected `429` or `503` increase. Do not generate enough requests to trip production limits merely to test the rule.

## Tuning And Rollback

Preserve the reviewed launch and mutation headroom when changing budgets, and update all of these together:

- `worker/src/handlers/http/telegram-ingress-abuse.ts`
- `worker/wrangler.toml`
- this runbook
- focused policy tests

To roll back the Worker gate, deploy the prior Worker version with its matching Wrangler configuration. A runtime binding failure should be handled as an incident or Worker rollback, not by adding an isolate-local fallback map. If edge rules are introduced later, document their rollback against the then-current manifest and update this runbook's planning note.
