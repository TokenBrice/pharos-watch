# Telegram Ingress Abuse Controls

## Scope

This runbook covers the three unauthenticated public POST entrypoints that authenticate with Telegram credentials inside the Worker. `api.pharos.watch` uses the canonical limiter budget shown below; requests reaching the same paths on another Worker host use a separate noncanonical-host budget.

| Route                                 | Worker per-colo ceiling | WAF per-IP ceiling | Body cap |
| ------------------------------------- | ----------------------: | -----------------: | -------: |
| `POST /api/telegram-webhook`          |               2,400/min |          2,400/min |  128 KiB |
| `POST /api/telegram-mini-app/session` |               1,600/min |            120/min |   16 KiB |
| `POST /api/telegram-mini-app/mutate`  |               9,600/min |            360/min |   16 KiB |

The Worker ceilings are native Cloudflare Workers [Rate Limiting bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/). They are permissive, eventually consistent, and local to the Cloudflare location serving the request. They bound work; they are not exact accounting. Noncanonical hosts share a separate key per route, so preview, site-data, or ops-origin traffic cannot consume the canonical public API budget while still remaining pre-auth rate limited.

The WAF rules are **required operator configuration, not deployed state represented by this repository**. `worker/config/telegram-ingress-abuse-policy.json` is the configuration of record. `wrangler deploy` installs the Worker bindings but does not create zone WAF rules.

## Request Cost Order

`worker/src/handlers/http/request-dispatch.ts` applies the ingress guard after CORS preflight and maintenance mode, but before Access/API-key gates, routing, Telegram authentication, D1, request attribution, or usage analytics:

1. Match the exact pathname and `POST` method. `api.pharos.watch` uses the canonical route key; every other routed hostname uses the route's shared noncanonical-host key before continuing to the normal host/lane gate.
2. Reject malformed declared `Content-Length` with `400` and declared oversize bodies with `413`.
3. Charge the path-specific Rate Limiting binding. Exhaustion returns `429`; a missing or failed binding fails closed with `503` and `Retry-After: 1`.
4. Read at most the path body cap so chunked or misleading requests cannot bypass the declared-size check.
5. Rebuild the request from the bounded bytes without the stale `Content-Length` or `Transfer-Encoding` headers.
6. Continue to schema parsing, webhook-secret or Mini App HMAC validation, D1, and authenticated usage analytics.

An over-budget request therefore does not read its body, execute Telegram HMAC work, touch D1, or schedule request-attribution writes. An admitted request remains body-bounded.

## Required WAF Configuration

Cloudflare evaluates zone [rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/) before the Worker. Create these rules from `worker/config/telegram-ingress-abuse-policy.json` in the `pharos.watch` zone using Security -> WAF -> Rate limiting rules or the Rulesets API:

| Rule                                       | Exact match                                                            | Characteristics    | Threshold | Action    |
| ------------------------------------------ | ---------------------------------------------------------------------- | ------------------ | --------: | --------- |
| `telegram-webhook-ingress-limit`           | host `api.pharos.watch`, `POST`, path `/api/telegram-webhook`          | IP, data center ID | 2,400/60s | Block 60s |
| `telegram-mini-app-session-ingress-limit`  | host `api.pharos.watch`, `POST`, path `/api/telegram-mini-app/session` | IP, data center ID |   120/60s | Block 60s |
| `telegram-mini-app-mutation-ingress-limit` | host `api.pharos.watch`, `POST`, path `/api/telegram-mini-app/mutate`  | IP, data center ID |   360/60s | Block 60s |

The data center ID characteristic is mandatory for API-created Cloudflare rate limiting rules. Keep the exact expressions from the policy artifact; do not use `starts_with()` for these three rules.

The existing broad `api-rate-limit-ip` rule must exclude all three exact Telegram paths. Its required expression is also stored in the policy artifact. Without that exclusion, the broad `120/10s` rule remains the effective ceiling and can reject legitimate Telegram launch or webhook bursts before the route-specific budgets apply.

Safe rollout order:

1. Deploy the Worker bindings and gate.
2. Create and enable all three exact-path WAF rules while the broad rule still applies.
3. Verify their rule names, expressions, characteristics, periods, thresholds, and mitigation timeout against the artifact.
4. Add the three-path exclusion to `api-rate-limit-ip`.
5. Confirm matches and response rates under Security -> Events for each exact rule ID.
6. Record the three exact rule IDs and the broad rule ID in the deployment or incident note.

Cloudflare plan capabilities and quotas can change. Confirm the current [rate limiting availability](https://developers.cloudflare.com/waf/rate-limiting-rules/#availability) before editing the zone rules. If the plan cannot represent all three rules, keep the Worker bindings enabled and record the missing edge rule as an open production-control gap; do not label the policy artifact as deployed.

## Telemetry

Early and handler-level rejections emit a structured Workers log record with:

- `event = telegram_ingress_rejection`
- `route = webhook | mini_app_session | mini_app_mutation`
- `status = 400 | 401 | 413 | 429 | 503`
- `metadata.stage = body_header | rate_limit | body_stream | handler`
- `metadata.reason` from the closed reason set in `telegram-ingress-abuse.ts`

The record contains no IP address, request header, URL query, body, Telegram `initData`, chat ID, or user ID. Early rejections deliberately do not write D1 telemetry. In Workers Observability, filter on `telegram_ingress_rejection`, then group by `route`, `status`, `metadata.stage`, and `metadata.reason`.

Interpretation:

- `429 / rate_limit / preauth_rate_limited`: Worker per-colo ceiling was reached. Compare with WAF Security Events before raising a budget.
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

The tests enforce exact host/path/method matching, request cost order, streamed body caps, fail-closed binding behavior, the 800-session launch burst, route isolation, telemetry fields, Wrangler binding budgets, and the broad WAF-rule exclusion.

After production rollout, verify one ordinary Mini App launch and mutation, then confirm no unexpected `429` or `503` increase. Do not generate enough requests to trip production limits merely to test the rule.

## Tuning And Rollback

The session ceiling has 2x headroom over an all-at-once launch by the current roughly 800 subscribers. The mutation ceiling has 2x headroom over six edits by every subscriber in one minute. Preserve that headroom when changing budgets, and update all of these together:

- `worker/src/handlers/http/telegram-ingress-abuse.ts`
- `worker/wrangler.toml`
- `worker/config/telegram-ingress-abuse-policy.json`
- this runbook
- focused policy tests

To roll back WAF controls without creating an unbounded edge gap, first restore the three paths to the broad `api-rate-limit-ip` expression, then disable the exact-path rules. To roll back the Worker gate, deploy the prior Worker version with its matching Wrangler configuration. A runtime binding failure should be handled as an incident or Worker rollback, not by adding an isolate-local fallback map.
