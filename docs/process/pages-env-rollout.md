# Pages env-var rollout for `NEXT_PUBLIC_PHAROS_*` flags

How to flip the six May 2026 detail-page feature flags on production.

## Where the build actually happens

The Cloudflare Pages project `stablecoin-dashboard` does **not** use Cloudflare's git integration. Builds run inside GitHub Actions (`.github/workflows/pages-prepare.yml` → `npm run build`), and the static `out/` directory is uploaded via `wrangler pages deploy` (`.github/workflows/pages-publish.yml`).

Consequence: **build-time env vars must live in GitHub Actions, not in the Cloudflare Pages dashboard.** The dashboard's "Environment variables" panel is only readable by Pages Functions at runtime, never inlined into the static bundle. Setting flags there has zero effect on the React app.

`src/lib/feature-flags.ts` reads each flag via `process.env.NEXT_PUBLIC_PHAROS_X === "true"`. Next.js inlines that expression at build time **only when** the env var is defined in the build environment. `scripts/ci/check-feature-flag-inlining.mjs` verifies the inlining happened.

## Source of truth: GitHub repo Variables

Set each flag as a **Variable** (plaintext, not a secret — these aren't sensitive) on the repo. Two paths:

### (a) gh CLI

```bash
gh variable set NEXT_PUBLIC_PHAROS_QUIET_DEVIATIONS --body true
gh variable set NEXT_PUBLIC_PHAROS_LAZY_CHARTS --body true
gh variable set NEXT_PUBLIC_PHAROS_CHART_ANNOTATIONS --body true
gh variable set NEXT_PUBLIC_PHAROS_HERO_VERDICT --body true
gh variable set NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER --body true
gh variable set NEXT_PUBLIC_PHAROS_MOBILE_STICKY_SUMMARY --body true

gh variable list   # verify
```

### (b) GitHub UI

Repo → **Settings** → **Secrets and variables** → **Actions** → **Variables** tab → **New repository variable**. Name: `NEXT_PUBLIC_PHAROS_X`. Value: `true` (literal four characters).

## How the variables reach the build

`pages-prepare.yml` threads each `${{ vars.NEXT_PUBLIC_PHAROS_X }}` into the job's `env:` block, alongside `NEXT_PUBLIC_GA_ID`. `validate-ci.yml`'s `pages-build` job mirrors the same block so PR previews use the same flag state.

No code changes required to add or remove a flag — but **if you add a 7th flag**, you must add its line to both workflows or it will silently stay off.

## Recommended sequence

All six flags are code-ready (see `agents/p1-flag-flip-readiness-2026-05-16.md`). Flip one per deploy window so a regression is unambiguous:

1. `QUIET_DEVIATIONS` — visual-only, lowest risk.
2. `LAZY_CHARTS` — measure mobile LCP before/after.
3. `CHART_ANNOTATIONS` — verify dashed lines around March 2023 on USDC's market-cap chart.
4. `HERO_VERDICT` — verdict paragraph appears under the title row, above the AI summary.
5. `BLACKLIST_BANNER` + `MOBILE_STICKY_SUMMARY` — after real-device QA on iOS Safari + Android Chrome.

## Triggering a deploy

Setting / changing a repo Variable does **not** trigger a deploy. The flag flips on the **next** Production build. Three ways to force one:

1. Push a commit to `main`.
2. Re-run the latest successful workflow on `main` from the Actions tab.
3. **Recommended for env-var-only flips:** trigger the `Rebuild Pages` workflow manually:
   ```bash
   gh workflow run "Rebuild Pages" --ref main
   gh run watch  # follow the run
   ```
   It schedules nightly anyway (08:15 UTC) but `workflow_dispatch` makes it on-demand. It re-runs `pages-prepare` → `pages-publish` end-to-end, picking up current Variables.

## Verifying a deploy

After the workflow finishes (`gh run list --workflow="Rebuild Pages" --limit 1`):

1. **Bundle check.** Hard-reload a coin detail page (Cmd/Ctrl+Shift+R to bypass CDN cache). DevTools → Network → grab one `/_next/static/chunks/*.js` filename, then in Console:
   ```js
   fetch('/_next/static/chunks/<filename>').then(r => r.text()).then(t => console.log(t.includes('NEXT_PUBLIC_PHAROS_CHART_ANNOTATIONS')))
   ```
   Expect `false` — the literal name is absent because Next.js inlined the value.
2. **User-facing surface** — visit the relevant page and confirm:
   - `QUIET_DEVIATIONS` → peg-deviation card uses muted calm/warn/severe colors on small deviations.
   - `LAZY_CHARTS` → heavy chart sections delay-mount on scroll (USDC).
   - `MOBILE_STICKY_SUMMARY` → compact bar with logo/symbol/price/grade sticks at the top on mobile after scrolling past the hero.
   - `BLACKLIST_BANNER` → amber "N freezes in the last 7 days" banner above Safety Score on coins with ≥5 freezes or any destroys.
   - `HERO_VERDICT` → italic `oneLiner` paragraph below the title row, above the AI summary.
   - `CHART_ANNOTATIONS` → vertical dashed lines on the USDC market-cap chart around March 2023 (SVB).

## Rollback

```bash
gh variable set NEXT_PUBLIC_PHAROS_X --body false
gh workflow run "Rebuild Pages" --ref main
```

Or delete the variable entirely (`gh variable delete NEXT_PUBLIC_PHAROS_X`) — same effect, the flag returns to its `false` default on the next build.

## Cloudflare Pages dashboard variables — leave them alone

If you previously set `NEXT_PUBLIC_PHAROS_*` in the Cloudflare Pages **Environment variables** panel, they're harmless but useless. Delete them to avoid confusion next time someone goes hunting for "where is this flag set" — the real source of truth is `gh variable list`.

## Common pitfalls

- **Confusing repo Variables with repo Secrets.** These are non-sensitive (`true`/`false`); Variables is the right surface. Secrets get masked and complicate debugging.
- **Setting at the *environment* level instead of repo level.** GitHub also supports per-environment variables (e.g. `production`); `pages-prepare.yml` doesn't currently use a GH environment, so put them at the **repo** level. If you later add a GH environment, mirror the variables there.
- **Forgetting to trigger a deploy.** Pages won't re-build on a Variable change alone.
- **Setting value to `True`/`TRUE`/`yes`/`1`.** The code reads `=== "true"` (lowercase string). Anything else evaluates to `false`.
- **Caching.** Cloudflare CDN can serve cached chunks for ~minutes after a deploy. Hard-reload or wait.
