# Cloudflare Pages env-var rollout for `NEXT_PUBLIC_PHAROS_*` flags

How to flip the six May 2026 detail-page feature flags on the live Pages project (`stablecoin-dashboard`).

## Why a build-time env var

`src/lib/feature-flags.ts` reads each flag via direct `process.env.NEXT_PUBLIC_PHAROS_X === "true"`. Next.js statically replaces that expression at **build** time (verified by `scripts/ci/check-feature-flag-inlining.mjs`). Cloudflare Pages exposes plaintext "Environment variables" under **Settings → Environment variables**, scoped per environment (Production / Preview); setting one causes the value to be inlined on the next build. These are not the same as Pages **secrets** (`wrangler pages secret put`), which are encrypted and only readable by Functions at runtime — secrets cannot satisfy the inlining requirement.

## What to set, when

Order matches `src/lib/feature-flags.ts`. Authoritative gate text is in `docs/process/feature-flags.md`; this column captures current state as of 2026-05-16 — see `agents/p1-flag-flip-readiness-2026-05-16.md` for the per-gate audit.

| Flag | State |
| --- | --- |
| `NEXT_PUBLIC_PHAROS_HERO_VERDICT` | **Ready.** 391/391 oneLiner coverage; 391/391 AI summaries with glossary markers (commit `063e1ef65`). Hero-card-identity verdict tests landed (commit `c1b6ce6db`). |
| `NEXT_PUBLIC_PHAROS_BLACKLIST_BANNER` | **Code ready.** `frozen` suppression in place; the plan's `inactive` reference is moot — `StablecoinStatus` is `pre-launch | active | frozen`. iOS Safari sticky-position real-device pass still recommended before flip. |
| `NEXT_PUBLIC_PHAROS_QUIET_DEVIATIONS` | **Ready.** WCAG AA contrast pairs computed mathematically: all amber/orange/red/green/muted tokens pass against `--background` in light and dark. |
| `NEXT_PUBLIC_PHAROS_MOBILE_STICKY_SUMMARY` | **Code ready.** `applyScrollMargins` ↔ `--pharos-sticky-summary-h` CSS variable wired between `mobile-sticky-summary.tsx:62` and `longform-scrollspy-nav.tsx:119`. Awaits real-device QA (iOS Safari + Android Chrome). |
| `NEXT_PUBLIC_PHAROS_LAZY_CHARTS` | **Code ready.** `LazySection` mounts on `IntersectionObserver` intersection with SSR-safe fallback. Recommended: `npx unlighthouse http://localhost:3000/stablecoin/usdc-circle/ --device mobile` before/after to compare p75 LCP. |
| `NEXT_PUBLIC_PHAROS_CHART_ANNOTATIONS` | **Ready.** 50 coins seeded, 102 events in `shared/data/annotations/curated-annotations.ts`. Cadence skill `/annotations-refresh` + producer `npm run candidates:annotations` cover ongoing curation. |

## How to set

### (a) Wrangler CLI — not supported for this case

Wrangler 4 exposes only `wrangler pages secret put | bulk | delete | list` (encrypted Functions-runtime secrets), with no subcommand for plaintext build-time vars. **Do not** use `wrangler pages secret put` for these flags — it will appear to succeed and silently leave the flag off. Use the dashboard.

### (b) Dashboard (recommended)

1. Cloudflare dashboard → **Workers & Pages** → `stablecoin-dashboard` → **Settings** → **Environment variables**.
2. **Production** tab → **Add variable**. Name: `NEXT_PUBLIC_PHAROS_CHART_ANNOTATIONS` (or whichever flag). Value: the literal string `true`. Type: plaintext. **Save**.
3. Trigger a new deploy — push a commit, or **Deployments → Retry deployment** on the latest production build. Existing deployments still serve the old bundle until the new build promotes.

### (c) Preview-environment override (test first)

Repeat the same steps on the **Preview** tab. Every PR preview deployment from that point inlines the flag on, so you can validate a real Pages bundle before touching Production.

## Rollback

In the same dashboard panel, **Delete** the variable (or set its value to anything other than the string `true`) and trigger a new deploy. The flag returns to its `false` default on the new build. Existing deployments are not mutated — promote the rollback build via **Deployments** if you need it live immediately.

## Verification after each flip

Pick one (option 2 is usually sufficient):

1. **Bundle check.** In DevTools on the deployed page, list a few chunks via `Array.from(document.scripts).map(s => s.src).filter(s => s.includes('/chunks/')).slice(0, 3)`; fetch one and confirm the flag's literal name (e.g. `NEXT_PUBLIC_PHAROS_CHART_ANNOTATIONS`) does **not** appear — that proves inlining still works.
2. **User-facing surface.** Visit the affected page and confirm the gated behavior is visible:
   - `QUIET_DEVIATIONS` — peg-deviation card uses calm/warn/severe colors on a small deviation.
   - `LAZY_CHARTS` — heavy chart sections delay-mount on scroll on USDC.
   - `MOBILE_STICKY_SUMMARY` — compact summary sticks under the scrollspy on mobile.
   - `BLACKLIST_BANNER` — banner appears on a coin with ≥5 freezes in 7 days.
   - `HERO_VERDICT` — `oneLiner` surfaces above the AI summary on top-60 coins.
   - `CHART_ANNOTATIONS` — dashed annotation lines on USDC's market-cap chart (e.g. SVB Mar 2023).

## Recommended sequence

All six flags are code-ready as of 2026-05-16. Stagger one flag per deploy window so a regression can be attributed cleanly:

1. `QUIET_DEVIATIONS` — visual change only; lowest risk.
2. `LAZY_CHARTS` — perf change; measure mobile LCP after.
3. `CHART_ANNOTATIONS` — annotation lines on charts; visual diff easy to verify on USDC.
4. `HERO_VERDICT` — adds the oneLiner verdict paragraph above the AI summary.
5. `BLACKLIST_BANNER` + `MOBILE_STICKY_SUMMARY` — mobile-only surfaces; flip after real-device QA on iOS Safari + Android Chrome.
