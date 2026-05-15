# Feature Flags

Feature flags gate the riskiest of the May 2026 detail-page changes. All default to off.

To enable locally: `NEXT_PUBLIC_PHAROS_<NAME>=true npm run dev`.

To enable in prod: set the env var in Cloudflare Pages settings (Production + Preview).

Implementation lives in `src/lib/feature-flags.ts`. The flags are read at usage sites by name; they are intentionally not registered in any `.env` file or `next.config.*`.

## Flags

| Flag | Gates | Default | `expiresAt` |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_PHAROS_QUIET_DEVIATIONS` | Idea 19 (quiet calm deviations + magnitude-aware mcap delta) | off | 2026-08-01 |
| `NEXT_PUBLIC_PHAROS_LAZY_CHARTS` | Idea 20c (lazy-mount heavy charts) | off | 2026-08-01 |
| `NEXT_PUBLIC_PHAROS_MOBILE_STICKY_SUMMARY` | Idea 20b (mobile sticky compact summary) | off | 2026-08-01 |
| `NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER` | Idea 13b (recent blacklist banner, FE-only v1) | off | 2026-08-01 |
| `NEXT_PUBLIC_PHAROS_HERO_VERDICT` | Idea 1 (hero `oneLiner` verdict + AI-summary TL;DR promotion) | off | 2026-09-01 |
| `NEXT_PUBLIC_PHAROS_CHART_ANNOTATIONS` | Idea 4 (curated + tape event-annotated charts) | off | 2026-09-01 |

`expiresAt` is advisory — the corresponding gate in code carries the same date in a comment. Past the date, either flip and inline the on-path, or document the reason for keeping the flag. A stale-flag CI check is a planned follow-up (see `agents/stablecoin-detail-improvements-follow-up-plan.md` §6).

## Flip readiness gates

What must be true before turning each flag on in production:

### `NEXT_PUBLIC_PHAROS_QUIET_DEVIATIONS`

- [x] Magnitude-aware `getTrendClass` lands behind the flag (`src/lib/stablecoin-detail-view-model.ts`).
- [ ] WCAG AA contrast spot-check on the three calm/warn/severe deviation tokens (light + dark themes).
- [ ] Visual review on USDC + USDe + a coin with an active depeg.

### `NEXT_PUBLIC_PHAROS_LAZY_CHARTS`

- [x] `LazySection` + `useNearViewport` wired around heavy chart sections (`#chart`, `#peg-deviation`, `#history`, etc.).
- [x] `LazySection` reserves `minHeight` to prevent layout shift while gated.
- [x] Section anchor (`<section id="chart">`) wraps the LazySection so deep-links resolve before the chart mounts. Note: the detail-page client is rendered inside `<Suspense>`, so neither lazy-chart anchors nor the chart canvas appear in the static HTML in either flag state — they materialize on hydration. LAZY_CHARTS therefore does not regress SEO.
- [ ] Mobile LCP measurement on USDC detail page (Chrome DevTools / WebPageTest).

### `NEXT_PUBLIC_PHAROS_MOBILE_STICKY_SUMMARY`

- [x] `MobileStickySummary` publishes its height to `--pharos-sticky-summary-h`; `LongformScrollspyNav` includes it in `scrollMarginTop` via `calc()`.
- [ ] Real-device QA: iOS Safari + Android Chrome scrollspy behavior with sticky summary mounted.

### `NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER`

- [x] Frozen-asset suppression in place.
- [x] `useRecentBlacklist7d` aggregates client-side from the existing summary endpoint (no extra worker round-trips).
- [ ] iOS Safari sticky check on a coin with active freezes.

### `NEXT_PUBLIC_PHAROS_HERO_VERDICT`

- [x] Hero verdict surface lands behind the flag (`<AiSummary>` hoisted above grid when on).
- [ ] Top-60 coins by mcap have both `oneLiner` AND a TL;DR-first AI summary. **Current: 35/391 oneLiners; ~32/200 AI summaries rewritten — curation in flight.**

### `NEXT_PUBLIC_PHAROS_CHART_ANNOTATIONS`

- [x] Phase 2 wire-up: `useChartAnnotations` fetches `/api/events`, maps tape rows, clamps to range.
- [x] Curated annotation layer at `shared/data/annotations/curated-annotations.ts`.
- [x] ≥10 historical annotations seeded across top 4 coins (USDC / USDT / DAI / USDe). Coverage gate enforced by `shared/data/annotations/__tests__/curated-annotations.test.ts`.
- [ ] Named owner + cadence for ongoing curation. **Current: not yet named — single biggest atrophy risk per `agents/stablecoin-detail-improvements-follow-up-plan.md` §3.**

## Idea 20a — closed, no follow-up

Per `agents/idea-20a-diagnosis.md`: no bug found from code inspection. The detail page renders within the design-system layout already. No remaining action.

## Spec source

Spec, success criteria, and per-idea steps live in the plan file:
`agents/stablecoin-detail-improvements-plan-2026-05-15.md`.

(That path is local-scratch under `/agents/` per `docs/process/agent-artifacts.md`; in production the durable spec would live under `docs/process/`. The flag table above is the durable reference once the plan is consumed.)
