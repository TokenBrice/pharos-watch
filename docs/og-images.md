# OG Images

Pharos serves three classes of Open Graph / Twitter preview images. They have different generation pipelines and different renewal cadences.

## 1. Static page screenshots (`public/og-*.png`)

Captured by `scripts/maintenance/screenshot-og.mjs` via Playwright Chromium against the live site. Each capture is 1200×628. The script injects CSS to hide chrome (header, aside, footer, overlays) and force the `#main-content` region to fill the frame.

| Image | Page |
| --- | --- |
| `og-card.png` | `/` (also the default fallback in `src/lib/page-metadata.ts`) |
| `og-about.png` | `/about` |
| `og-cemetery.png` | `/cemetery` |
| `og-chains.png` | `/chains` |
| `og-compare.png` | `/compare` |
| `og-coverage.png` | `/coverage` |
| `og-depeg.png` | `/depeg` |
| `og-flows.png` | `/flows` |
| `og-liquidity.png` | `/liquidity` |
| `og-safety-scores.png` | `/safety-scores` |
| `og-yield.png` | `/yield` |
| `og-blacklist.png` | `/freezewatch` |
| `og-stability-index.png` | `/stability-index` |
| `og-dependency-map.png` | `/dependency-map` |
| `og-digest.png` | `/digest` |
| `og-portfolio.png` | `/portfolio?p=...` (pre-loaded so the capture is not empty state) |
| `og-methodology.png` | `/methodology` |
| `og-start.png` | `/start` |
| `og-pharoswatchbot.png` | `/pharoswatchbot/` |
| `og-default.png` | `/screener` |

`screenshot-og.mjs` first tries `waitUntil: "networkidle"` with a 20 s timeout, then falls back to `waitUntil: "load"` for pages with persistent polling (e.g. `/digest`).

### How to renew

```bash
npm run og:capture                                   # captures the live pharos.watch
OG_BASE_URL=http://127.0.0.1:3000 npm run og:capture # captures local dev
```

### When to renew

- After a meaningful UI change on any covered page.
- After a methodology version bump that changes a page's headline or layout.
- Automatically: a weekly GitHub Action (`.github/workflows/og-refresh.yml`) runs against production and opens a PR with the diff.

## 2. Mechanism explainer cards (`public/og-learn-*.png`)

Generated for `/learn/mechanisms/[archetype]` pages. The pipeline reuses the mechanism diagram SVG produced by `src/components/stablecoin-detail/mechanism-diagrams/__tests__/mechanism-diagrams.test.tsx` snapshots so the OG card stays diagram-consistent.

| Image | Slug |
| --- | --- |
| `og-learn-fiat-cash.png` | `fiat-cash` |
| `og-learn-tbill.png` | `tbill` |
| `og-learn-cdp.png` | `cdp` |
| `og-learn-synthetic-delta-neutral.png` | `synthetic-delta-neutral` |
| `og-learn-algorithmic.png` | `algorithmic` |
| `og-learn-rwa-credit-fund.png` | `rwa-credit-fund` |

### How to renew

```bash
node scripts/maintenance/build-og-learn-images.mjs   # writes SVGs to agents/og-learn-staging/
# Then convert SVG → PNG (e.g. via the svg-to-png skill / Playwright Firefox)
# and move the PNGs into public/og-learn-<slug>.png
```

### When to renew

- After a mechanism diagram update (`mechanism-diagrams.test.tsx.snap` changed).
- After an archetype title change in `build-og-learn-images.mjs`.
- After a new mechanism archetype is added (also requires a new content module per `docs/learn-mechanisms-page.md`).

## 3. Dynamic Worker cards (`/api/og/*`)

Rendered on-request by `worker/src/api/og.tsx` using satori + resvg WASM, cached 15 minutes via `API_CACHE_PROFILES.ogImage`. **Self-renewing — no manual step.**

| Route | Source |
| --- | --- |
| `/api/og/stablecoin/:id` | per-stablecoin card (referenced from `src/lib/page-metadata.ts → buildStablecoinDetailMetadata`) |
| `/api/og/safety-scores` | safety scores summary card |
| `/api/og/depeg` | depeg summary card |
| `/api/og/stability-index` | stability index summary card |

These are the only OG images that automatically reflect current data. If their template needs to change, edit `worker/src/lib/og-templates/*` and run worker tests.

## CI guardrails

- `npm run seo:check` (`scripts/ci/check-seo-static.mjs`) inspects the built `out/` for OG metadata. As part of T2, this check also asserts that every relative `og:image` / `twitter:image` URL resolves to a file in `out/`. This catches broken references like the historical `/og-default.png` regression.
- The merge gate runs `seo:check` whenever the diff is Pages-impacting.

## Orphans (intentional)

These files in `public/` are not referenced from `src/` but are kept in case of external/legacy inbound links:

- `og-image.png` — pre-`og-card.png` default fallback.
- `og-card.svg` — predecessor of `og-card.png`.
- `og-pharosville.png` — `/pharosville` promo page no longer exists in app.

Audit and remove if you confirm no external surfaces still point at them.
