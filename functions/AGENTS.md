# Pages Functions Agent Notes

Applies to `functions/`.

## Read First

- Read the router-selected runtime/serving sections first; it supplies the Pages Function, HTTP and applicable proxy contracts.
- Deploy, environment binding, or transport-contract changes: also read `docs/deployment-process.md#ci-deploy-sequence`.
- Safety map handlers `functions/safety-scores/map.json.ts` and `functions/safety-scores/map.png.ts`: see `docs/safety-score-map.md` § “Serving”; test `functions/__tests__/safety-map-png.test.ts`.
- CSP or browser-facing security changes: read `docs/security-governance.md#csp-posture` and `docs/incident-response/safe-browsing-flag.md` § “Step 5 — Harden, ship, verify”.

## Rules

- Pages Functions own same-origin proxy behavior for browser-facing website and operator lanes.
- Production `functions/_site-data/` hosts require `SITE_API_ORIGIN` and forward `SITE_API_SHARED_SECRET`; `site-api.pharos.watch` is not a browser surface.
- Keep Pages env contracts aligned with `functions/lib/ops-env.ts`, `functions/lib/site-api-env.ts`, and `.env.example`.
- Do not import `worker/src/`; shared cross-runtime policy belongs in `shared/lib/`.
- For `functions/selector-snapshot/`, read `docs/screener-page.md#snapshot-sharing`; canonical batching lives in `functions/lib/selector-canonical-snapshot.ts`.

## Common Checks

- Focused tests live under `functions/__tests__/` and `functions/lib/__tests__/`.
- Run `npm run check:env-contract`; run `npm run check:site-csp-sync` for CSP surfaces and `npm run test:smoke-transport` for host routing.
- `npm run lint:changed` enforces the Worker import boundary.
