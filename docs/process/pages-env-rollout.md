# Pages env-var rollout for `NEXT_PUBLIC_PHAROS_*` flags

How to flip the May 2026 detail-page feature flags on production.

## Where the build actually happens

The Cloudflare Pages project `stablecoin-dashboard` does **not** use Cloudflare's git integration. Builds run inside GitHub Actions. Scheduled/manual Rebuild Pages and production deploys both call `.github/workflows/pages-release.yml`, whose `pages-release` job builds `out/`, smokes the local artifact, and uploads it with `wrangler pages deploy`.

Consequence: **build-time env vars must live in GitHub Actions, not in the Cloudflare Pages dashboard.** The dashboard's "Environment variables" panel is only readable by Pages Functions at runtime, never inlined into the static bundle. Setting flags there has zero effect on the React app.

`src/lib/feature-flags.ts` reads most flags via `process.env.NEXT_PUBLIC_PHAROS_X === "true"`. Three flags are the exception — `NEXT_PUBLIC_PHAROS_HERO_VERDICT`, `NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER`, and `NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER_REVIEWER` are default-on (read via `!== "false"`) and read as enabled unless the build env sets them to the literal string `"false"`. Next.js inlines those expressions at build time. `scripts/ci/check-feature-flag-inlining.mjs` verifies the inlining happened.

## Source of truth: GitHub repo Variables

Set each flag as a **Variable** (plaintext, not a secret — these aren't sensitive) on the repo. Two paths:

### (a) gh CLI

```bash
gh variable set NEXT_PUBLIC_PHAROS_QUIET_DEVIATIONS --body true
gh variable set NEXT_PUBLIC_PHAROS_CHART_ANNOTATIONS --body true
gh variable set NEXT_PUBLIC_PHAROS_HERO_VERDICT --body true
gh variable set NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER --body true
gh variable set NEXT_PUBLIC_PHAROS_MOBILE_STICKY_SUMMARY --body true
gh variable set NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER --body true
gh variable set NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER_REVIEWER --body true

gh variable list   # verify
```

### (b) GitHub UI

Repo → **Settings** → **Secrets and variables** → **Actions** → **Variables** tab → **New repository variable**. Name: `NEXT_PUBLIC_PHAROS_X`. Value: `true` (literal four characters).

For default-on rollbacks (`NEXT_PUBLIC_PHAROS_HERO_VERDICT`, `NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER`, `NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER_REVIEWER`), set the variable to `false` instead of deleting it.

## How the variables reach the build

`pages-release.yml` threads each `${{ vars.NEXT_PUBLIC_PHAROS_X }}` into the job's `env:` block, alongside `NEXT_PUBLIC_GA_ID`. `validate-ci.yml`'s `pages-build` job mirrors the same block so PR validation, scheduled/manual rebuilds, and production deploys inline the same flag state.

Flipping an existing flag only changes the repo Variable. Adding, renaming, or removing a flag is a code change: update `src/lib/feature-flags.ts`, the flag docs/expiry entry, `scripts/ci/check-feature-flag-inlining.mjs` if the inlining assertion needs to recognize it, and every build workflow listed above. Otherwise the flag can silently stay off, or stay on by default, on one deploy path.

## Recommended sequence

All remaining flags are code-ready according to [feature-flags.md](./feature-flags.md) and `src/lib/feature-flags.ts`. Flip one per deploy window so a regression is unambiguous:

1. `QUIET_DEVIATIONS` — visual-only, lowest risk.
2. `CHART_ANNOTATIONS` — verify dashed lines around March 2023 on USDC's market-cap chart.
3. `BLACKLIST_BANNER` + `MOBILE_STICKY_SUMMARY` — after real-device QA on iOS Safari + Android Chrome.

`HERO_VERDICT`, `DEPEG_RESOLVER`, and `DEPEG_RESOLVER_REVIEWER` are already default-on. Keep repo Variables set to `false` only during rollback.

## Triggering a deploy

Setting / changing a repo Variable does **not** trigger a deploy. The flag flips on the **next** Production build. Three ways to force one:

1. Push a commit to `main`.
2. Re-run the latest successful workflow on `main` from the Actions tab.
3. **Recommended for env-var-only flips:** trigger the `Rebuild Pages` workflow manually:
   ```bash
   gh workflow run "Rebuild Pages" --ref main
   gh run watch  # follow the run
   ```
   It is scheduled twice daily at 08:10 and 08:25 UTC (after the 08:05 UTC digest run, with a catch-up slot) but `workflow_dispatch` makes it on-demand. It re-runs the full `pages-release` build/smoke/publish path, picking up current Variables.

## Verifying a deploy

After the workflow finishes (`gh run list --workflow="Rebuild Pages" --limit 1`):

1. **Bundle check.** Hard-reload a coin detail page (Cmd/Ctrl+Shift+R to bypass CDN cache). DevTools → Network → grab one `/_next/static/chunks/*.js` filename, then in Console:
   ```js
   fetch('/_next/static/chunks/<filename>').then(r => r.text()).then(t => console.log(t.includes('NEXT_PUBLIC_PHAROS_CHART_ANNOTATIONS')))
   ```
   Expect `false` — the literal name is absent because Next.js inlined the value.
2. **User-facing surface** — visit the relevant page and confirm:
   - `QUIET_DEVIATIONS` → peg-deviation card uses muted calm/warn/severe colors on small deviations.
   - `MOBILE_STICKY_SUMMARY` → compact bar with logo/symbol/price/grade sticks at the top on mobile after scrolling past the hero.
   - `BLACKLIST_BANNER` → amber "N freezes in the last 7 days" banner above Safety Score on coins with ≥5 freezes or any destroys.
   - `HERO_VERDICT` → archetype label pill (e.g. "Yield-Bearing Hybrid") below the classification line in the hero card; the `oneLiner` paragraph is always shown when populated and is not gated by this flag.
   - `CHART_ANNOTATIONS` → vertical dashed lines on the USDC market-cap chart around March 2023 (SVB).

## Rollback

```bash
gh variable set NEXT_PUBLIC_PHAROS_X --body false
gh workflow run "Rebuild Pages" --ref main
```

For default-off flags, deleting the variable has the same effect as setting `false`: the flag returns to off on the next build. For default-on flags such as `NEXT_PUBLIC_PHAROS_HERO_VERDICT`, `NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER`, and `NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER_REVIEWER`, deletion returns them to the default-on path; rollback requires an explicit false value:

```bash
gh variable set NEXT_PUBLIC_PHAROS_HERO_VERDICT --body false
gh variable set NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER --body false
gh variable set NEXT_PUBLIC_PHAROS_DEPEG_RESOLVER_REVIEWER --body false
gh workflow run "Rebuild Pages" --ref main
```

## Cloudflare Pages dashboard variables — leave them alone

If you previously set `NEXT_PUBLIC_PHAROS_*` in the Cloudflare Pages **Environment variables** panel, they're harmless but useless. Delete them to avoid confusion next time someone goes hunting for "where is this flag set" — the real source of truth is `gh variable list`.

## Common pitfalls

- **Confusing repo Variables with repo Secrets.** These are non-sensitive (`true`/`false`); Variables is the right surface. Secrets get masked and complicate debugging.
- **Setting at the *environment* level instead of repo level.** GitHub also supports per-environment variables (e.g. `production`); `pages-release.yml` doesn't currently use a GH environment, so put them at the **repo** level. If you later add a GH environment, mirror the variables there.
- **Forgetting to trigger a deploy.** Pages won't re-build on a Variable change alone.
- **Setting value to `True`/`TRUE`/`yes`/`1`.** Default-off flags read `=== "true"` (lowercase string). Anything else evaluates to `false`. Hero Verdict, Depeg Resolver, and Depeg Resolver Reviewer read `!== "false"`, so only lowercase `false` disables them.
- **Caching.** Cloudflare CDN can serve cached chunks for ~minutes after a deploy. Hard-reload or wait.
