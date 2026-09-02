# Pages Functions Agent Notes

Applies to `functions/`.

## Read First

- `docs/architecture.md` § “Pages Function endpoints (not Worker API)”, `docs/worker-infrastructure.md` § “HTTP Request Handling”, `docs/operator-origin-access.md` § “Pages Functions Proxy”, and `docs/deployment-process.md` § “CI Deploy Sequence”.
- Safety map handlers `functions/safety-scores/map.json.ts` and `functions/safety-scores/map.png.ts`: see `docs/safety-score-map.md` § “Serving”; test `functions/__tests__/safety-map-png.test.ts`.
- Security surfaces: `docs/security-governance.md` § “CSP posture” and `docs/incident-response/safe-browsing-flag.md` § “Step 5 — Harden, ship, verify”.

Route with `node --import tsx scripts/ci/pharos-change-contract.ts --file <path>`.

## Rules

- Pages Functions own same-origin proxy behavior for browser-facing website and operator lanes.
- Production `functions/_site-data/` hosts require `SITE_API_ORIGIN` and forward `SITE_API_SHARED_SECRET`; `site-api.pharos.watch` is not a browser surface.
- Keep Pages env contracts aligned with `functions/lib/ops-env.ts`, `functions/lib/site-api-env.ts`, and `.env.example`.
- Do not import `worker/src/`; shared cross-runtime policy belongs in `shared/lib/`.
- For `functions/selector-snapshot/`, read `docs/screener-picker-page.md`; canonical batching lives in `functions/lib/selector-canonical-snapshot.ts`.

## Common Checks

- Focused tests live under `functions/__tests__/` and `functions/lib/__tests__/`.
- Run `npm run check:env-contract`; run `npm run check:site-csp-sync` for CSP surfaces and `npm run test:smoke-transport` for host routing.
- `npm run lint:changed` enforces the Worker import boundary.
