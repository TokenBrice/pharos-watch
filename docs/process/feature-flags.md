# Feature Flags

Feature flags gate the riskiest of the May 2026 detail-page changes. Most default to off. Three flags are default-on and roll back only when explicitly set to `false`: `NEXT_PUBLIC_PHAROS_HERO_VERDICT` (after the W3 launch), `NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER`, and `NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER_REVIEWER`.

To enable a default-off flag locally: `NEXT_PUBLIC_PHAROS_<NAME>=true npm run dev`.

To disable a default-on flag locally, set that flag to the literal string `false`, for example `NEXT_PUBLIC_PHAROS_HERO_VERDICT=false npm run dev`, `NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER=false npm run dev`, or `NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER_REVIEWER=false npm run dev`.

To enable in prod: set the env var as a GitHub repository Variable. The Pages build runs in GitHub Actions, so Cloudflare Pages dashboard variables are runtime-only for this app and are not inlined into the static bundle.

Implementation lives in `src/lib/feature-flags.ts`. The flags are read at usage sites by name; they are intentionally not registered in any `.env` file or `next.config.*`.

## Flags

Each flag's default and `expiresAt` are owned by `src/lib/feature-flags.ts`; read them there rather than from this page.

| Flag                                         | Gates                                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_PHAROS_QUIET_DEVIATIONS`        | Idea 19 (quiet calm deviations + magnitude-aware mcap delta)                        |
| `NEXT_PUBLIC_PHAROS_MOBILE_STICKY_SUMMARY`   | Idea 20b (mobile sticky compact summary)                                            |
| `NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER`        | Idea 13b (recent blacklist banner, FE-only v1)                                      |
| `NEXT_PUBLIC_PHAROS_HERO_VERDICT`            | Idea 1 (hero archetype `VerdictPill`; the `oneLiner` and AI summary are not gated)  |
| `NEXT_PUBLIC_PHAROS_CHART_ANNOTATIONS`       | Idea 4 (curated + tape event-annotated charts)                                      |
| `NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER`          | DDR + Outlook Posture on `/depeg/`, detail DDR card; master-gates DDRR (rollback)   |
| `NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER_REVIEWER` | Depeg Duration Resolver Reviewer module below DDR on `/depeg/` (emergency rollback) |

`expiresAt` is enforceable: a gated flag carries its date in an `// expiresAt:` comment above the flag in `src/lib/feature-flags.ts`, and a flag with no such comment has no expiry. Past the date, either flip and inline the on-path, or document the reason for keeping the flag. The stale-flag check (`scripts/ci/check-stale-flags.ts`) is enforced by `check:structural` for affected PR paths and every nightly/manual validation run; it fails when any flag's `expiresAt` is today or earlier and warns 30 days ahead.

## Flip readiness gates

What must be true before turning each flag on in production:

### `NEXT_PUBLIC_PHAROS_QUIET_DEVIATIONS`

- [x] Magnitude-aware `getTrendClass` lands behind the flag (`src/lib/stablecoin-detail-hero-view-model.ts`).
- [x] WCAG AA contrast spot-check on the calm/warn/severe text tokens (light + dark themes): the 2026-07-29 CLI review of the flag-selected muted, green, amber, orange, and red tokens found a 4.78:1 minimum on light surfaces and 7.23:1 minimum on dark surfaces.
- [ ] Visual review on USDC + USDe + a coin with an active depeg.

### `NEXT_PUBLIC_PHAROS_MOBILE_STICKY_SUMMARY`

- [x] `MobileStickySummary` publishes its height to `--pharos-sticky-summary-h`; `LongformScrollspyNav` includes it in `scrollMarginTop` via `calc()`.
- [ ] Real-device QA: iOS Safari + Android Chrome scrollspy behavior with sticky summary mounted.

### `NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER`

- [x] Frozen-asset suppression in place.
- [x] `useRecentBlacklist7d` reads the worker's pre-aggregated `stats.perCoinRecentEventTypes` slice off the existing summary endpoint, sharing its query key (no extra worker round-trips).
- [ ] iOS Safari sticky check on a coin with active freezes.

## 2026-07-29 lifecycle review

All three August 1 flags remain default-off. Their automated checks pass, but
they must not be inlined until the remaining human or real-device validation
has been completed.

| Flag | Owner | Evidence reviewed 2026-07-29 | Reason retained | Next review |
| --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_PHAROS_QUIET_DEVIATIONS` | tokenbrice | CLI WCAG review passes AA for all flag-selected text tokens (minimum 4.78:1 light, 7.23:1 dark); `src/lib/__tests__/severity-colors.test.ts` passes. | A human must visually review USDC, USDe, and a coin with an active depeg before the default-off path can be removed. | 2026-09-01 |
| `NEXT_PUBLIC_PHAROS_MOBILE_STICKY_SUMMARY` | tokenbrice | `src/components/stablecoin-detail/__tests__/mobile-sticky-summary.test.tsx` verifies height publication; `src/components/__tests__/longform-scrollspy-nav.test.tsx` verifies the reactive `scroll-margin-top` calculation. | A real device must verify mounted-summary scrollspy behavior in iOS Safari and Android Chrome. | 2026-09-01 |
| `NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER` | tokenbrice | `src/components/stablecoin-detail/__tests__/recent-blacklist-banner.test.tsx` verifies rendering and frozen-asset suppression; `src/hooks/__tests__/use-recent-blacklist-7d.test.tsx` verifies gating and summary aggregation. | A real iOS Safari device must check sticky behavior for a coin with active freezes. | 2026-09-01 |

### `NEXT_PUBLIC_PHAROS_HERO_VERDICT`

- [x] Hero verdict surface (`VerdictPill`) lands behind the flag via `shouldShowVerdict()` in `hero-card-identity.tsx`; the hoisted `<AiSummary>` renders unconditionally and is not gated by the flag.
- [x] Default-on W3 launch completed; emergency rollback is `NEXT_PUBLIC_PHAROS_HERO_VERDICT=false`.
- [ ] Top-60 coins by mcap have both `oneLiner` AND a TL;DR-first AI summary. **Current one-liner coverage is owned by `scripts/__tests__/weekly-curation-digest.test.ts`; `src/lib/__tests__/term-markup.test.ts` owns summary term wiring. TL;DR-first top-60 editorial QA remains in flight.**

### `NEXT_PUBLIC_PHAROS_CHART_ANNOTATIONS`

- [x] Phase 2 wire-up: `useChartAnnotations` fetches `/api/events`, maps tape rows, clamps to range.
- [x] Curated annotation layer at `shared/data/annotations/curated-annotations.ts`.
- [x] ≥10 historical annotations seeded across top 4 coins (USDC / USDT / DAI / USDe). Coverage gate enforced by `shared/data/annotations/__tests__/curated-annotations.test.ts`.
- [ ] Named owner + cadence for ongoing curation. **Current: not yet named — single biggest atrophy risk for the annotation layer.**

### `NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER`

- [x] Runtime DDR snapshot API and `/depeg/` module are wired behind the default-on flag.
- [x] Emergency rollback path is `NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER=false`.
- [ ] Keep at least one current production snapshot available after launch; when absent or stale, the module should degrade to its documented empty/stale state rather than blocking the page.

### `NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER_REVIEWER`

- [x] Runtime-neutral DDRR review logic and schemas validate stored DDR assessments against later `depeg_events`.
- [x] `/api/depeg-resolver-review` is cache-backed, freshness-aware, and returns degraded empty rows before the first snapshot.
- [x] `/depeg/` renders DDRR below DDR (past the DEWS band, the Outlook Posture module, and the "Live forecasts above · graded below" divider) with prominent Recovery and Duration headline tiles.
- [ ] Production snapshot has at least one stored DDR assessment after launch; until then the module shows the empty review state.

## Production Rollout

`NEXT_PUBLIC_PHAROS_*` values are non-sensitive GitHub repository Variables.
`.github/workflows/pages-release.yml`
pass them to the Next.js build; changing a Cloudflare Pages runtime variable
does not change the static bundle.

`.github/workflows/pages-release.yml` also passes non-flag `NEXT_PUBLIC_*`
build inputs that this inventory does not govern. One of them,
`NEXT_PUBLIC_FORCE_SITE_DATA_PROXY`, is hardcoded to `true` in that
workflow rather than read from a Variable, so `gh variable set` cannot
flip it; see [Architecture](../architecture.md) for what it switches.

Set or roll back one flag at a time, then trigger the manual `Rebuild Pages`
workflow so the new value is built, checked, and published:

```bash
gh variable set NEXT_PUBLIC_PHAROS_<NAME> --body true
gh workflow run "Rebuild Pages" --ref main
gh run watch
```

Default-off flags return off when the variable is deleted or set to the exact
lowercase value `false`. Default-on flags require an explicit `false`; deleting
their variable enables them again. A variable change alone does not start a
build.

After release, verify the relevant UI and the `Rebuild Pages` result. The
release path runs `check:feature-flag-inlining` against the built bundle.
Adding, renaming, or removing a flag also requires updating
`src/lib/feature-flags.ts`, the env block in
`.github/workflows/pages-release.yml`, this inventory, and the
inlining/stale-flag checks as applicable.

## Spec source

`src/lib/feature-flags.ts` is the source of truth for flag names, defaults, and `expiresAt` — it is the only file `scripts/ci/check-stale-flags.ts` reads. This page is the durable reference for what each flag gates, its flip-readiness gate, the rollout procedure, and the retention rationale. Build-workflow propagation lives in `.github/workflows/pages-release.yml` (the production deploy workflow calls it for Pages builds).

## 2026-08-23 lifecycle review

All six dated flags were moved from `2026-09-01` to `2026-12-01`. None was
flipped and none was deleted, because in every case the documented blocker is
work this review could not perform. `expiresAt` permits exactly two outcomes
past the date — flip and inline the on-path, or record why the flag is retained
— and this is the second.

This is a dated deferral, not a resolution. The four default-off flags are still
waiting on the same human and real-device validation recorded on 2026-07-29; no
new evidence was gathered, so inlining any of them would have shipped an
unreviewed on-path. `CHART_ANNOTATIONS` additionally still lacks a curation
owner and cadence, which is a product decision rather than a QA task.

The two default-on resolver flags are emergency rollback levers, and the case
for keeping them strengthened rather than weakened: DDR methodology `4.3`
(continuous observation windows and reason-authoritative recovery labels) ships
in this release and changes how onset and recovery windows are confirmed.
Removing the rollback path for `/depeg/` in the same release that changes its
confirmation semantics would remove the mitigation exactly when it is most
likely to be needed.

| Flag | Reason retained 2026-08-23 | Next review |
| --- | --- | --- |
| `NEXT_PUBLIC_PHAROS_QUIET_DEVIATIONS` | Human visual review of USDC, USDe, and an active depeg still outstanding. | 2026-12-01 |
| `NEXT_PUBLIC_PHAROS_MOBILE_STICKY_SUMMARY` | Real-device iOS Safari and Android Chrome scrollspy review still outstanding. | 2026-12-01 |
| `NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER` | Real-device iOS Safari sticky check on a coin with active freezes still outstanding. | 2026-12-01 |
| `NEXT_PUBLIC_PHAROS_CHART_ANNOTATIONS` | No curation owner or cadence assigned; product decision, not a QA gap. | 2026-12-01 |
| `NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER` | Rollback lever for `/depeg/` retained through the DDR 4.3 continuity release. | 2026-12-01 |
| `NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER_REVIEWER` | Rollback lever for the DDRR module retained through the DDR 4.3 continuity release. | 2026-12-01 |
