# Local API Development

## Starting the Worker

The worker dev server must be running before making any requests:

```bash
cd worker && npx wrangler dev   # binds to localhost:8787
```

## Public Endpoints

No auth required:

```bash
curl http://localhost:8787/api/health
curl http://localhost:8787/api/stablecoins
```

## Admin Endpoints

Three endpoints require an `X-Admin-Key` header:

| Endpoint | Purpose |
|----------|---------|
| `GET /api/status` | Cron run history, cache freshness, data quality |
| `GET /api/backfill-depegs` | Backfill depeg events from price history |
| `GET /api/backfill-supply-history` | Backfill per-coin supply snapshots |

The key is `ADMIN_KEY` in `worker/.dev.vars`:

```bash
curl -H "X-Admin-Key: `ADMIN_KEY`" http://localhost:8787/api/status
curl -H "X-Admin-Key: `ADMIN_KEY`" http://localhost:8787/api/backfill-depegs
curl -H "X-Admin-Key: `ADMIN_KEY`" http://localhost:8787/api/backfill-supply-history
```

Auth is implemented in `worker/src/lib/auth.ts` — timing-safe SHA-256 comparison of the `X-Admin-Key` header against `env.ADMIN_KEY`. Returns `401` if missing or wrong.
