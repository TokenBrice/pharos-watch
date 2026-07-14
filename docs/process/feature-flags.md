# Feature Flags

Feature flags gate the riskiest of the May 2026 detail-page changes. Most default to off. Three flags are default-on and roll back only when explicitly set to `false`: `NEXT_PUBLIC_PHAROS_HERO_VERDICT` (after the W3 launch), `NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER`, and `NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER_REVIEWER`.

To enable a default-off flag locally: `NEXT_PUBLIC_PHAROS_<NAME>=true npm run dev`.

To disable a default-on flag locally, set that flag to the literal string `false`, for example `NEXT_PUBLIC_PHAROS_HERO_VERDICT=false npm run dev`, `NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER=false npm run dev`, or `NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER_REVIEWER=false npm run dev`.

To enable in prod: set the env var as a GitHub repository Variable. The Pages build runs in GitHub Actions, so Cloudflare Pages dashboard variables are runtime-only for this app and are not inlined into the static bundle.

Implementation lives in `src/lib/feature-flags.ts`. The flags are read at usage sites by name; they are intentionally not registered in any `.env` file or `next.config.*`.

## Flags

| Flag                                         | Gates                                                                               | Default                      | `expiresAt`                 |
| -------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------- | --------------------------- |
| `NEXT_PUBLIC_PHAROS_QUIET_DEVIATIONS`        | Idea 19 (quiet calm deviations + magnitude-aware mcap delta)                        | off                          | 2026-08-01                  |
| `NEXT_PUBLIC_PHAROS_MOBILE_STICKY_SUMMARY`   | Idea 20b (mobile sticky compact summary)                                            | off                          | 2026-08-01                  |
| `NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER`        | Idea 13b (recent blacklist banner, FE-only v1)                                      | off                          | 2026-08-01                  |
| `NEXT_PUBLIC_PHAROS_HERO_VERDICT`            | Idea 1 (hero `oneLiner` verdict + AI-summary TL;DR promotion)                       | on unless explicitly `false` | n/a (default-on, no expiry) |
| `NEXT_PUBLIC_PHAROS_CHART_ANNOTATIONS`       | Idea 4 (curated + tape event-annotated charts)                                      | off                          | 2026-09-01                  |
| `NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER`          | Depeg Duration Resolver module on `/depeg/` (emergency rollback)                    | on unless explicitly `false` | 2026-09-01                  |
| `NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER_REVIEWER` | Depeg Duration Resolver Reviewer module below DDR on `/depeg/` (emergency rollback) | on unless explicitly `false` | 2026-09-01                  |

`expiresAt` is advisory — each gated flag in code carries the same date in a comment, including the two default-on resolver flags (`DEPEG_RESOLVER` / `DEPEG_RESOLVER_REVIEWER`, both `2026-09-01`); only the default-on `HERO_VERDICT` has no expiry. Past the date, either flip and inline the on-path, or document the reason for keeping the flag. The stale-flag check (`scripts/ci/check-stale-flags.mjs`) runs in advisory prebuild mode and fails that check when any flag's `expiresAt` is today or earlier; it also warns 30 days ahead.

## Flip readiness gates

What must be true before turning each flag on in production:

### `NEXT_PUBLIC_PHAROS_QUIET_DEVIATIONS`

- [x] Magnitude-aware `getTrendClass` lands behind the flag (`src/lib/stablecoin-detail-view-model.ts`).
- [ ] WCAG AA contrast spot-check on the three calm/warn/severe deviation tokens (light + dark themes).
- [ ] Visual review on USDC + USDe + a coin with an active depeg.

### `NEXT_PUBLIC_PHAROS_MOBILE_STICKY_SUMMARY`

- [x] `MobileStickySummary` publishes its height to `--pharos-sticky-summary-h`; `LongformScrollspyNav` includes it in `scrollMarginTop` via `calc()`.
- [ ] Real-device QA: iOS Safari + Android Chrome scrollspy behavior with sticky summary mounted.

### `NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER`

- [x] Frozen-asset suppression in place.
- [x] `useRecentBlacklist7d` aggregates client-side from the existing summary endpoint (no extra worker round-trips).
- [ ] iOS Safari sticky check on a coin with active freezes.

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
`.github/workflows/validate-ci.yml` and `.github/workflows/pages-release.yml`
pass them to the Next.js build; changing a Cloudflare Pages runtime variable
does not change the static bundle.

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
`src/lib/feature-flags.ts`, both build workflows, this inventory, and the
inlining/stale-flag checks as applicable.

## Spec source

The flag table above is the durable reference. Runtime defaults live in `src/lib/feature-flags.ts`; build-workflow propagation lives in `.github/workflows/validate-ci.yml` and `.github/workflows/pages-release.yml` (the production deploy workflow calls `pages-release.yml` for Pages builds).
