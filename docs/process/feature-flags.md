# Feature Flags

Feature flags gate selected frontend changes. Defaults and lifecycle dates live in `src/lib/feature-flags.ts`: default-off flags enable only on literal `true`, while default-on flags roll back only on literal `false`.

To enable a default-off flag locally: `NEXT_PUBLIC_PHAROS_<NAME>=true npm run dev`.

To disable a default-on flag locally, set that flag to the literal string `false`, for example `NEXT_PUBLIC_PHAROS_HERO_VERDICT=false npm run dev`, `NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER=false npm run dev`, or `NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER_REVIEWER=false npm run dev`.

To enable in prod: set the env var as a GitHub repository Variable. The Pages build runs in GitHub Actions, so Cloudflare Pages dashboard variables are runtime-only for this app and are not inlined into the static bundle.

Implementation lives in `src/lib/feature-flags.ts`. The flags are read at usage sites by name; they are intentionally not registered in any `.env` file or `next.config.*`.

## Flags

Each flag's default and `expiresAt` are owned by `src/lib/feature-flags.ts`; read them there rather than from this page.

The flag source owns the active inventory; the table below describes its user-facing surfaces. Removal of a no-longer-consumed GitHub Variable is a separately authorized operator action, not an automatic consequence of a code change.

| Flag                                         | Gates                                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_PHAROS_QUIET_DEVIATIONS`        | Idea 19 (quiet calm deviations + magnitude-aware mcap delta)                        |
| `NEXT_PUBLIC_PHAROS_MOBILE_STICKY_SUMMARY`   | Idea 20b (mobile sticky compact summary)                                            |
| `NEXT_PUBLIC_PHAROS_HERO_VERDICT`            | Idea 1 (hero archetype verdict chip; the `oneLiner` and AI summary are not gated)   |
| `NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER`          | DDR module on `/depeg/` and its inputs to the depeg outlook hero; homepage DDR overview; detail DDR card and DDR track-record section; master-gates DDRR (rollback) |
| `NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER_REVIEWER` | DDRR module below DDR on `/depeg/` and the detail DDR track-record section (emergency rollback) |

Dated flags carry an `// expiresAt:` comment immediately above the flag key in `src/lib/feature-flags.ts`; undated flags have no expiry. By the deadline, either retire the flag after acceptance or extend its date with a documented retention rationale. Documentation alone does not waive expiry; flag lifecycle dates are reviewed manually.

## Flip readiness gates

What must be true before turning each flag on in production:

### `NEXT_PUBLIC_PHAROS_QUIET_DEVIATIONS`

- [x] Magnitude-aware `getTrendClass` lands behind the flag (`src/lib/stablecoin-detail-hero-view-model.ts`).
- [x] WCAG AA contrast spot-check on calm/warn/severe tokens in light and dark themes: [immutable CLI review](https://github.com/TokenBrice/pharos-watch/blob/e4e09b34e3b43baadd656471b973c686b34c1c27/docs/process/feature-flags.md#2026-07-29-lifecycle-review). This does not close human visual acceptance.
- [ ] Visual review on USDC + USDe + a coin with an active depeg.

### `NEXT_PUBLIC_PHAROS_MOBILE_STICKY_SUMMARY`

- [x] `MobileStickySummary` publishes its height to `--pharos-sticky-summary-h`; `LongformScrollspyNav` includes it in `scrollMarginTop` via `calc()`.
- [ ] Real-device QA: iOS Safari + Android Chrome scrollspy behavior with sticky summary mounted.

## 2026-07-29 lifecycle review

Historical review: [immutable record](https://github.com/TokenBrice/pharos-watch/blob/e4e09b34e3b43baadd656471b973c686b34c1c27/docs/process/feature-flags.md#2026-07-29-lifecycle-review). Current acceptance is governed by [approved retirement gates](#2026-10-08-approved-retirement-gates), not that review's inventory or dates.

### `NEXT_PUBLIC_PHAROS_HERO_VERDICT`

- [x] Hero verdict surface (the archetype verdict chip in `HeroChipRail`, `hero-card-sections.tsx`, at every width, plus the `HeroIdentityHeader` heading's `aria-describedby` in `hero-card.tsx`) lands behind the flag via `isHeroVerdictEnabled()`; the hoisted `<AiSummary>` renders unconditionally and is not gated by the flag.
- [x] Default-on W3 launch completed; emergency rollback is `NEXT_PUBLIC_PHAROS_HERO_VERDICT=false`.
- [ ] Top-60 coins by mcap have both `oneLiner` AND a TL;DR-first AI summary. **`src/lib/__tests__/term-markup.test.ts` owns summary term wiring: known glossary slugs and no raw opening/closing markers. One-liner coverage and TL;DR-first top-60 editorial QA require editorial review; the retained curation-digest tests do not enforce authored-catalog coverage.**

### Retired chart annotation overlay

The overlay, its flag/getter, chart legends and exclusive browser Tape reads have been removed. The curated annotation corpus, corpus-integrity tests, review dispositions, deferrals and permanent intake tooling remain. No editor appointment or curation cadence blocks the approved retirement, and candidates never publish automatically. The former GitHub repository Variable is no longer consumed; deleting it is a separately authorized operator action after release.

### 2026-10-08 approved retirement gates

| Temporary controls | Retention / acceptance contract |
| --- | --- |
| Quiet deviations + mobile sticky summary | Keep gated until tokenbrice or a named reviewer accepts the exact build by **2026-11-15**. Quiet review covers USDC, USDe and a real incident in light/dark and narrow/wide home, table, depeg and hero views, including severity/trend boundaries. Sticky review needs iOS Safari and Android Chrome device/browser/SHA receipts for cold hashes, anchors, lazy folds, toolbar collapse, rotation, long text, 200% zoom and genuinely missing price/grade; prove viewport-only observation and height cleanup. Source tests or older enabled builds do not certify device acceptance. |
| DDR + DDRR rollback | Keep both until **30 consecutive deployed rollback-free days** on an accepted semantic baseline, a current DDR snapshot and at least one stored DDRR assessment are evidenced. The [approved historical gate](https://github.com/TokenBrice/pharos-watch/blob/e4e09b34e3b43baadd656471b973c686b34c1c27/docs/process/feature-flags.md#2026-10-08-approved-retirement-gates) sets October 28 as the earliest conditional closure only if September 28 deployment is proven; later deployment, semantic changes or rollback restart the window. Missing, empty, stale and failed reads remain distinct. |

Lifecycle expiry dates are review deadlines, not automatic evidence or removal authority.

After acceptance, remove each flag, getter, alternate branch and matching Pages build input in the same change. Retain permanent `heroVerdict`, shared query infrastructure and backend chronology. The generic inlining/stale guards currently cover the four remaining temporary flags; accepting a valid inventory with no temporary entries is the final shared-checker cutover after all four close, not permission to skip missing-source or lifecycle validation.

### `NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER`

- [x] Runtime DDR snapshot API and `/depeg/` module are wired behind the default-on flag.
- [x] Emergency rollback path is `NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER=false`.
- [ ] Keep at least one current production snapshot available after launch; when absent or stale, the module should degrade to its documented empty/stale state rather than blocking the page.

### `NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER_REVIEWER`

- [x] Runtime-neutral DDRR review logic and schemas validate stored DDR assessments against later `depeg_events`.
- [x] `/api/depeg-resolver-review` is cache-backed, freshness-aware, and returns degraded empty rows before the first snapshot.
- [x] `/depeg/` renders DDRR below DDR, inside the always-displayed `#forecast-grading` section, with Recovery-calls and Duration-calls headline tiles. The DEWS alert feed is embedded in the `DepegOutlookHero` above both.
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
inlining check as applicable.

## Spec source

`src/lib/feature-flags.ts` is the source of truth for flag names, defaults, and `expiresAt`. This page is the durable reference for what each flag gates, its flip-readiness gate, the rollout procedure, and the retention rationale. Build-workflow propagation lives in `.github/workflows/pages-release.yml` (the production deploy workflow calls it for Pages builds).

## 2026-08-23 lifecycle review

Historical deferral: [immutable record](https://github.com/TokenBrice/pharos-watch/blob/e4e09b34e3b43baadd656471b973c686b34c1c27/docs/process/feature-flags.md#2026-08-23-lifecycle-review). Current defaults and review deadlines come from `FEATURE_FLAGS` and `FEATURE_FLAG_LIFECYCLE`; unresolved acceptance stays in [approved retirement gates](#2026-10-08-approved-retirement-gates).
